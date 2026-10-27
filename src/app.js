// -----------------------------------------------------------------------------
// The integration itself: the OpenEMS Edge of the configuration (address,
// user name, password), read every 30 s by default in one JSON-RPC session
// (log-in, subscription, first values, close), its device, the lifetime
// counters checked by their guards, the refusal of the password kept in
// /data, the test and accept buttons. index.js and src/handlers.js only wire
// the SDK handlers to it.
//
// READ-ONLY: only the requests of src/openems/client.js (log-in and
// subscriptions); nothing of the Edge is ever set (no onSetValue at all).
//
// Pace: nothing reads the Edge faster than the interval: not the timer, not
// the test button, not Discovery, not a (re)connection to Gladys, not a save
// of an unchanged configuration, not a restart of the container (the instant
// of the last session is kept in /data, written at most once a minute). A new
// address or new log-in fields may be read at once. One session at a time,
// whatever asks (a read running is never doubled); a stop cuts it.
//
// Password refused (the OpenEMS error 1003): a FINAL stop kept in /data,
// never tried again by itself; only a change of the form, or a click on the
// test button (one try per click, never faster than the interval), tries
// again; the refusal is erased only by a successful log-in. Any other failure
// (closed, no answer, another error) is no refusal: tried again later.
//
// A read belongs to its generation (each start/stop opens a new one): a read
// that ends after a restart or a new configuration publishes nothing and sets
// no status. Identity: every read asks the host name in the session; the
// values only go to the device of that host name (none readable: nothing
// published).
//
// Clocks: `monotonic` paces the reads, so that a wall clock set back never
// stops them. The guards of the counters run on the SESSION clock: the wall
// clock read once at the start of the process plus the monotonic time since
// (`sessionNow`), so that NTP moving the wall clock by hours never widens nor
// narrows their margin (review r1, I1; lesson of gladys-p1-monitor). The wall
// clock itself only dates what /data keeps for a restart. Each decision reads
// each clock once.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import {
  ACCEPT_CONFIRM_AFTER,
  ACCEPT_CONFIRM_WITHIN,
  ATTEMPT_SAVE_EVERY,
  CONFIG_RETRY,
  COUNTER_LIMITS,
  FRESH_INTERVALS,
  PV_SENSOR_ONLY,
  RETRY_MAX,
  RETRY_MIN,
  STATE_HEARTBEAT,
  STATES_PER_MINUTE,
  TEST_ANSWER_WITHIN,
  TICK,
} from './constants.js';
import { COUNTERS, FEATURE, buildDevice, ids, readStates, round } from './devices.js';
import { IndexGuard } from './guard.js';
import { T } from './i18n.js';
import { OpenemsClient } from './openems/client.js';
import { parseValues } from './openems/model.js';
import { createFileStore, fingerprint, readState } from './store.js';

const defaultTimers = { setTimeout, clearTimeout, setInterval, clearInterval };

const MINUTE = 60_000;

/** The value Gladys already holds for a feature of the created device, when it says so. */
function lastValueOf(device, featureId) {
  const feature = (device?.features ?? []).find((f) => f.external_id === featureId);
  const raw = feature?.last_value;
  // Strict: null, '' and a boolean are unknown, never 0 nor 1.
  if (!(typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== ''))) {
    return undefined;
  }
  const value = Number(raw);
  const at = Date.parse(feature?.last_value_changed ?? '');
  return Number.isFinite(value) && value > 0 && Number.isFinite(at) ? { value, at } : undefined;
}

/** A memory-only digest of the log-in fields (never written anywhere). */
const digestOf = ({ address, username, password }) =>
  createHash('sha256')
    .update([address, username, password].map(String).join('\u0000'))
    .digest('hex');

