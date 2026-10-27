// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. And the device
// only uses the units the core accepts for its categories.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  ACTIONS,
  POLL_DEFAULT,
  POLL_MAX,
  POLL_MIN,
  PV_ENERGY_MONITORING,
  PV_SENSOR_ONLY,
} from '../src/constants.js';
import { CATALOG, COUNTERS, buildDevice } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      yield* texts(item, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

test('the store basics; the same version everywhere (semver, never pinned by hand)', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-openems:${manifest.version}`);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.name, 'gladys-openems');
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^/);
  assert.match(pkg.dependencies.ws, /^\^8\./);
  assert.deepEqual(manifest.categories, ['energy']);
  assert.deepEqual(manifest.transports, ['local']);
  assert.equal(manifest.network_discovery, undefined, 'no network scan');
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /Non officiel/);
});

test('the docs say it was never tested with a real device', () => {
  assert.match(read('docs/fr.md'), /[Jj]amais\s+testé\s+avec\s+un\s+vrai\s+appareil/);
  assert.match(read('docs/en.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+device/);
  assert.match(read('README.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+device/);
});

test('every text is in English and French; placeholders and option labels too', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
      assert.equal(typeof text[lang], 'string', `${path}.${lang}`);
    }
  }
  for (const field of manifest.config_schema) {
    if ('placeholder' in field) {
      assert.equal(typeof field.placeholder, 'object', `${field.key}.placeholder`);
    }
    for (const option of field.options ?? []) {
      assert.equal(typeof option.value, 'string');
      for (const lang of ['en', 'fr']) assert.equal(typeof option.label[lang], 'string');
    }
  }
});

test('the configuration matches the code; the secret is described as kept, never shown', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(fields), [
    'intro',
    'address',
    'username',
    'password',
    'production_index',
    'poll_interval',
  ]);
  for (const key of Object.keys(fields)) assert.doesNotMatch(key, /^gladys_/);
  assert.deepEqual(
    fields.production_index.options.map((o) => o.value),
    [PV_ENERGY_MONITORING, PV_SENSOR_ONLY],
  );
  assert.equal(fields.production_index.default, PV_ENERGY_MONITORING);
  assert.match(fields.production_index.description.en, /counted twice.*before creating the device/);
  assert.equal(fields.username.default, 'x');
  assert.equal(fields.password.type, 'secret');
  assert.equal(fields.password.default, undefined, 'never a default on a secret');
  assert.match(fields.password.description.en, /Kept by Gladys in its database, never shown again/);
  assert.match(fields.password.description.fr, /Gardé par Gladys dans sa base, jamais réaffiché/);
  for (const field of manifest.config_schema) {
    if (field.type === 'secret') assert.equal('default' in field, false, field.key);
  }
  assert.equal(fields.poll_interval.default, POLL_DEFAULT);
  assert.equal(fields.poll_interval.min, POLL_MIN);
  assert.equal(fields.poll_interval.max, POLL_MAX);
  for (const link of fields.intro.links) {
    assert.match(link.url, /^https:\/\//);
  }
  assert.match(fields.intro.description.en, /Never tested with a real device/);
  assert.match(fields.intro.description.en, /portal is never contacted/);
});

test('the actions of the manifest are the handlers of the code; read-only', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(ACTIONS),
  );
  assert.ok(handlers.includes('onAction(ACTIONS.TEST'));
  assert.ok(handlers.includes('onAction(ACTIONS.ACCEPT_HELD'));
  assert.ok(handlers.includes("on('connected'"));
  assert.ok(!handlers.includes('onSetValue'), 'no command: read-only');
  assert.ok(!read('index.js').includes('onSetValue'));
  assert.match(manifest.actions[1].description.en, /First click: lists.*Second click/);
});

test('the licenses ship in the image; no name in LICENSE', () => {
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /ha_openems/);
  assert.match(notices, /Apache License/);
  assert.match(notices, /ws/);
});

test('the code never feeds the energy consumption endpoint, nor publishes a scene event', () => {
  for (const file of ['index.js', 'src/app.js', 'src/devices.js', 'src/handlers.js']) {
    assert.doesNotMatch(read(file), /publishEnergyConsumption\(|publishSceneEvent\(/, file);
  }
});

// The units the core accepts per category (server/utils/constants.js
// DEVICE_FEATURE_UNITS_BY_CATEGORY), for the categories used here.
const UNITS_BY_CATEGORY = {
  [C.BATTERY_STORAGE]: [U.PERCENT, U.WATT, U.KILOWATT, U.WATT_HOUR, U.KILOWATT_HOUR],
  [C.ENERGY_PRODUCTION_SENSOR]: [U.WATT, U.KILOWATT, U.WATT_HOUR, U.KILOWATT_HOUR],
  [C.UNKNOWN]: [],
};

test('every feature uses a unit the core accepts for its category; keys unique; read-only', () => {
  const gladys = createFakeGladys({ selector: 'openems' });
  const info = { hostname: 'fems12345', address: 'x:8085' };
  const index = buildDevice(gladys, info);
  const sensor = buildDevice(gladys, info, { pvIndex: PV_SENSOR_ONLY });
  const ext = (d) => d.features.map((f) => f.external_id.split(':').at(-1));
  assert.ok(ext(index).includes('production_index') && !ext(index).includes('production_total'));
  assert.ok(!ext(sensor).includes('production_index') && ext(sensor).includes('production_total'));
  // A device created with the index keeps it under "Sensor only" (no feature lost).
  const kept = buildDevice(gladys, info, { pvIndex: PV_SENSOR_ONLY, created: index });
  assert.ok(ext(kept).includes('production_index') && ext(kept).includes('production_index_30min'));
  assert.equal(index.external_id, 'ext:openems:edge:fems12345');
  const parent = index.features.find((f) => f.external_id.endsWith(':production_index'));
  const child = index.features.find((f) => f.external_id.endsWith(':production_index_30min'));
  assert.equal(child.energy_parent_id, parent.id);
  const keys = new Set();
  for (const f of index.features) {
    assert.ok(f.category in UNITS_BY_CATEGORY, `${f.external_id}: ${f.category}`);
    if (f.unit !== undefined) {
      assert.ok(UNITS_BY_CATEGORY[f.category].includes(f.unit), `${f.external_id}: ${f.unit}`);
    } else {
      assert.equal(f.category, C.UNKNOWN, `${f.external_id}: a unit for its category`);
    }
    assert.equal(f.read_only, true, f.external_id);
    assert.notEqual(f.type, TYPES.SWITCH?.BINARY, 'never a switch');
    assert.ok(!keys.has(f.external_id));
    keys.add(f.external_id);
  }
});

test('no double count with the main meter: the production index is the only index', () => {
  const indexTypes = new Set([
    TYPES.ENERGY_SENSOR.INDEX,
    TYPES.ENERGY_PRODUCTION_SENSOR.INDEX,
    TYPES.GRID_SENSOR.INPUT_INDEX,
    TYPES.GRID_SENSOR.OUTPUT_INDEX,
    TYPES.HOME_OUTPUT_SENSOR.INDEX,
    TYPES.BATTERY_STORAGE.CHARGE_INDEX,
    TYPES.BATTERY_STORAGE.DISCHARGE_INDEX,
  ]);
  const indexes = CATALOG.filter(
    (e) => e.spec.category !== C.UNKNOWN && indexTypes.has(e.spec.type),
  );
  assert.deepEqual(
    indexes.map((e) => e.key),
    ['production_index'],
  );
  for (const key of [
    'consumption_total',
    'grid_buy_total',
    'grid_sell_total',
    'battery_power',
    'grid_power',
  ]) {
    assert.equal(CATALOG.find((e) => e.key === key).spec.category, C.UNKNOWN, key);
  }
  assert.ok(!CATALOG.some((e) => e.spec.category === C.ENERGY_SENSOR));
  assert.ok(!CATALOG.some((e) => e.spec.category === C.GRID_SENSOR));
  assert.ok(!CATALOG.some((e) => /daily/.test(e.spec.type)));
  // Every lifetime counter is guarded.
  for (const { key } of COUNTERS)
    assert.ok(
      CATALOG.some((e) => e.key === key),
      key,
    );
});
