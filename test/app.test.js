// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys, a fake client and the test
// clock of the kit (it moves at each read): the device, the values, the pace,
// the refusal, the failures, the identity, the freshness and /data.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS } from '../src/constants.js';
import { OpenemsApp } from '../src/app.js';
import { createMemoryStore } from '../src/store.js';
import { testClock } from './kit/clock.mjs';
import {
  CONFIG,
  DEVICE,
  HOST,
  HOUR,
  MINUTE,
  PASSWORD,
  POLL,
  START,
  answer,
  created,
  createLogger,
  fail,
  last,
  setup,
  status,
} from './helpers/app.js';

test('nothing configured, or a field invalid: the status says so, nothing is read', async () => {
  for (const [config, words] of [
    [{}, /adresse IP du FEMS/],
    [{ address: '192.168.1.60' }, /mot de passe de l’Edge/],
    [{ ...CONFIG, address: 'u:p@x' }, /adresse n’est pas valide/],
    [{ ...CONFIG, address: '255.255.255.255' }, /adresse n’est pas valide/],
    [{ ...CONFIG, password: 'a\nb' }, /mot de passe n’est pas valide/],
  ]) {
    const { app, gladys, client } = await setup({ config });
    await app.start(config);
    await app.idle();
    assert.equal(status(gladys).connected, false);
    assert.match(status(gladys).message.fr, words);
    assert.equal(client.calls.length, 0);
    assert.match(String((await gladys.fake.action(ACTIONS.TEST)).data.message.fr), words);
    await app.stop();
  }
});

test('the first read: the device of the host name in Discovery, no value before it is created', async () => {
  const { app, gladys, client, advance } = await setup();
  await app.start(CONFIG);
  await app.idle();
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].credentials.username, 'x');
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.name, `OpenEMS ${HOST}`);
  assert.deepEqual(
    device.params.find((p) => p.name === 'OPENEMS_VERSION'),
    { name: 'OPENEMS_VERSION', value: '2026.7.2' },
  );
  assert.equal(gladys.fake.states.length, 0);
  assert.equal(status(gladys).connected, true);
  assert.match(status(gladys).message.fr, /Créez son appareil/);
  // Created: the values of the last read at once, without a new request.
  await gladys.fake.deviceCreated(device);
  assert.equal(client.calls.length, 1);
  assert.equal(last(gladys, 'soc'), 77);
  assert.equal(last(gladys, 'battery_power'), -1500);
  assert.equal(last(gladys, 'grid_power'), -320);
  assert.equal(last(gladys, 'production_power'), 4321);
  assert.equal(last(gladys, 'consumption_power'), 2501);
  // The lifetime counters go through their guard at the next read.
  assert.equal(last(gladys, 'production_index'), undefined);
  await advance(35_000);
  assert.equal(client.calls.length, 2);
  assert.equal(last(gladys, 'production_index'), 12345.678);
  assert.equal(last(gladys, 'consumption_total'), 9876.543);
  assert.equal(last(gladys, 'grid_buy_total'), 2000);
  assert.equal(last(gladys, 'grid_sell_total'), 5000);
  assert.equal(last(gladys, 'battery_charge_total'), 3000);
  assert.equal(last(gladys, 'battery_discharge_total'), 2800);
  assert.equal(last(gladys, 'system_state'), 0);
  assert.equal(last(gladys, 'grid_mode'), 1);
  assert.equal(last(gladys, 'production_index_30min'), undefined, 'fed by the core only');
  assert.ok(!gladys.fake.publishedEnergyConsumption.length);
  await app.stop();
});

test('a text, null or 0 is never published as a measure', async () => {
  const { app, gladys } = await setup({
    devices: [created()],
    script: () =>
      answer({
        '_sum/EssSoc': 'n/a',
        '_sum/EssActivePower': null,
        '_sum/GridActivePower': '',
        '_sum/State': 'Ok',
        '_sum/GridMode': 0,
        '_sum/ProductionActiveEnergy': 0,
        '_sum/ConsumptionActiveEnergy': '9876543',
        '_sum/EssDcChargeEnergy': true,
      }),
  });
  await app.start(CONFIG);
  await app.idle();
  for (const key of [
    'soc',
    'battery_power',
    'grid_power',
    'system_state',
    'grid_mode',
    'production_index',
    'consumption_total',
    'battery_charge_total',
  ]) {
    assert.equal(last(gladys, key), undefined, key);
  }
  assert.equal(last(gladys, 'production_power'), 4321);
  await app.stop();
});

