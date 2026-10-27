// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout), the
// real client and a fake OpenEMS Edge on 127.0.0.1 (a real WebSocket server):
// the reads really start at the interval, measured on the method that
// decides, one connection at a time. The time is sped up 20 times (30 s of
// the interval are 1.5 s), but it is the real clock: it moves between any two
// reads of it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { OpenemsApp } from '../src/app.js';
import { OpenemsClient } from '../src/openems/client.js';
import { createMemoryStore } from '../src/store.js';
import { measurePeriod, realClock, spyOn } from './kit/clock.mjs';
import { startFakeEdge } from './helpers/fakeEdge.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

test('real clock x20: reads at 0, the interval, twice the interval; one connection at a time', async (t) => {
  const edge = await startFakeEdge({ latencyMs: 5 });
  t.after(() => edge.close());
  const clock = realClock({ speed: 20 });
  t.after(() => clock.close());
  const gladys = createFakeGladys({ selector: 'openems', config: {} });
  await gladys.connect();
  const app = new OpenemsApp({
    gladys,
    logger: quiet,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
    client: new OpenemsClient(),
  });
  // `read` dates a read once it is decided (its requests follow).
  const spy = spyOn(app, 'read', clock);
  let gaps;
  try {
    await app.start({ address: `127.0.0.1:${edge.port}`, password: 'user' });
    gaps = await measurePeriod(spy, { count: 3, period: 30_000, timeoutMs: 15_000 });
  } finally {
    await app.stop();
    await app.idle();
  }
  assert.equal(gaps.length, 2);
  assert.ok(clock.timersSet < 200, `${clock.timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(edge.record.maxOpen, 1);
  // The third read may be cut by the stop before its log-in.
  assert.ok(edge.record.logins >= 2 && edge.record.logins <= 3, `${edge.record.logins}`);
});
