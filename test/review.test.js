// -----------------------------------------------------------------------------
// The points of review r1, each with a test that fails on the mutant the
// reviewer found surviving: the session clock of the guards (I1), the real
// client on a refused password (I2), and M22, M29, M31, M32, M14, M26, M13,
// M17, M25, m5.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ACTIONS } from '../src/constants.js';
import { OpenemsApp } from '../src/app.js';
import { OpenemsClient } from '../src/openems/client.js';
import { createMemoryStore } from '../src/store.js';
import { testClock } from './kit/clock.mjs';
import { startFakeEdge } from './helpers/fakeEdge.js';
import {
  CONFIG,
  HOUR,
  MINUTE,
  START,
  answer,
  created,
  createLogger,
  fail,
  last,
  setup,
  status,
} from './helpers/app.js';

/** The test clock with a wall clock that NTP can move (`clock.shift(ms)`), the monotonic one not. */
function ntpClock() {
  const base = testClock({ start: START });
  let offset = 0;
  return {
    ...base,
    now: () => base.now() + offset,
    advance: (ms) => base.advance(ms),
    shift(ms) {
      offset += ms;
    },
  };
}

test('I1: the wall clock set 10 h ahead never lets a jump of the counter through', async () => {
  const clock = ntpClock();
  let production = 12_345_678;
  const { app, gladys, advance } = await setup({
    clock,
    devices: [created()],
    script: () => answer({ '_sum/ProductionActiveEnergy': production }),
  });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, 'production_index'), 12345.678);
  clock.shift(10 * HOUR);
  production += 900_000;
  await advance(35_000);
  assert.equal(last(gladys, 'production_index'), 12345.678, 'held, not counted');
  assert.match(status(gladys).message.en, /jumped from 12345.678 to 13245.678/);
  await app.stop();
});

test('I1: the wall clock set 10 min back never holds a normal rise', async () => {
  const clock = ntpClock();
  let production = 12_345_678;
  const config = { ...CONFIG, poll_interval: 300 };
  const { app, gladys, advance } = await setup({
    clock,
    config,
    devices: [created()],
    script: () => answer({ '_sum/ProductionActiveEnergy': production }),
  });
  await app.start(config);
  await app.idle();
  clock.shift(-10 * MINUTE);
  // 10 kW for 5 min: 0.833 kWh.
  production += 833;
  await advance(305_000);
  assert.equal(last(gladys, 'production_index'), 12346.511);
  assert.doesNotMatch(status(gladys).message.en, /held back/);
  await app.stop();
});

test('I1: the margin of the second click runs on the monotonic clock', async () => {
  const clock = ntpClock();
  let consumption = 9_876_543;
  const { app, gladys, advance } = await setup({
    clock,
    devices: [created()],
    script: () => answer({ '_sum/ConsumptionActiveEnergy': consumption }),
  });
  await app.start(CONFIG);
  await app.idle();
  consumption = 1_000;
  await advance(35_000);
  await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  await advance(5_000);
  // The counter rose by 50 kWh since the first click (plausible only over 30 min),
  // and the wall clock jumped 10 h: the second click must not take it.
  consumption = 51_000;
  clock.shift(10 * HOUR);
  await advance(35_000);
  const second = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(second.data.message.en, /Not accepted, the value changed/);
  await app.stop();
});

test('I2: the real client, a refused password: said at once, and the test button says it', async (t) => {
  const edge = await startFakeEdge({ password: 'user' });
  t.after(() => edge.close());
  const gladys = createFakeGladys({ selector: 'openems', config: {} });
  await gladys.connect();
  const app = new OpenemsApp({
    gladys,
    logger: createLogger(),
    store: createMemoryStore(),
    client: new OpenemsClient(),
  });
  // Stopped whatever happens: its timers never keep the test process alive.
  t.after(() => app.stop());
  const config = { address: `127.0.0.1:${edge.port}`, password: 'wrong' };
  const started = performance.now();
  await app.start(config);
  await app.idle();
  assert.ok(performance.now() - started < 3_000, `${performance.now() - started} ms`);
  assert.match(status(gladys).message.en, /refuses the password/);
  app.lastAttemptMono = undefined;
  const message = await app.testConnection();
  assert.match(message.en, /password refused/);
  await app.stop();
});

test('M22: a success of the test button erases the refusal, the reads go on by themselves', async () => {
  let ok = false;
  const { app, gladys, client, advance, store } = await setup({
    script: () => (ok ? answer() : fail('refused')),
  });
  await app.start(CONFIG);
  await app.idle();
  await advance(MINUTE);
  ok = true;
  await gladys.fake.action(ACTIONS.TEST);
  assert.equal(store.data.refusal, null);
  const calls = client.calls.length;
  await advance(35_000);
  assert.equal(client.calls.length, calls + 1);
  await app.stop();
});