test('pace: never a read sooner than the interval, whatever asks', async () => {
  const { app, gladys, client, advance } = await setup({ devices: [created()] });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(client.calls.length, 1);
  // The test button, Discovery, a reconnection, a save of the same form.
  const test1 = await gladys.fake.action(ACTIONS.TEST);
  assert.match(test1.data.message.en, /Not asked now/);
  await gladys.fake.scanRequest();
  await app.connectedVia(async () => CONFIG);
  await app.idle();
  await app.start(CONFIG, { fresh: true });
  await app.idle();
  assert.equal(client.calls.length, 1);
  await advance(20_000);
  assert.equal(client.calls.length, 1);
  await advance(15_000);
  assert.equal(client.calls.length, 2, 'at the interval (the timer looks every 5 s)');
  // The period measured on the test clock: 30 to 35 s.
  for (let i = 0; i < 6; i += 1) await advance(5_000);
  assert.equal(client.calls.length, 3);
  await app.stop();
});

test('a restart of the container waits the interval and the minute after the last session', async () => {
  const store = createMemoryStore();
  const clock = testClock({ start: START });
  const first = await setup({ store, clock });
  await first.app.start(CONFIG);
  await first.app.idle();
  await first.app.stop();
  assert.equal(first.client.calls.length, 1);
  // A new container on the same /data, right after.
  const second = await setup({ store, clock });
  await second.app.start(CONFIG);
  await second.app.idle();
  assert.equal(second.client.calls.length, 0);
  assert.equal(status(second.gladys).connected, true, 'read before: shown connected');
  await second.advance(MINUTE);
  assert.equal(second.client.calls.length, 0);
  await second.advance(POLL + 5_000);
  assert.equal(second.client.calls.length, 1);
  await second.app.stop();
});

test('a new address or a new password is read at once', async () => {
  const { app, client } = await setup();
  await app.start(CONFIG);
  await app.idle();
  await app.start({ ...CONFIG, password: 'other' }, { fresh: true });
  await app.idle();
  await app.start({ ...CONFIG, password: 'other', address: '192.168.1.61' }, { fresh: true });
  await app.idle();
  assert.equal(client.calls.length, 3);
  assert.equal(client.calls[2].credentials.address, '192.168.1.61:8085');
  await app.stop();
});

test('a refused password: a final stop, kept across a restart, one try per click, new fields at once', async () => {
  const store = createMemoryStore();
  const clock = testClock({ start: START });
  let ok = false;
  const script = () => (ok ? answer() : fail('refused'));
  const { app, gladys, client, advance, logger } = await setup({ store, clock, script });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.en, /refuses the password/);
  await advance(6 * HOUR);
  assert.equal(client.calls.length, 1, 'never tried again by itself');
  // A restart keeps the stop.
  await app.stop();
  const again = await setup({ store, clock, script });
  await again.app.start(CONFIG);
  await again.advance(HOUR);
  assert.equal(again.client.calls.length, 0);
  assert.match(status(again.gladys).message.en, /refuses the password/);
  // The test button: one try per click (the interval passed).
  const click = await again.gladys.fake.action(ACTIONS.TEST);
  assert.match(click.data.message.en, /password refused/);
  assert.equal(again.client.calls.length, 1);
  // New fields: tried at once, the stop erased by the success.
  ok = true;
  await again.app.start({ ...CONFIG, password: 'user' }, { fresh: true });
  await again.app.idle();
  assert.equal(again.client.calls.length, 2);
  assert.equal(status(again.gladys).connected, true);
  assert.equal(store.data.refusal, null);
  // Never the password, anywhere.
  const all = JSON.stringify([
    store.data,
    logger.lines,
    again.logger.lines,
    gladys.fake.connectionStatuses,
    again.gladys.fake.connectionStatuses,
  ]);
  assert.ok(!all.includes(PASSWORD));
  await again.app.stop();
});

test('closed, unreachable, no answer, another error: never a refusal, tried again later', async () => {
  for (const code of ['closed', 'unreachable', 'timeout', 'protocol', 'denied']) {
    let n = 0;
    const { app, gladys, client, advance } = await setup({
      script: () => (++n === 1 ? fail(code) : answer()),
    });
    await app.start(CONFIG);
    await app.idle();
    assert.equal(status(gladys).connected, false, code);
    assert.match(status(gladys).message.en, /new try in 1 min/, code);
    await advance(55_000);
    assert.equal(client.calls.length, 1, code);
    await advance(10_000);
    assert.equal(client.calls.length, 2, code);
    assert.equal(status(gladys).connected, true, code);
    await app.stop();
  }
});

test('getConfig() failing in `connected`: retried without end, then the start', async () => {
  const { app, gladys, client, advance } = await setup({ wire: false });
  let n = 0;
  const getConfig = async () => {
    n += 1;
    if (n <= 3) throw new Error('boom');
    return CONFIG;
  };
  await app.connectedVia(getConfig);
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.en, /configuration could not be read.*5 s/);
  await advance(5_000);
  assert.match(status(gladys).message.en, /15 s/);
  await advance(15_000);
  assert.match(status(gladys).message.en, /30 s/);
  assert.equal(client.calls.length, 0);
  await advance(30_000);
  assert.equal(n, 4);
  assert.equal(client.calls.length, 1);
  assert.equal(status(gladys).connected, true);
  await app.stop();
});

