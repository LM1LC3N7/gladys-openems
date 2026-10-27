import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNELS,
  hasUsefulValue,
  hostnameOf,
  parseValues,
  versionOf,
} from '../src/openems/model.js';
import { edgeValues } from './helpers/fakeEdge.js';

test('the values: units and signs as read, energies in kWh', () => {
  const v = parseValues(edgeValues());
  assert.equal(v.hostname, 'fems12345');
  assert.equal(v.soc, 77);
  assert.equal(v.essPower, -1500);
  assert.equal(v.gridPower, -320);
  assert.equal(v.productionEnergy, 12345.678);
  assert.equal(v.state, 0);
  assert.equal(v.gridMode, 1);
});

test('strict numbers: a text, null, a boolean, "" are unknown, never 0', () => {
  const v = parseValues(
    edgeValues({
      '_sum/EssSoc': '77',
      '_sum/EssActivePower': '',
      '_sum/GridActivePower': true,
      '_sum/ProductionActiveEnergy': null,
      '_sum/State': 1.5,
      '_sum/GridMode': 0,
      '_sum/ConsumptionActiveEnergy': -5,
    }),
  );
  for (const key of [
    'soc',
    'essPower',
    'gridPower',
    'productionEnergy',
    'state',
    'gridMode',
    'consumptionEnergy',
  ]) {
    assert.equal(v[key], undefined, key);
  }
  assert.equal(parseValues(edgeValues({ '_sum/EssSoc': 101 })).soc, undefined);
});

test('no prototype trick: a key of Object.prototype is no channel', () => {
  const params = Object.assign(Object.create(null), { ['__proto__']: { x: 1 } });
  assert.deepEqual(parseValues(params).soc, undefined);
  assert.equal(hasUsefulValue(params), false);
});

test('the identity: a host name label; the version checked', () => {
  assert.equal(hostnameOf(' FEMS12345 '), 'fems12345');
  for (const bad of ['', 'a b', 'x.y', '../x', 'a:b', 7, null, 'a'.repeat(64)]) {
    assert.equal(hostnameOf(bad), undefined, String(bad));
  }
  assert.equal(versionOf('2026.7.2'), '2026.7.2');
  assert.equal(versionOf('<script>'), undefined);
});

test('alive only on a useful value of _sum', () => {
  assert.equal(hasUsefulValue({ '_host/Hostname': 'x' }), false);
  assert.equal(hasUsefulValue({ [CHANNELS.soc]: 50 }), true);
  assert.equal(hasUsefulValue({ [CHANNELS.soc]: null }), false);
});

test('grid mode 3 (off-grid with genset) is a mode; -1 is not; a small negative power is 0', () => {
  assert.equal(parseValues(edgeValues({ '_sum/GridMode': 3 })).gridMode, 3);
  assert.equal(parseValues(edgeValues({ '_sum/GridMode': -1 })).gridMode, undefined);
  assert.equal(parseValues(edgeValues({ '_sum/ProductionActivePower': -5 })).productionPower, 0);
  assert.equal(
    parseValues(edgeValues({ '_sum/ConsumptionActivePower': -100 })).consumptionPower,
    0,
  );
  assert.equal(
    parseValues(edgeValues({ '_sum/ProductionActivePower': -101 })).productionPower,
    undefined,
  );
  assert.equal(parseValues(edgeValues()).version, '2026.7.2');
});