test('M29 and M17: no readable host name, nothing goes to the known device', async () => {
  let hostname = 'fems12345';
  let soc = 77;
  const { app, gladys, advance } = await setup({
    devices: [created()],
    script: () => answer({ '_host/Hostname': hostname, '_sum/EssSoc': soc }),
  });
  await app.start(CONFIG);
  await app.idle();
  const before = gladys.fake.states.length;
  assert.ok(before > 0);
  hostname = null;
  soc = 50;
  await advance(35_000);
  assert.equal(last(gladys, 'soc'), 77);
  assert.equal(gladys.fake.states.length, before, 'read without host name: nothing');
  await gladys.fake.deviceUpdated(gladys.fake.devices[0]);
  assert.equal(gladys.fake.states.length, before, 'publishLast: nothing either');
  // m5: the old name is not said to answer.
  assert.doesNotMatch(status(gladys).message.en, /fems12345 answering/);
  assert.match(status(gladys).message.en, /readable host name/);
  await app.stop();
});

test('M31: a second click after 5 min only lists again', async () => {
  let consumption = 9_876_543;
  const { app, gladys, advance } = await setup({
    devices: [created()],
    script: () => answer({ '_sum/ConsumptionActiveEnergy': consumption }),
  });
  await app.start(CONFIG);
  await app.idle();
  consumption = 1_000;
  await advance(35_000);
  await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  await advance(6 * MINUTE);
  const late = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(late.data.message.en, /A second click accepts/);
  await advance(35_000);
  assert.equal(last(gladys, 'consumption_total'), 9876.543);
  await app.stop();
});

test('M32: the instant of the session is in /data before the session ends', async () => {
  let release;
  const store = createMemoryStore();
  const { app } = await setup({
    store,
    script: () => new Promise((resolve) => (release = () => resolve(answer()))),
  });
  await app.start(CONFIG);
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
  assert.ok(store.data.lastAttemptAt >= START, 'written before the answer');
  release();
  await app.stop();
});

test('M14: configurations saved at once are serialized: one timer, the last one read', async () => {
  const clock = testClock({ start: START });
  const store = createMemoryStore({}, { slow: true });
  const { app, client } = await setup({ clock, store });
  await Promise.all([
    app.start({ ...CONFIG, address: '192.168.1.61' }, { fresh: true }),
    app.start({ ...CONFIG, address: '192.168.1.62' }, { fresh: true }),
    app.start({ ...CONFIG, address: '192.168.1.63' }, { fresh: true }),
  ]);
  await app.idle();
  assert.equal(clock.pending, 1, 'one interval timer');
  assert.equal(client.calls.at(-1).credentials.address, '192.168.1.63:8085');
  await app.stop();
  assert.equal(clock.pending, 0);
});

test('M26: a getConfig() answering after a save never wins over it', async () => {
  const { app, client } = await setup({ wire: false });
  let answerConfig;
  const pending = app.connectedVia(
    () => new Promise((resolve) => (answerConfig = () => resolve(CONFIG))),
  );
  await app.start({ ...CONFIG, address: '192.168.1.70' }, { fresh: true });
  answerConfig();
  await pending;
  await app.idle();
  assert.equal(app.config.address, '192.168.1.70:8085');
  assert.ok(client.calls.every((c) => c.credentials.address === '192.168.1.70:8085'));
  await app.stop();
});

test('M13: a read ending after a restart changes nothing kept', async () => {
  let release;
  const store = createMemoryStore();
  const { app } = await setup({
    store,
    script: (n) =>
      n === 1
        ? new Promise((resolve) => (release = () => resolve(answer({ '_host/Hostname': 'late' }))))
        : answer(),
  });
  await app.start(CONFIG);
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
  const stopping = app.stop();
  release();
  await stopping;
  assert.equal(app.kept.info, null);
  assert.equal(store.data.info, null);
});

test('M25: the states per minute: a batch beyond 270 in 60 s waits', async () => {
  const { app, gladys } = await setup();
  const states = (n) =>
    Array.from({ length: n }, (_, i) => ({
      device_feature_external_id: `ext:openems:edge:fems12345:x${i}`,
      state: i,
    }));
  const sent = [];
  gladys.publishChangedStates = async (list) => {
    sent.push(list.length);
    return { count: list.length };
  };
  await app.send(states(200));
  await app.send(states(100));
  assert.deepEqual(sent, [200], 'not sent: 300 > 270');
  await app.send(states(70));
  assert.deepEqual(sent, [200, 70], '270 fits');
});

test('m5: after an accepted drop with nothing else held, no "stays held" line', async () => {
  let consumption = 9_876_543;
  const { app, gladys, advance } = await setup({
    devices: [created()],
    script: () => answer({ '_sum/ConsumptionActiveEnergy': consumption }),
  });
  await app.start(CONFIG);
  await app.idle();
  consumption = 1_000;
  await advance(35_000);
  await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  await advance(5_000);
  const done = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(done.data.message.en, /Accepted/);
  assert.doesNotMatch(done.data.message.en, /stays held/);
  await app.stop();
});

const COUNTER_ID = 'ext:openems:edge:fems12345:production_index';