test('a lifetime counter: never a drop nor 0 published, held, said, accepted in two clicks', async () => {
  let production = 12_345_678;
  let consumption = 9_876_543;
  const { app, gladys, advance, logger } = await setup({
    devices: [created()],
    script: () =>
      answer({
        '_sum/ProductionActiveEnergy': production,
        '_sum/ConsumptionActiveEnergy': consumption,
      }),
  });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, 'consumption_total'), 9876.543);
  // A replaced meter: the counter drops.
  consumption = 1_000;
  production = 12_346_000;
  await advance(35_000);
  assert.equal(last(gladys, 'consumption_total'), 9876.543, 'the last accepted value again');
  assert.equal(last(gladys, 'production_index'), 12346);
  assert.match(status(gladys).message.en, /house consumption.*dropped from 9876.543 to 1 kWh/);
  assert.ok(logger.lines.some((l) => /consumption counter drop held back/.test(l)));
  // Time never confirms it.
  for (let i = 0; i < 20; i += 1) await advance(35_000);
  assert.equal(last(gladys, 'consumption_total'), 9876.543);
  // Two clicks: the first lists, the second (3 s to 5 min later) accepts.
  const first = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(
    first.data.message.en,
    /house consumption: 9876.543 → 1 kWh \(a reset or a new meter/,
  );
  await advance(1_000);
  const tooSoon = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(tooSoon.data.message.en, /A second click accepts/);
  await advance(5_000);
  const second = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(second.data.message.en, /Accepted: house consumption 1 kWh/);
  consumption = 1_200;
  await advance(35_000);
  assert.equal(last(gladys, 'consumption_total'), 1.2);
  assert.doesNotMatch(status(gladys).message.en, /held back/);
  // 0 is never published.
  consumption = 0;
  await advance(35_000);
  assert.equal(last(gladys, 'consumption_total'), 1.2);
  // A save of the form never accepts.
  production = 99_999_999;
  await advance(35_000);
  assert.equal(last(gladys, 'production_index'), 12346);
  await app.start(CONFIG, { fresh: true });
  await advance(35_000);
  assert.equal(last(gladys, 'production_index'), 12346);
  assert.match(status(gladys).message.en, /production": jumped from 12346 to 99999.999/);
  await app.stop();
});

test('the guard starts from the value Gladys holds: a lower first read is held', async () => {
  const { app, gladys } = await setup({
    devices: [created({ last: { production_index: { value: 20_000, at: START - HOUR } } })],
  });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, 'production_index'), 20_000);
  assert.match(status(gladys).message.en, /dropped from 20000 to 12345.678/);
  await app.stop();
});

test('"Sensor only": no index declared, the production is a plain counter', async () => {
  const config = { ...CONFIG, production_index: 'sensor_only' };
  const { app, gladys } = await setup({ config, devices: [created({ pvIndex: 'sensor_only' })] });
  await app.start(config);
  await app.idle();
  const keys = gladys.fake.discoveredDevices[0].features.map((f) =>
    f.external_id.split(':').at(-1),
  );
  assert.ok(!keys.includes('production_index') && keys.includes('production_total'));
  assert.equal(last(gladys, 'production_total'), 12345.678);
  assert.equal(last(gladys, 'production_index'), undefined);
  await app.stop();
  // A device created with the index keeps it under "Sensor only", without a value.
  const other = await setup({ config, devices: [created()] });
  await other.app.start(config);
  await other.app.idle();
  const kept = other.gladys.fake.discoveredDevices[0].features.map((f) =>
    f.external_id.split(':').at(-1),
  );
  assert.ok(kept.includes('production_index'));
  assert.equal(last(other.gladys, 'production_index'), undefined);
  await other.app.stop();
});

test('back from "Sensor only": the first production index value is held', async () => {
  const store = createMemoryStore();
  let production = 12_345_678;
  const script = () => answer({ '_sum/ProductionActiveEnergy': production });
  const { app, gladys, advance } = await setup({ store, devices: [created()], script });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, 'production_index'), 12345.678);
  await app.start({ ...CONFIG, production_index: 'sensor_only' }, { fresh: true });
  production = 12_400_000;
  await advance(HOUR);
  await app.start(CONFIG, { fresh: true });
  await advance(35_000);
  assert.equal(last(gladys, 'production_index'), 12345.678);
  assert.match(status(gladys).message.en, /jumped from 12345.678 to 12400/);
  await app.stop();
});

