// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a fake client (the client itself is
// tested against a fake Edge on 127.0.0.1 in test/client.test.js) and the
// test clock of the kit: every read of the clock moves it (1 µs), timers fire
// on `clock.advance(ms)`.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { OpenemsApp } from '../../src/app.js';
import { buildDevice } from '../../src/devices.js';
import { registerHandlers } from '../../src/handlers.js';
import { OpenemsError } from '../../src/openems/client.js';
import { createMemoryStore } from '../../src/store.js';
import { testClock } from '../kit/clock.mjs';
import { edgeValues } from './fakeEdge.js';

export const SELECTOR = 'openems';
export const HOST = 'fems12345';
export const DEVICE = `ext:${SELECTOR}:edge:${HOST}`;
export const F = (key) => `${DEVICE}:${key}`;
export const PASSWORD = 'Sup3r-S3cret!';
export const CONFIG = { address: '192.168.1.60', username: 'x', password: PASSWORD };
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const POLL = 30 * SECOND;
/** 2026-10-24 10:00 UTC. */
export const START = Date.UTC(2026, 9, 24, 10, 0);

export function createLogger() {
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  return { lines, info: log, warn: log, error: log, debug: log };
}

/** A read answer: the Edge of the log-in and the values (Wh for the energies). */
export const answer = (values = {}, edge = {}) => ({
  edge: { id: '0', version: '2026.7.2', role: 'guest', ...edge },
  params: edgeValues(values),
});

/** A fake client: `script(n, call)` gives each answer (or throws an OpenemsError). */
export function createClient(script) {
  const calls = [];
  const client = {
    calls,
    aborts: 0,
    async read(credentials) {
      calls.push({ credentials });
      return script(calls.length, { credentials });
    },
    abort() {
      client.aborts += 1;
    },
  };
  return client;
}

export const fail = (code) => {
  throw new OpenemsError(code);
};

/** The device as the user created it from the discovered one. */
export function created({ pvIndex, last = {} } = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const device = buildDevice(gladys, { hostname: HOST, address: 'x' }, { pvIndex });
  for (const [key, { value, at }] of Object.entries(last)) {
    const feature = device.features.find((f) => f.external_id === F(key));
    feature.last_value = value;
    feature.last_value_changed = new Date(at).toISOString();
  }
  return device;
}

export async function setup({
  config = CONFIG,
  script = () => answer(),
  devices = [],
  store = createMemoryStore(),
  clock = testClock({ start: START }),
  wire = true,
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  await gladys.connect();
  const logger = createLogger();
  const client = createClient((n, call) => script(n, call, clock));
  const app = new OpenemsApp({
    gladys,
    logger,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
    client,
  });
  if (wire) registerHandlers(gladys, app, logger);
  /** `ms` later (timers fired on the way), every read done. */
  const advance = async (ms = POLL) => {
    await clock.advance(ms);
    await app.idle();
  };
  return { app, gladys, clock, logger, client, advance, store };
}

export const status = (gladys) => gladys.fake.connectionStatus;
export const last = (gladys, key) => gladys.fake.lastState(F(key));
export const text = (message) => `${message?.en} ${message?.fr}`;