test('R3 (r2): a /data date in the future is capped at the session clock: the morning rise passes', async () => {
  const clock = ntpClock();
  let production = 12_345_678;
  const store = createMemoryStore({
    counters: {
      [COUNTER_ID]: { guard: { last: { value: 12345.678, at: START + 10 * HOUR }, held: null } },
    },
  });
  const { app, gladys, advance } = await setup({
    clock,
    store,
    devices: [created()],
    script: () => answer({ '_sum/ProductionActiveEnergy': production }),
  });
  await app.start(CONFIG);
  await app.idle();
  await advance(35_000);
  production += 600;
  await advance(35_000);
  assert.equal(last(gladys, 'production_index'), 12346.278);
  await app.stop();
});

test('R4 (r2): a guard loaded after NTP set the wall clock back 10 h keeps +900 kWh held', async () => {
  const clock = ntpClock();
  const store = createMemoryStore({
    counters: {
      [COUNTER_ID]: { guard: { last: { value: 12345.678, at: START - MINUTE }, held: null } },
    },
  });
  const { app, gladys } = await setup({
    clock,
    store,
    devices: [created()],
    script: () => answer({ '_sum/ProductionActiveEnergy': 13_245_678 }),
  });
  // The app is built (session clock anchored), then NTP sets the wall clock back.
  clock.shift(-10 * HOUR);
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, 'production_index'), 12345.678);
  assert.match(status(gladys).message.en, /jumped from 12345.678 to 13245.678/);
  await app.stop();
});

test('m-r2-2: a life whose clock NTP corrected writes wall dates: the next life holds +900 kWh', async () => {
  const clock = ntpClock();
  // Life 1 starts 10 h late (before NTP), then NTP corrects the wall clock.
  clock.shift(-10 * HOUR);
  const store = createMemoryStore();
  let production = 12_345_678;
  const script = () => answer({ '_sum/ProductionActiveEnergy': production });
  const one = await setup({ clock, store, devices: [created()], script });
  await one.app.start(CONFIG);
  await one.app.idle();
  clock.shift(10 * HOUR);
  await one.advance(35_000);
  await one.app.stop();
  // Life 2, right clock, at once: +900 kWh at its first read.
  store.data.lastAttemptAt = 0;
  production += 900_000;
  const two = await setup({ clock, store, devices: [created()], script });
  await two.app.start(CONFIG);
  await two.app.idle();
  assert.notEqual(last(two.gladys, 'production_index'), 13245.678);
  assert.match(status(two.gladys).message.en, /jumped from 12345.678 to 13245.678/);
  await two.app.stop();
});

test('m-r2-3: the wait after a restart is monotonic: a wall clock set back never postpones it', async () => {
  const clock = ntpClock();
  const store = createMemoryStore();
  const one = await setup({ clock, store });
  await one.app.start(CONFIG);
  await one.app.idle();
  await one.app.stop();
  const two = await setup({ clock, store });
  await two.app.start(CONFIG);
  await two.app.idle();
  assert.equal(two.client.calls.length, 0);
  clock.shift(-10 * HOUR);
  await two.advance(MINUTE + 35_000);
  assert.equal(two.client.calls.length, 1);
  await two.app.stop();
});

test('m-r2-4: the version comes from _meta/Version', async () => {
  const { app, gladys } = await setup({
    script: () => answer({ '_meta/Version': '2025.10.3' }, { version: undefined }),
  });
  await app.start(CONFIG);
  await app.idle();
  const [device] = gladys.fake.discoveredDevices;
  assert.deepEqual(
    device.params.find((p) => p.name === 'OPENEMS_VERSION'),
    { name: 'OPENEMS_VERSION', value: '2025.10.3' },
  );
  assert.match(status(gladys).message.en, /OpenEMS 2025\.10\.3/);
  await app.stop();
});

test('R4 (r2): a hold loaded from /data is dated on the session clock, never the wall clock', async () => {
  const clock = ntpClock();
  const held = { direction: 'up', from: 12345.678, to: 13245.678, threshold: 13245.678, at: START };
  const store = createMemoryStore({
    counters: {
      [COUNTER_ID]: { guard: { last: { value: 12345.678, at: START - MINUTE }, held } },
    },
  });
  let production;
  const { app, gladys, advance } = await setup({
    clock,
    store,
    devices: [created()],
    script: () => answer({ '_sum/ProductionActiveEnergy': production ?? null }),
  });
  // Built, then NTP sets the wall clock back 10 h; the hold is loaded after.
  clock.shift(-10 * HOUR);
  await app.start(CONFIG);
  await app.idle();
  // The user accepts the hold as listed (13245.678 kWh)...
  await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  await advance(5_000);
  assert.match((await gladys.fake.action(ACTIONS.ACCEPT_HELD)).data.message.en, /Accepted/);
  // ...then a glitch 900 kWh above it: beyond what may come since, held again.
  production = 14_145_678;
  await advance(35_000);
  assert.notEqual(last(gladys, 'production_index'), 14145.678);
  await app.stop();
});
