// -----------------------------------------------------------------------------
// The only network access: one JSON-RPC session over the WebSocket of the
// OpenEMS Edge at a time (port 8085, Controller.Api.Websocket; the requests
// of ha_openems, Apache-2.0, see THIRD_PARTY_NOTICES.md).
//
// One read = one session: open, log in, `subscribeEdges` (secondary: an error
// answer or no answer within 2 s is ignored), `edgeRpc` → `subscribeChannels`,
// the first `currentData` the Edge pushes with a useful value, close. The log-in
// reuses the token of the first `authenticateWithPassword`
// (`authenticateWithToken`): the Edge keeps every token it gives until a
// restart, so one per read would pile up (review r1, I3). The token lives in
// memory only (never logged, never in /data), bound to the address, user name
// and password; a token the Edge no longer knows is forgotten and the
// password sent in the same session (only THAT answer can be a refusal). Any
// error ends the session at once, socket closed (review r1, I2). One
// request in flight at a time (each answer awaited before the next request).
// Only the answer with the id of our request is taken; the data only from a
// notification of the Edge we asked.
//
// Bounds: a message is at most MAX_MESSAGE_BYTES (`ws` refuses a longer frame
// from its header, before reading it), no compression, no redirect, at most
// MAX_MESSAGES messages and MAX_CHANNELS values; connect 5 s, each answer 8 s,
// the whole session 25 s. The session ends (the socket closed) before the
// read resolves: a new connection only after the old one is closed.
//
// Nothing received is ever logged nor put in an error: the errors carry our
// own code only. The password only goes into the log-in request.
// -----------------------------------------------------------------------------

import { createHash, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  ANSWER_TIMEOUT,
  CONNECT_TIMEOUT,
  DATA_TIMEOUT,
  FEMS_WEB_PATH,
  FEMS_WEB_PORT,
  MAX_CHANNELS,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGES,
  SECONDARY_TIMEOUT,
  SESSION_TIMEOUT,
} from '../constants.js';
import { CHANNELS, hasUsefulValue, versionOf } from './model.js';

/** The JSON-RPC error code of OpenEMS for a wrong password (ha_openems: 1003 → wrong user / password). */
export const AUTHENTICATION_FAILED = 1003;

/**
 * Our errors: `code` is one of 'unreachable', 'timeout', 'closed',
 * 'protocol', 'refused', 'denied', 'busy', 'aborted'. Never a text received.
 */
export class OpenemsError extends Error {
  constructor(code) {
    super(`OpenEMS: ${code}`);
    this.name = 'OpenemsError';
    this.code = code;
  }
}