test('no readable host name: nothing published, said; another host name gets its own device', async () => {
  let hostname = null;
  const { app, gladys, advance } = await setup({
    devices: [created()],
    script: () => answer({ '_host/Hostname': hostname }),
  });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(gladys.fake.states.length, 0);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  hostname = HOST;
  await advance(35_000);
  assert.equal(last(gladys, 'soc'), 77);
  hostname = 'fems99999';
  const before = gladys.fake.states.length;
  await advance(35_000);
  assert.equal(gladys.fake.states.length, before, 'nothing to the old device');
  assert.equal(gladys.fake.discoveredDevices[0].external_id, `ext:openems:edge:fems99999`);
  assert.match(status(gladys).message.en, /Another host name answers/);
  await app.stop();
});

test('a role above guest is said: the guest is enough', async () => {
  const { app, gladys } = await setup({ script: () => answer({}, { role: 'owner' }) });
  await app.start(CONFIG);
  await app.idle();
  assert.match(status(gladys).message.en, /logs in as owner: the read-only guest is enough/);
  await app.stop();
});

test('a read that ends after a stop or a new configuration publishes nothing, sets no status', async () => {
  let release;
  const { app, gladys, client } = await setup({
    devices: [created()],
    script: (n) =>
      n === 1 ? new Promise((resolve) => (release = () => resolve(answer()))) : answer(),
  });
  await app.start(CONFIG);
  await new Promise((resolve) => setImmediate(resolve));
  const statuses = gladys.fake.connectionStatuses.length;
  const stopping = app.stop();
  assert.equal(client.aborts, 1, 'the stop cuts the session');
  release();
  await stopping;
  assert.equal(gladys.fake.states.length, 0);
  assert.equal(gladys.fake.connectionStatuses.length, statuses);
});

test('configurations saved back to back apply one by one, the last one wins', async () => {
  const { app, client, gladys } = await setup();
  await Promise.all([
    app.start({ ...CONFIG, address: '192.168.1.61' }, { fresh: true }),
    app.start({ ...CONFIG, address: '192.168.1.62' }, { fresh: true }),
    app.start({ ...CONFIG, address: '192.168.1.63' }, { fresh: true }),
  ]);
  await app.idle();
  assert.equal(app.config.address, '192.168.1.63:8085');
  assert.equal(client.calls.at(-1).credentials.address, '192.168.1.63:8085');
  assert.match(status(gladys).message.en, /fems12345 answering/);
  await app.stop();
});

test('nothing stale at device creation or at a reconnection', async () => {
  const { app, gladys, advance } = await setup({
    script: (n) => (n === 1 ? answer() : fail('unreachable')),
  });
  await app.start(CONFIG);
  await app.idle();
  await advance(2 * MINUTE + 5_000);
  // The last good read is older than two intervals: not sent as current.
  await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
  assert.equal(gladys.fake.states.length, 0);
  await app.connectedVia(async () => CONFIG);
  await app.idle();
  assert.equal(gladys.fake.states.length, 0);
  await app.stop();
});

test('/data unreadable: never written over, no counter sent, the other values are, said', async () => {
  const store = createMemoryStore({ keep: 'me' }, { unreadable: true });
  const { app, gladys } = await setup({ store, devices: [created()] });
  await app.start(CONFIG);
  await app.idle();
  assert.deepEqual(store.data, { keep: 'me' });
  assert.equal(store.saves, 0);
  assert.equal(last(gladys, 'soc'), 77);
  assert.equal(last(gladys, 'production_index'), undefined);
  assert.equal(last(gladys, 'consumption_total'), undefined);
  assert.match(status(gladys).message.en, /cannot be read/);
  await app.stop();
});

test('/data that cannot be written: no counter sent meanwhile, said; sent again once it can', async () => {
  const store = createMemoryStore({}, { failSave: true });
  const { app, gladys, advance } = await setup({ store, devices: [created()] });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, 'soc'), 77);
  assert.equal(last(gladys, 'production_index'), undefined);
  assert.match(status(gladys).message.en, /cannot be written/);
  store.failSave = false;
  await advance(35_000);
  assert.equal(last(gladys, 'production_index'), 12345.678);
  assert.doesNotMatch(status(gladys).message.en, /cannot be written/);
  await app.stop();
});

test('the states per minute stay under the core limit', async () => {
  const { app, gladys, advance } = await setup({ devices: [created()] });
  await app.start(CONFIG);
  for (let i = 0; i < 40; i += 1) await advance(5_000);
  const posts = gladys.fake.requests.filter((r) => r.path === '/state' && r.method === 'POST');
  assert.ok(posts.length > 0);
  await app.stop();
});

test('the app takes the real clocks by default (smoke)', () => {
  const app = new OpenemsApp({
    gladys: { devices: [] },
    logger: createLogger(),
    store: createMemoryStore(),
  });
  assert.equal(typeof app.now(), 'number');
  assert.equal(typeof app.monotonic(), 'number');
});
