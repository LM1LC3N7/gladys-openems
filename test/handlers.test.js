// -----------------------------------------------------------------------------
// The wiring of the container (src/handlers.js): `connected` asks the
// configuration again and again while getConfig() fails, then starts; a save
// restarts; a disconnection stops. Read-only: no command handler.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHandlers } from '../src/handlers.js';
import { ACTIONS } from '../src/constants.js';

function stubGladys(getConfig) {
  const gladys = new EventEmitter();
  gladys.handlers = {};
  for (const name of ['onScanRequest', 'onDeviceCreated', 'onDeviceUpdated', 'onConfigUpdated']) {
    gladys[name] = (fn) => {
      gladys.handlers[name] = fn;
    };
  }
  gladys.actions = {};
  gladys.onAction = (key, fn) => {
    gladys.actions[key] = fn;
  };
  gladys.getConfig = getConfig;
  return gladys;
}

test('connected: getConfig() failing once is asked again, then the start', async () => {
  let n = 0;
  const gladys = stubGladys(async () => {
    n += 1;
    if (n === 1) throw new Error('down');
    return { address: '192.168.1.60' };
  });
  const calls = [];
  const app = {
    // As src/app.js: a failure schedules a new try (here at once).
    async connectedVia(getConfig) {
      try {
        calls.push(['start', await getConfig()]);
      } catch {
        calls.push(['retry']);
        await this.connectedVia(getConfig);
      }
    },
    start: (config, options) => calls.push(['save', config, options]),
    stop: async () => calls.push(['stop']),
  };
  registerHandlers(gladys, app, { info() {}, error() {} });
  gladys.emit('connected');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [['retry'], ['start', { address: '192.168.1.60' }]]);
  await gladys.handlers.onConfigUpdated({ address: 'x' });
  assert.deepEqual(calls.at(-1), ['save', { address: 'x' }, { fresh: true }]);
  gladys.emit('disconnected');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), ['stop']);
  assert.deepEqual(Object.keys(gladys.actions), [ACTIONS.TEST, ACTIONS.ACCEPT_HELD]);
  assert.equal(gladys.onSetValue, undefined);
});