const EDGE_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const ROLES = new Set(['admin', 'installer', 'owner', 'guest']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The URL of the WebSocket of an address (port 80: the FEMS web server, path /websocket). */
export function urlOf({ host, port }) {
  const name = host.includes(':') ? `[${host}]` : host;
  return `ws://${name}:${port}${port === FEMS_WEB_PORT ? FEMS_WEB_PATH : '/'}`;
}

/**
 * The Edge of a log-in answer: its id ('0' when none is given), version and
 * role. An Edge answers `edges: []` and its role in `user.globalRole`
 * (OpenEMS AuthenticationRequestHandler, review r1 m1); a backend lists the
 * edges with their role.
 */
export function edgeOf(result) {
  const edges = Array.isArray(result?.edges) ? result.edges : [];
  const edge = edges.find((e) => isObject(e) && typeof e.id === 'string' && EDGE_ID.test(e.id));
  const raw = result?.user?.globalRole ?? edge?.role;
  const role = typeof raw === 'string' ? raw.toLowerCase() : undefined;
  return {
    id: edge?.id ?? '0',
    version: versionOf(edge?.version),
    role: ROLES.has(role) ? role : undefined,
  };
}

const request = (method, params) => ({ jsonrpc: '2.0', id: randomUUID(), method, params });

/** A token of the Edge: printable ASCII, 512 characters at most; else not kept. */
const TOKEN = /^[\x21-\x7e]{1,512}$/;
const tokenOf = (result) =>
  typeof result?.token === 'string' && TOKEN.test(result.token) ? result.token : undefined;

/** What a token is bound to (memory only): the address, user name and password. */
const keyOf = ({ host, port, username, password }) =>
  createHash('sha256')
    .update([host, port, username, password].map(String).join('\u0000'))
    .digest('hex');

export class OpenemsClient {
  /** `timeouts`: shorter delays for the tests (`connect`, `answer`, `data`, `session`, ms). */
  constructor({ WebSocketImpl = WebSocket, timeouts = {} } = {}) {
    this.WebSocketImpl = WebSocketImpl;
    this.timeouts = {
      connect: CONNECT_TIMEOUT,
      answer: ANSWER_TIMEOUT,
      data: DATA_TIMEOUT,
      session: SESSION_TIMEOUT,
      secondary: SECONDARY_TIMEOUT,
      ...timeouts,
    };
    this.session = undefined;
    /** The token of the Edge, memory only: `{ key, token }`. */
    this.token = undefined;
  }

  /** Ends the session running, if any (a stop of the integration). */
  abort() {
    this.session?.fail(new OpenemsError('aborted'));
  }

  /**
   * One read: `{ edge: { id, version, role }, params }`, `params` the values
   * of the first useful `currentData`. Throws an OpenemsError.
   */
  async read({ host, port, username, password }) {
    if (this.session) {
      throw new OpenemsError('busy');
    }
    const key = keyOf({ host, port, username, password });
    const token = this.token?.key === key ? this.token.token : undefined;
    const session = new Session(this.WebSocketImpl, urlOf({ host, port }), this.timeouts);
    this.session = session;
    try {
      const answer = await session.run({ username, password, token });
      if (answer.token === null) this.token = undefined;
      else if (answer.token) this.token = { key, token: answer.token };
      return { edge: answer.edge, params: answer.params };
    } catch (err) {
      // Any error ends the session now: never an open socket until the session timer.
      session.fail(err);
      // A token refused, or a log-in by token that failed in any way (no
      // answer, closed: review r2, m-r2-1): forgotten, the next read sends the password.
      if (session.tokenRejected || session.tokenPending || err?.code === 'refused') {
        this.token = undefined;
      }
      throw err;
    } finally {
      await session.closed;
      this.session = undefined;
    }
  }
}

class Session {
  constructor(WebSocketImpl, url, timeouts) {
    this.timeouts = timeouts;
    this.messages = 0;
    /** Messages received while no request waited (never more than MAX_MESSAGES). */
    this.inbox = [];
    this.waiter = undefined;
    this.error = undefined;
    let closedResolve;
    this.closed = new Promise((resolve) => {
      closedResolve = resolve;
    });
    this.closedResolve = closedResolve;
    this.timer = setTimeout(() => this.fail(new OpenemsError('timeout')), timeouts.session);
    try {
      this.ws = new WebSocketImpl(url, {
        handshakeTimeout: timeouts.connect,
        maxPayload: MAX_MESSAGE_BYTES,
        perMessageDeflate: false,
        followRedirects: false,
      });
    } catch {
      this.ws = undefined;
      this.error = new OpenemsError('unreachable');
      clearTimeout(this.timer);
      closedResolve();
      return;
    }
    this.opened = new Promise((resolve) => {
      this.ws.once('open', resolve);
    });
    this.ws.on('message', (data, binary) => this.onMessage(data, binary));
    this.ws.on('error', (err) => {
      // A frame over maxPayload or not WebSocket (WS_ERR_*): not an Edge; else a reset.
      const code = /^WS_ERR_/.test(String(err?.code ?? ''))
        ? 'protocol'
        : this.wasOpen
          ? 'closed'
          : 'unreachable';
      this.fail(new OpenemsError(code));
    });
    // An HTTP answer instead of the upgrade (a web server, not the Edge).
    this.ws.on('unexpected-response', () => this.fail(new OpenemsError('protocol')));
    this.ws.once('open', () => {
      this.wasOpen = true;
    });
    this.ws.once('close', () => {
      clearTimeout(this.timer);
      this.fail(new OpenemsError('closed'));
      this.closedResolve();
    });
  }

  /** Ends the session with an error (the first one wins), the socket closed. */
  fail(err) {
    if (!this.error) this.error = err;
    clearTimeout(this.timer);
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.reject(this.error);
    this.end();
  }

  end() {
    if (!this.ws) return;
    const ws = this.ws;
    if (ws.readyState === WebSocket.CLOSED) {
      this.closedResolve();
      return;
    }
    if (this.ending) return;
    this.ending = true;
    try {
      ws.terminate();
    } catch {
      this.closedResolve();
    }
  }

  /** Waits for a message `match` takes (returns a value, or undefined to go on), within `ms`. */
  wait(match, ms, { optional = false } = {}) {
    if (this.error) return Promise.reject(this.error);
    // A message may arrive before its waiter (two in one read of the socket): kept in the inbox.
    for (const [i, message] of this.inbox.entries()) {
      let taken;
      try {
        taken = match(message);
      } catch (err) {
        this.fail(err instanceof OpenemsError ? err : new OpenemsError('protocol'));
        return Promise.reject(this.error);
      }
      if (taken !== undefined) {
        this.inbox.splice(i, 1);
        return Promise.resolve(taken);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (optional && this.waiter?.match === match) {
          // A secondary request without answer: the session goes on.
          this.waiter = undefined;
          resolve(undefined);
        } else {
          this.fail(new OpenemsError('timeout'));
        }
      }, ms);
      this.waiter = {
        match,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
    });
  }

  onMessage(data, binary) {
    this.messages += 1;
    if (this.messages > MAX_MESSAGES || binary) {
      this.fail(new OpenemsError('protocol'));
      return;
    }
    let message;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      this.fail(new OpenemsError('protocol'));
      return;
    }
    // The envelope first: anything but JSON-RPC 2.0 is not an OpenEMS Edge.
    if (!isObject(message) || message.jsonrpc !== '2.0') {
      this.fail(new OpenemsError('protocol'));
      return;
    }
    const waiter = this.waiter;
    if (!waiter) {
      // Bounded: MAX_MESSAGES per session.
      this.inbox.push(message);
      return;
    }
    let taken;
    try {
      taken = waiter.match(message);
    } catch (err) {
      this.fail(err instanceof OpenemsError ? err : new OpenemsError('protocol'));
      return;
    }
    if (taken !== undefined) {
      this.waiter = undefined;
      waiter.resolve(taken);
    }
  }

  /** Sends a request and waits for ITS answer: `{ result }` or `{ error }`. */
  async call(body, { timeout = this.timeouts.answer, optional = false } = {}) {
    if (this.error) throw this.error;
    const answer = this.wait(
      (m) => {
        if (m.id !== body.id || !('result' in m || 'error' in m)) return undefined;
        return isObject(m.error)
          ? { error: { code: Number.isInteger(m.error.code) ? m.error.code : undefined } }
          : { result: m.result };
      },
      timeout,
      { optional },
    );
    try {
      this.ws.send(JSON.stringify(body));
    } catch {
      this.fail(new OpenemsError('closed'));
    }
    return answer;
  }

  /** An `edgeRpc` request to the Edge: the answer inside (`{ result }` or `{ error }`). */
  async edgeCall(edgeId, payload) {
    const outer = await this.call(request('edgeRpc', { edgeId, payload }));
    if (outer.error) return outer;
    const inner = outer.result?.payload;
    if (!isObject(inner) || inner.id !== payload.id) {
      throw new OpenemsError('protocol');
    }
    return isObject(inner.error)
      ? { error: { code: Number.isInteger(inner.error.code) ? inner.error.code : undefined } }
      : { result: inner.result };
  }

  async run({ username, password, token }) {
    if (this.error) throw this.error;
    await Promise.race([this.opened, this.closed.then(() => Promise.reject(this.error))]);
    if (this.error) throw this.error;
    let login;
    let newToken;
    if (token) {
      this.tokenPending = true;
      login = await this.call(request('authenticateWithToken', { token }));
      this.tokenPending = false;
      if (login.error || !isObject(login.result)) {
        // Unknown to the Edge (restarted, cleared): forgotten, never a refusal.
        this.tokenRejected = true;
        newToken = null;
        login = undefined;
      }
    }
    if (!login) {
      login = await this.call(request('authenticateWithPassword', { username, password }));
      if (login.error) {
        // Only the code of a wrong password is a refusal; any other error is not.
        throw new OpenemsError(login.error.code === AUTHENTICATION_FAILED ? 'refused' : 'protocol');
      }
      if (!isObject(login.result)) throw new OpenemsError('protocol');
      newToken = tokenOf(login.result) ?? null;
    }
    const edge = edgeOf(login.result);
    // Secondary: older or newer Edges may not know it; an error answer, or no
    // answer within 2 s, is ignored (a late answer has an id nobody waits for).
    await this.call(request('subscribeEdges', { edges: [edge.id] }), {
      timeout: this.timeouts.secondary,
      optional: true,
    });
    const subscribe = await this.edgeCall(
      edge.id,
      request('subscribeChannels', { count: 0, channels: Object.values(CHANNELS) }),
    );
    if (subscribe.error) {
      // Logged in, but the channels are refused (a role, a missing channel): not a refusal of the password.
      throw new OpenemsError('denied');
    }
    const params = await this.wait((m) => {
      if (m.method !== 'edgeRpc' || 'id' in m) return undefined;
      const p = m.params;
      if (!isObject(p) || p.edgeId !== edge.id || !isObject(p.payload)) return undefined;
      if (p.payload.method !== 'currentData' || !isObject(p.payload.params)) return undefined;
      const values = p.payload.params;
      if (Object.keys(values).length > MAX_CHANNELS) throw new OpenemsError('protocol');
      return hasUsefulValue(values) ? values : undefined;
    }, this.timeouts.data);
    // Done: closed now (the read resolves once the socket is closed).
    this.error = new OpenemsError('aborted');
    clearTimeout(this.timer);
    this.closeGently();
    return { edge, params: Object.assign(Object.create(null), params), token: newToken };
  }

  /** A clean close (code 1000), cut after 1 s if the Edge does not answer it. */
  closeGently() {
    const ws = this.ws;
    if (ws.readyState === WebSocket.CLOSED) {
      this.closedResolve();
      return;
    }
    const cut = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        this.closedResolve();
      }
    }, 1000);
    ws.once('close', () => clearTimeout(cut));
    try {
      ws.close(1000);
    } catch {
      clearTimeout(cut);
      this.closedResolve();
    }
  }
}