export class OpenemsApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'openems' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    client,
    store = createFileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    /** The session clock: wall at the start of the process + monotonic elapsed since. */
    this.wallStart = now();
    this.monoStart = monotonic();
    this.client = client ?? new OpenemsClient();
    this.store = store;
    this.loadStore();
    this.savedKey = undefined;
    this.config = normalizeConfig();
    /** The digest of the log-in fields of the last start (memory only). */
    this.knownDigest = undefined;
    /** Monotonic time of the last session started, in this process. */
    this.lastAttemptMono = undefined;
    /** Unreachable / odd answer: failures in a row, the monotonic time of the next try. */
    this.failures = 0;
    this.retryAtMono = 0;
    this.lastError = undefined;
    /** The values of the last good read, its monotonic and wall times, the Edge of its log-in. */
    this.values = undefined;
    this.valuesAt = undefined;
    this.readAt = undefined;
    this.edge = undefined;
    this.noHostname = false;
    this.otherHost = false;
    this.saveFailed = false;
    /** An Edge read once (now or before the restart): its device is in Discovery. */
    this.known = Boolean(this.kept.info);
    /** By counter feature external id: IndexGuard. */
    this.guards = new Map();
    /** The first click of "Accept the held counter": `{ at, listedAt, list }`, in memory only. */
    this.pendingAccept = undefined;
    this.publishedDevices = undefined;
    /** The states sent in the last minute: `[{ at, count }]`, monotonic (STATES_PER_MINUTE). */
    this.sent = [];
    /** By counter feature external id: the hold last logged (`direction:from`). */
    this.loggedHolds = new Map();
    this.timer = undefined;
    this.busy = undefined;
    this.firstRun = Promise.resolve();
    this.lastStatus = undefined;
    this.generation = 0;
    this.lifecycle = Promise.resolve();
    /** getConfig() in `connected`: the attempt running, its failures, its timer. */
    this.configAttempt = 0;
    this.configFailures = 0;
    this.configTimer = undefined;
  }

  /** The session clock (ms since epoch): never moved by a wall clock set by NTP. */
  sessionNow() {
    return this.wallStart + (this.monotonic() - this.monoStart);
  }

  /**
   * Reads /data. A file that cannot be read is never taken as empty: nothing
   * is written over it (saveState) and no counter is published until a later
   * start reads it.
   */
  loadStore() {
    const loaded = this.store.load();
    this.storeUnreadable = Boolean(loaded?.unreadable);
    if (this.storeUnreadable) {
      this.logger.warn('OpenEMS: the state file in /data cannot be read: left as it is');
    }
    /** What /data keeps (src/store.js readState). */
    this.kept = readState(loaded?.data, this.now());
    /** The instant of the last session as written in /data (written at most once a minute). */
    this.savedAttemptAt = this.kept.lastAttemptAt;
    /**
     * After a restart of the container: the first read waits the interval
     * and the minute the last session may have come after the one written.
     */
    // Turned into a monotonic instant at once (review r2, m-r2-3): a wall
    // clock set back during the wait never postpones the first read.
    this.restartedAt =
      this.kept.lastAttemptAt > 0
        ? this.monotonic() - Math.max(0, this.now() - this.kept.lastAttemptAt)
        : 0;
  }

  /**
   * Wall minus session clock, now: /data keeps the dates of the guards on the
   * wall clock of the moment they are written, so that a life started before
   * NTP set the clock (session clock hours behind) never leaves dates that
   * widen the margin of the next life (review r2, m-r2-2).
   */
  wallOffset() {
    return this.now() - this.sessionNow();
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * `connected` (the first connection and each reconnection): the
   * configuration asked from Gladys, again and again while it fails (5 s,
   * 15 s, 30 s, then every minute, without end), then a start.
   */
  async connectedVia(getConfig) {
    this.cancelConfigRetry();
    const attempt = ++this.configAttempt;
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (attempt !== this.configAttempt) return;
      const wait = CONFIG_RETRY[Math.min(this.configFailures, CONFIG_RETRY.length - 1)];
      this.configFailures += 1;
      this.logger.warn(
        `OpenEMS: reading the configuration from Gladys failed (${err?.name ?? 'Error'}); again in ${Math.round(wait / 1000)} s`,
      );
      this.lastStatus = undefined;
      await this.setStatus(false, T.configRetry(wait));
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        if (attempt === this.configAttempt) {
          this.connectedVia(getConfig).catch((e) =>
            this.logger.error(`OpenEMS: start failed (${e?.name ?? 'Error'})`),
          );
        }
      }, wait);
      return;
    }
    if (attempt !== this.configAttempt) return;
    this.configFailures = 0;
    await this.start(raw);
  }

  cancelConfigRetry() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  /** `fresh`: the user saved the form (not a reconnection). It accepts no counter held back. */
  start(raw = {}, { fresh = false } = {}) {
    if (fresh) {
      // A save wins over a getConfig() still being retried.
      this.configAttempt += 1;
      this.cancelConfigRetry();
    }
    return this.serialize(() => this.doStart(raw, { fresh }));
  }

  stop() {
    this.configAttempt += 1;
    this.cancelConfigRetry();
    return this.serialize(() => this.doStop());
  }

  /** Resolves once every queued start/stop and the read after it are done (tests). */
  async idle() {
    await this.lifecycle;
    await this.firstRun;
    await this.busy;
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  /** The log-in fields of the configuration (with the address), or undefined. */
  credentials() {
    const { address, host, port, username, password, problem } = this.config;
    return problem ? undefined : { address, host, port, username, password };
  }

  async doStart(raw, { fresh = false } = {}) {
    await this.doStop();
    const generation = ++this.generation;
    if (this.storeUnreadable) {
      // Read again: maybe readable now (never taken as empty meanwhile).
      this.loadStore();
      this.known = Boolean(this.kept.info);
      this.guards.clear();
    }
    this.config = normalizeConfig(raw);
    const { address } = this.config;
    let changed = false;
    if (address && address !== this.kept.address) {
      // Another address: its pace and refusal start afresh (the device and
      // its counters stay: they belong to the host name of the Edge).
      Object.assign(this.kept, { address, lastAttemptAt: 0, refusal: null });
      this.savedAttemptAt = 0;
      this.restartedAt = 0;
      this.forgetPace();
      this.values = undefined;
      changed = true;
    }
    const credentials = this.credentials();
    if (credentials) {
      const digest = digestOf(credentials);
      const fp = fingerprint(this.kept.salt, address, credentials);
      const stopFp = this.kept.refusal?.fp;
      const other =
        this.knownDigest !== undefined
          ? this.knownDigest !== digest
          : stopFp !== undefined && stopFp !== fp;
      this.knownDigest = digest;
      if (other) {
        // New log-in fields: tried at once, the refusal forgotten.
        this.kept.refusal = null;
        this.restartedAt = 0;
        this.forgetPace();
        changed = true;
      }
    }
    if (this.config.pvIndex !== this.kept.pvMode) {
      // Back from "Sensor only" to the energy monitoring: what was produced
      // meanwhile (already counted by another inverter) must not be counted
      // at once: the first value is held as a jump, for the two-click acceptance.
      if (this.kept.pvMode === PV_SENSOR_ONLY && this.indexMode()) {
        this.kept.pvResume = true;
      } else if (!this.indexMode()) {
        this.kept.pvResume = false;
      }
      this.kept.pvMode = this.config.pvIndex;
      changed = true;
    }
    await this.saveState({ force: changed });
    // The core keeps the connection status and the Discovery list in memory:
    // a restarted Gladys has lost them, so they are always sent again.
    this.lastStatus = undefined;
    this.publishedDevices = undefined;
    if (!fresh) {
      // A (re)connection: every value again at the next read (none now).
      this.gladys.forgetPublishedStates?.();
    }
    await this.discover();
    await this.updateStatus({ starting: true });
    // Always armed, whatever the first read gives: never a dead integration.
    this.timer = this.timers.setInterval(() => this.run(generation, () => this.tick()), TICK);
    this.firstRun = this.run(generation, () => this.tick());
  }

  forgetPace() {
    this.lastAttemptMono = undefined;
    this.failures = 0;
    this.retryAtMono = 0;
    this.lastError = undefined;
  }

  async doStop() {
    this.generation += 1;
    if (this.timer !== undefined) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
    // The session running (if any) is cut: one connection at a time.
    this.client.abort?.();
    await this.busy;
    // /data written on a clean stop too (the last state of the counters).
    await this.saveState();
  }

  /** Run a job of a generation: nothing after a restart. */
  async run(generation, job) {
    if (generation !== this.generation) {
      return undefined;
    }
    try {
      return await job();
    } catch (err) {
      this.logger.error(`OpenEMS: unexpected error (${err?.name ?? 'Error'})`);
      return undefined;
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed (${err?.name ?? 'Error'})`));
  }

  // --- Device ---------------------------------------------------------------------

  /** The external ids of the Edge known (host name), undefined before any read. */
  external() {
    const hostname = this.kept.info?.hostname;
    return hostname ? ids(this.gladys, hostname) : undefined;
  }

  /** The created Gladys device, undefined until the user creates it. */
  createdDevice() {
    const id = this.external()?.device;
    return id ? (this.gladys.devices ?? []).find((d) => d.external_id === id) : undefined;
  }

  info() {
    return {
      hostname: this.kept.info?.hostname,
      address: this.config.address ?? this.kept.address ?? undefined,
      version: this.kept.info?.version,
    };
  }

  async discover({ force = false } = {}) {
    const devices =
      this.known && this.kept.info?.hostname && this.config.address
        ? [
            buildDevice(this.gladys, this.info(), {
              pvIndex: this.config.pvIndex,
              created: this.createdDevice(),
            }),
          ]
        : [];
    const json = JSON.stringify(devices);
    if (!force && json === this.publishedDevices) {
      return;
    }
    this.publishedDevices = json;
    await this.gladys
      .publishDiscoveredDevices(devices)
      .catch((err) =>
        this.logger.warn(`Publishing the OpenEMS device failed (${err?.name ?? 'Error'})`),
      );
  }

  /** The Discover tab: the device known, published again; never a request to the Edge. */
  async scan() {
    await this.discover({ force: true });
    await this.updateStatus();
  }

  isFresh(mono = this.monotonic()) {
    return (
      this.values !== undefined &&
      mono - this.valuesAt <= FRESH_INTERVALS * this.config.pollInterval * 1000
    );
  }

  /** The device just created: the values of the last read now (no new request). */
  async onDeviceCreated(device) {
    const external = this.external();
    if (!external || device?.external_id !== external.device) {
      return;
    }
    // A new device: no reference of its counters yet (nor a state kept in
    // /data for a deleted device of the same id).
    for (const { key } of COUNTERS) {
      const id = external.feature(key);
      this.guards.delete(id);
      delete this.kept.counters[id];
    }
    await this.saveState({ force: true });
    await this.publishLast();
  }

  async onDeviceUpdated(device) {
    const external = this.external();
    if (external && device?.external_id === external.device) {
      await this.publishLast();
    }
  }

  /** The values of the last read (if fresh and of the host name known), never a new request. */
  async publishLast() {
    const generation = this.generation;
    if (!this.isFresh() || this.values.hostname !== this.kept.info?.hostname) return;
    const prepared = this.afterSave(
      this.prepare(this.values, { counters: false }),
      await this.saveState(),
    );
    if (prepared && generation === this.generation) {
      await this.send(prepared);
      if (generation === this.generation) await this.updateStatus();
    }
  }

  // --- /data -------------------------------------------------------------------------

  /**
   * Keeps the state in /data when it changed; false when it could not (or
   * must not: an unreadable file is never written over). The instant of the
   * last session is written at most once a minute. A counter not loaded in
   * memory keeps what /data had.
   */
  async saveState({ force = false } = {}) {
    if (this.storeUnreadable) {
      return false;
    }
    const counters = Object.assign(Object.create(null), this.kept.counters);
    const offset = this.wallOffset();
    const toWall = (ref) =>
      ref && Number.isFinite(ref.at) ? { ...ref, at: ref.at + offset } : ref;
    for (const [id, guard] of this.guards) {
      const state = guard.state();
      counters[id] = { guard: { last: toWall(state.last), held: toWall(state.held) } };
    }
    this.kept.counters = counters;
    const now = this.now();
    const attempt =
      this.kept.lastAttemptAt !== this.savedAttemptAt &&
      (this.savedAttemptAt === 0 || now - this.savedAttemptAt >= ATTEMPT_SAVE_EVERY)
        ? this.kept.lastAttemptAt
        : this.savedAttemptAt;
    const state = {
      salt: this.kept.salt,
      address: this.kept.address,
      lastAttemptAt: attempt,
      refusal: this.kept.refusal,
      info: this.kept.info,
      pvMode: this.kept.pvMode,
      pvResume: this.kept.pvResume,
      counters,
    };
    const key = JSON.stringify(state);
    if (!force && key === this.savedKey && !this.saveFailed) {
      return true;
    }
    try {
      await this.store.save(state);
      this.savedKey = key;
      this.savedAttemptAt = attempt;
      this.saveFailed = false;
      return true;
    } catch (err) {
      if (!this.saveFailed) {
        this.logger.warn(`Saving the OpenEMS state in /data failed (${err?.code ?? 'error'})`);
      }
      this.saveFailed = true;
      return false;
    }
  }

  /**
   * The states to send after a save: without the counters when /data could
   * not be written, so Gladys never gets a counter /data does not know; the
   * other values go.
   */
  afterSave(states, saved) {
    if (!states || saved) return states;
    const external = this.external();
    const counters = new Set(COUNTERS.map(({ key }) => external?.feature(key)));
    const kept = states.filter((s) => !counters.has(s.device_feature_external_id));
    return kept.length > 0 ? kept : undefined;
  }

  // --- Reads -------------------------------------------------------------------------

  intervalMs() {
    return this.config.pollInterval * 1000;
  }

  /** The wait after a failure: never faster than a read, doubled up to 15 min. */
  retryWait(failures) {
    const first = Math.max(RETRY_MIN, this.intervalMs());
    return Math.min(first * 2 ** failures, Math.max(RETRY_MAX, first));
  }

  /**
   * The earliest instant (wall clock) of the next read, whatever asks for it,
   * from ONE reading of each clock (`now`, `mono`); Infinity while the
   * password is refused (only the test button tries then, `manual`).
   */
  nextReadAt({ manual = false, now = this.now(), mono = this.monotonic() } = {}) {
    const at = [now];
    if (this.lastAttemptMono !== undefined) {
      // Never sooner than the interval (the timer looks every 5 s: 30 to 35 s at 30 s).
      at.push(now + this.lastAttemptMono + this.intervalMs() - mono);
    }
    if (!manual && this.retryAtMono > mono) at.push(now + this.retryAtMono - mono);
    if (this.restartedAt > 0) {
      // Monotonic, as the interval (review r2, m-r2-3).
      at.push(now + this.restartedAt + ATTEMPT_SAVE_EVERY + this.intervalMs() - mono);
    }
    if (!manual && this.kept.refusal) at.push(Infinity);
    return Math.max(...at);
  }

  due({ manual = false } = {}) {
    if (!this.credentials()) return false;
    const now = this.now();
    const mono = this.monotonic();
    return this.nextReadAt({ manual, now, mono }) <= now;
  }

  /**
   * One look: a read when one is due. A read still running is never doubled,
   * whatever its generation (a reconnection during a read starts no other).
   */
  tick({ manual = false } = {}) {
    if (this.busy) {
      return this.busy;
    }
    if (!this.due({ manual })) {
      return undefined;
    }
    const generation = this.generation;
    this.busy = this.read(generation).finally(() => {
      this.busy = undefined;
    });
    return this.busy;
  }

  async read(generation) {
    const credentials = this.credentials();
    const digest = digestOf(credentials);
    const alive = () => generation === this.generation;
    // Recorded first: neither a reconnection, a save nor a restart reads sooner.
    this.lastAttemptMono = this.monotonic();
    this.restartedAt = 0;
    this.kept.lastAttemptAt = this.now();
    await this.saveState();
    let answer;
    try {
      answer = await this.client.read(credentials);
    } catch (err) {
      await this.failed(err, { credentials, digest, alive });
      return;
    }
    if (!alive()) {
      // Late: an old configuration or a restart. Nothing published, no status.
      return;
    }
    this.failures = 0;
    this.retryAtMono = 0;
    this.lastError = undefined;
    // The fingerprint of a refused log-in goes with the first success.
    this.kept.refusal = null;
    const values = parseValues(answer.params);
    this.edge = answer.edge;
    this.noHostname = values.hostname === undefined;
    this.otherHost = false;
    if (values.hostname) {
      if (this.kept.info?.hostname && this.kept.info.hostname !== values.hostname) {
        this.otherHost = true;
        this.logger.warn(
          'OpenEMS: another host name answers at this address: its own device is in Discovery',
        );
        // The counters of the old device stay in /data (its device keeps its history).
      }
      this.kept.info = {
        hostname: values.hostname,
        version: values.version ?? answer.edge?.version,
      };
      this.known = true;
    }
    this.values = values;
    this.valuesAt = this.monotonic();
    this.readAt = this.now();
    const states = values.hostname ? this.prepare(values, { counters: true }) : undefined;
    // Saved BEFORE Gladys gets the values; a counter only goes once /data
    // holds it (a failed write sends the other values only).
    const prepared = this.afterSave(states, await this.saveState());
    if (!alive()) return;
    if (prepared) await this.send(prepared);
    if (!alive()) return;
    await this.discover();
    if (!alive()) return;
    await this.updateStatus();
  }

  async failed(err, { credentials, digest, alive }) {
    const code = err?.code ?? 'error';
    // A late failure of another configuration is dropped; a refusal of the
    // same address and log-in fields is still kept.
    const current = this.credentials();
    const same = current !== undefined && digestOf(current) === digest;
    if (!alive() && !same) return;
    if (code === 'aborted') return;
    // Our own words only (OpenemsError codes): never a byte of the Edge, never a secret.
    this.logger.warn(`OpenEMS read of ${credentials.address} failed: ${code}`);
    if (code === 'refused') {
      this.kept.refusal = {
        code: 'refused',
        fp: fingerprint(this.kept.salt, credentials.address, credentials),
      };
    } else {
      this.retryAtMono = this.monotonic() + this.retryWait(this.failures);
      this.failures += 1;
    }
    this.lastError = err;
    await this.saveState();
    if (alive()) {
      await this.updateStatus();
    }
  }

  /** Whether the counter `key` gets values on the created device (features fixed at creation). */
  counterActive(key, features) {
    if (!features.has(key)) return false;
    // "Sensor only": the index never gets a value (another integration counts it).
    return key !== FEATURE.PRODUCTION_INDEX || this.indexMode();
  }

  /** The guard of a counter of the created device, from Gladys and /data. */
  guardOf(created, id) {
    if (!this.guards.has(id)) {
      const saved = this.kept.counters[id];
      // The guard lives on the session clock (never the wall clock, which NTP
      // may have moved since the start: review r2, R4).
      const sessionNow = this.sessionNow();
      // /data holds wall dates (saveState): back to the session clock.
      const offset = this.now() - sessionNow;
      const toSession = (ref) =>
        ref && Number.isFinite(ref.at) ? { ...ref, at: ref.at - offset } : ref;
      // A date "in the future" (a wall clock set back across a restart) is now:
      // the margin of the next rise never shrinks to nothing (review r2, R3).
      const clamp = (ref) =>
        ref && Number.isFinite(ref.at) ? { ...ref, at: Math.min(ref.at, sessionNow) } : ref;
      const guardState = saved?.guard
        ? { ...saved.guard, last: clamp(toSession(saved.guard.last)) }
        : saved?.guard;
      const now = sessionNow;
      this.guards.set(
        id,
        new IndexGuard(clamp(lastValueOf(created, id)), guardState, now, COUNTER_LIMITS),
      );
    }
    return this.guards.get(id);
  }

  /**
   * The states of a read, the counters through their guards (not sent yet:
   * `send` does it, after /data is saved). Undefined without a created device.
   * `counters`: a new read (the counters are taken); otherwise (a device just
   * created) the last accepted values only.
   */
  prepare(values, { counters }) {
    const created = this.createdDevice();
    const external = this.external();
    if (!created || !external) {
      return undefined;
    }
    const now = this.sessionNow();
    const features = new Set(
      (created.features ?? []).map((f) =>
        String(f.external_id ?? '')
          .split(':')
          .at(-1),
      ),
    );
    const out = {};
    for (const { name, key, value } of COUNTERS) {
      if (!this.counterActive(key, features)) continue;
      const id = external.feature(key);
      const guard = this.guardOf(created, id);
      const read = values[value] === undefined ? undefined : round(values[value], 3);
      if (!counters || read === undefined) {
        out[key] = guard.held ? guard.last?.value : undefined;
        continue;
      }
      if (key === FEATURE.PRODUCTION_INDEX && this.kept.pvResume) {
        // The first value after a return from "Sensor only".
        this.kept.pvResume = false;
        const from = guard.last?.value;
        if (from !== undefined && read > from && !guard.held) {
          // Held as a jump (the guard keeps it held at or above it, the
          // acceptance in two clicks takes it); never counted at once.
          guard.held = { direction: 'up', from, to: read, threshold: read, at: now };
        }
      }
      const plausible = guard.accept(read, now);
      const held = guard.held ? `${guard.held.direction}:${guard.held.from}` : undefined;
      if (held && this.loggedHolds.get(id) !== held) {
        this.logger.warn(
          `OpenEMS ${name} counter ${guard.held.direction === 'down' ? 'drop' : 'jump'} held back: the "Accept the held counter" button takes it`,
        );
      }
      if (held) this.loggedHolds.set(id, held);
      else this.loggedHolds.delete(id);
      // While a value is held, the last accepted one is sent again (no delta for the core).
      out[key] = plausible ? read : guard.held ? guard.last?.value : undefined;
    }
    const states = readStates(external, values, out).filter((s) =>
      features.has(s.device_feature_external_id.split(':').at(-1)),
    );
    return states.length > 0 ? states : undefined;
  }

  /**
   * The states, within STATES_PER_MINUTE over any 60 s: a batch that would go
   * beyond is not sent this time. The room is taken BEFORE the publication
   * (two publications at once never both pass).
   */
  async send(states) {
    const mono = this.monotonic();
    this.sent = this.sent.filter((s) => mono - s.at < MINUTE);
    const used = this.sent.reduce((sum, s) => sum + s.count, 0);
    if (used + states.length > STATES_PER_MINUTE) {
      this.logger.debug('OpenEMS: values kept for the next read (states per minute)');
      return;
    }
    const entry = { at: mono, count: states.length };
    this.sent.push(entry);
    try {
      const result = await this.gladys.publishChangedStates(states, { heartbeat: STATE_HEARTBEAT });
      if (Number.isInteger(result?.count) && result.count >= 0 && result.count <= states.length) {
        entry.count = result.count;
      }
    } catch (err) {
      this.logger.warn(`Publishing the OpenEMS values failed (${err?.name ?? 'Error'})`);
    }
  }

  // --- Status ------------------------------------------------------------------------

  /** Whether the production goes to the energy monitoring (option `production_index`). */
  indexMode() {
    return this.config.pvIndex !== PV_SENSOR_ONLY;
  }

  /** Every counter held back: `{ id, name, direction, from, to }`. */
  heldList() {
    const created = this.createdDevice();
    if (!created) return [];
    const features = new Set(
      (created.features ?? []).map((f) =>
        String(f.external_id ?? '')
          .split(':')
          .at(-1),
      ),
    );
    const list = [];
    for (const { name, key } of COUNTERS) {
      if (!this.counterActive(key, features)) continue;
      const id = this.external().feature(key);
      const held = this.guardOf(created, id).held;
      if (held) list.push({ id, name, ...held });
    }
    return list;
  }

  async updateStatus({ starting = false } = {}) {
    const { problem, address } = this.config;
    if (problem) {
      await this.setStatus(false, T.problem[problem]);
      return;
    }
    const now = this.now();
    const mono = this.monotonic();
    if (this.kept.refusal) {
      await this.setStatus(false, T.refused(address));
      return;
    }
    if (this.lastError) {
      const wait = Math.max(0, this.retryAtMono - mono);
      await this.setStatus(false, T.failing(address, this.lastError, wait));
      return;
    }
    if (!this.values) {
      const at = this.nextReadAt({ now, mono });
      if (starting && at <= now) {
        await this.setStatus(false, T.connecting);
      } else {
        // After a restart, an Edge read before (no refusal, no error) is
        // shown connected until its next read.
        await this.setStatus(this.known, T.waiting(at));
      }
      return;
    }
    const notes = [];
    if (this.noHostname) notes.push(T.notes.noHostname);
    else if (!this.createdDevice()) notes.push(T.notes.noDevice);
    if (this.otherHost) notes.push(T.notes.otherHost);
    if (this.edge?.role && this.edge.role !== 'guest') notes.push(T.notes.role(this.edge.role));
    if (this.storeUnreadable) notes.push(T.notes.storeUnreadable);
    else if (this.saveFailed) notes.push(T.notes.storeFailed);
    const held = this.heldList();
    if (held.length > 0) notes.push(T.notes.held(held));
    // Without a readable host name this time, the old name is not said to answer.
    const shown = this.noHostname ? undefined : this.kept.info;
    await this.setStatus(true, T.ok(shown?.hostname ?? '?', shown?.version, notes));
  }

  // --- Configuration screen buttons -------------------------------------------------

  /**
   * "Accept the held counter", in two clicks: the first lists every counter
   * held (nothing is accepted), the second, from 3 s to 5 min later, accepts
   * exactly what the first listed, and only when it still shows that value
   * (or, for a jump, what may have come since: src/guard.js). A drop is a
   * reset or a new meter: once accepted, counting goes on from the new value
   * (the core counts nothing for a drop). A save of the form never accepts.
   */
  async acceptHeldCounter() {
    const list = this.heldList();
    const mono = this.monotonic();
    const now = this.sessionNow();
    const pending = this.pendingAccept;
    this.pendingAccept = undefined;
    const elapsed = pending ? mono - pending.at : undefined;
    if (!pending || elapsed > ACCEPT_CONFIRM_WITHIN || elapsed < ACCEPT_CONFIRM_AFTER) {
      if (list.length === 0) {
        return T.accept.nothing;
      }
      this.pendingAccept = { at: mono, listedAt: now, list };
      return T.accept.confirm(list, ACCEPT_CONFIRM_WITHIN);
    }
    const accepted = [];
    const changed = [];
    for (const entry of pending.list) {
      const guard = this.guards.get(entry.id);
      const held = guard?.held;
      const margin = guard ? guard.margin(pending.listedAt, now) : 0;
      // The value listed, or what the counter may have added since (both directions).
      const same =
        held &&
        held.direction === entry.direction &&
        held.from === entry.from &&
        held.to >= entry.to &&
        held.to - entry.to <= margin;
      if (same && guard.acceptHeld()) {
        accepted.push({ ...entry, to: held.to });
      } else if (held) {
        changed.push(entry);
      }
    }
    if (accepted.length === 0 && changed.length === 0) {
      return T.accept.nothing;
    }
    for (const { name, direction } of accepted) {
      this.logger.info(
        `OpenEMS ${name} counter ${direction === 'down' ? 'drop' : 'jump'} accepted by the user`,
      );
    }
    await this.saveState();
    // Published at the next read (never a read sooner than the interval).
    const taken = new Set(accepted.map((h) => h.id));
    const stillHeld = this.heldList().some((h) => !taken.has(h.id));
    return T.accept.done(accepted, changed, stillHeld);
  }

  /**
   * The test button: a read when one is due (the interval passed; a refused
   * password may be tried again then, once per click), else what is known
   * and when the next read can be. Never a session the pace forbids.
   */
  async testConnection() {
    const { problem, address } = this.config;
    if (problem) {
      return T.problem[problem];
    }
    const generation = this.generation;
    const job = this.busy ?? this.tick({ manual: true });
    if (job) {
      let timer;
      const late = new Promise((resolve) => {
        timer = this.timers.setTimeout(() => resolve('late'), TEST_ANSWER_WITHIN);
      });
      try {
        if ((await Promise.race([job.then(() => 'done'), late])) === 'late') {
          return T.test.slow;
        }
      } finally {
        this.timers.clearTimeout(timer);
      }
    }
    if (generation !== this.generation) {
      return T.test.slow;
    }
    const lines = [];
    const mono = this.monotonic();
    const fresh = this.isFresh(mono);
    if (this.kept.refusal) {
      lines.push(T.test.failed(address, { code: 'refused' }));
    } else if (this.lastError) {
      lines.push(T.test.failed(address, this.lastError));
    } else if (fresh) {
      lines.push(
        T.test.ok(address, this.kept.info?.hostname, this.values, this.kept.info?.version),
      );
    }
    if (fresh && this.readAt !== undefined) lines.push(T.test.lastRead(this.readAt));
    if (!job) lines.push(T.test.notNow(this.nextReadAt({ manual: true, mono })));
    return T.test.lines(lines);
  }
}
