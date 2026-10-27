// -----------------------------------------------------------------------------
// What must survive a restart of the container (a small JSON file under
// /data, the only writable place): the instant of the last session (written
// at most once a minute), a refusal of the log-in (a final stop), the guards
// of the lifetime counters, and what the Discovery list shows (host name and
// version of the Edge: nothing secret).
//
// No secret is ever written: neither the user name nor the password. Only
// while a log-in is refused, the file keeps a TRUNCATED fingerprint of what
// was refused: 8 bits of a salted scrypt (random salt per file) of the
// address and the two fields, enough to see after a restart whether the form
// changed since (1 chance in 256 to take a new form for the refused one: the
// test button then tries it), far too little to confirm or find a password.
// It is erased by the first successful log-in. (After gladys-e3dc.)
//
// A file that exists but cannot be read (rights, a disk error, broken JSON)
// is NOT an empty file: `load()` says `unreadable`, and the app then never
// writes over it (nor publishes a counter /data cannot keep) until a start
// reads it again. Written through a temporary file and a rename, one write at
// a time; a failure is never fatal.
// -----------------------------------------------------------------------------

import { randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { hostnameOf, versionOf } from './openems/model.js';

export const DEFAULT_STATE_FILE = '/data/openems-state.json';
const MAX_FILE = 64 * 1024;

/**
 * A JSON file: `load()` (sync: `{ data }`, `{ data: {} }` when absent,
 * `{ unreadable: true }` otherwise) and `save(data)` (atomic).
 */
export function createFileStore(file = DEFAULT_STATE_FILE) {
  let queue = Promise.resolve();
  const write = async (data) => {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, file);
  };
  return {
    load() {
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch (err) {
        return err?.code === 'ENOENT' ? { data: {} } : { unreadable: true };
      }
      try {
        if (text.length > MAX_FILE) return { unreadable: true };
        const data = JSON.parse(text);
        return data && typeof data === 'object' && !Array.isArray(data)
          ? { data }
          : { unreadable: true };
      } catch {
        return { unreadable: true };
      }
    },
    save(data) {
      const job = queue.then(
        () => write(data),
        () => write(data),
      );
      queue = job.catch(() => {});
      return job;
    },
  };
}

/** The same in memory (tests). `unreadable`: load() says so. */
export function createMemoryStore(
  initial = {},
  { unreadable = false, failSave = false, slow = false } = {},
) {
  let data = structuredClone(initial);
  let saves = 0;
  const store = {
    unreadable,
    failSave,
    slow,
    load: () => (store.unreadable ? { unreadable: true } : { data: structuredClone(data) }),
    async save(next) {
      // `slow`: a few turns of the event loop, so that unserialized jobs would interleave.
      if (store.slow) for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
      if (store.failSave) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      saves += 1;
      data = structuredClone(next);
    },
    get data() {
      return data;
    },
    get saves() {
      return saves;
    },
  };
  return store;
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const FP = /^[0-9a-f]{2}$/;
/** The external id of a counter feature: `ext:<selector>:edge:<hostname>:<key>`. */
const COUNTER_ID =
  /^ext:[A-Za-z0-9_.-]{1,64}:edge:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?:[a-z0-9_]{1,40}$/;

/** A refusal read back: `{ code: 'refused', fp }`, a final stop (no end). */
export function validRefusal(refusal) {
  if (
    !isObject(refusal) ||
    refusal.code !== 'refused' ||
    typeof refusal.fp !== 'string' ||
    !FP.test(refusal.fp)
  ) {
    return undefined;
  }
  return { code: refusal.code, fp: refusal.fp };
}

/** The non-secret facts of the Edge read back from /data. */
export function validInfo(info) {
  if (!isObject(info)) return undefined;
  const hostname = hostnameOf(info.hostname);
  if (!hostname) return undefined;
  return { hostname, version: versionOf(info.version) };
}

/**
 * The persisted state, sanitized: the instant of the last session never "in
 * the future", every field checked, so a clock that jumped or a hand-edited
 * file never stops the reads for longer.
 */
export function readState(raw, now) {
  const data = isObject(raw) ? raw : {};
  const salt =
    typeof data.salt === 'string' && /^[0-9a-f]{32}$/.test(data.salt)
      ? data.salt
      : randomBytes(16).toString('hex');
  const address =
    typeof data.address === 'string' && data.address.length <= 300 ? data.address : null;
  // No prototype, and only the ids of a counter feature.
  const counters = Object.create(null);
  if (isObject(data.counters)) {
    for (const [id, state] of Object.entries(data.counters).slice(0, 40)) {
      if (COUNTER_ID.test(id) && isObject(state)) counters[id] = state;
    }
  }
  return {
    salt,
    address,
    lastAttemptAt: Math.min(finite(data.lastAttemptAt) ?? 0, now),
    // Kept until a log-in succeeds, whatever the time: never tried again by itself.
    refusal: address ? (validRefusal(data.refusal) ?? null) : null,
    info: validInfo(data.info) ?? null,
    // The `production_index` option of the last start, and whether the
    // production index came back from "Sensor only" and its first value is
    // still to be held.
    pvMode:
      data.pvMode === 'sensor_only' || data.pvMode === 'energy_monitoring' ? data.pvMode : null,
    pvResume: data.pvResume === true,
    counters,
  };
}

/**
 * The truncated (8-bit) salted fingerprint of a REFUSED log-in for an
 * address: the address, user name and password (none holds a control
 * character, so the separators are unambiguous). Never a secret.
 */
export function fingerprint(salt, address, { username, password }) {
  const text = [address, username, password].map(String).join('\u0000');
  return scryptSync(text, salt, 16).subarray(0, 1).toString('hex');
}
