// -----------------------------------------------------------------------------
// A fake OpenEMS Edge: a real WebSocket server on 127.0.0.1 (a free port),
// speaking the JSON-RPC of Controller.Api.Websocket as OpenEMS `develop`
// answers it: `authenticateWithPassword` (a new token each time, kept until
// a restart; error 1003 on a wrong password), `authenticateWithToken` (1003 on
// an unknown token), the log-in answer with `edges: []` and the role in
// `user.globalRole`,
// `subscribeEdges`, `edgeRpc` → `subscribeChannels`, then `currentData`
// notifications in `edgeRpc` envelopes. Records the connections, the open
// sockets at once and the requests. Never leaves the loopback.
// -----------------------------------------------------------------------------

import { wsServer } from '../kit/ws.mjs';

/** The values of a FENECON Home (Wh for the energies). */
export function edgeValues(overrides = {}) {
  return {
    '_host/Hostname': 'fems12345',
    '_meta/Version': '2026.7.2',
    '_sum/EssSoc': 77,
    '_sum/EssActivePower': -1500,
    '_sum/GridActivePower': -320,
    '_sum/ProductionActivePower': 4321,
    '_sum/ConsumptionActivePower': 2501,
    '_sum/ProductionActiveEnergy': 12_345_678,
    '_sum/ConsumptionActiveEnergy': 9_876_543,
    '_sum/GridBuyActiveEnergy': 2_000_000,
    '_sum/GridSellActiveEnergy': 5_000_000,
    '_sum/EssDcChargeEnergy': 3_000_000,
    '_sum/EssDcDischargeEnergy': 2_800_000,
    '_sum/State': 0,
    '_sum/GridMode': 1,
    ...overrides,
  };
}

/**
 * `options`: `password` (the one it accepts), `role`, `version`, `edgeId`,
 * `values()`, `latencyMs`, `onLogin`: 'close' | 'silent' | 'error' |
 * 'garbage' | 'notJsonrpc', `subscribeEdges`: 'error' | 'silent',
 * `subscribe`: 'error' | 'silent', `data`: 'none' | 'otherEdge' | 'empty' |
 * 'big' | 'flood', `extraFirst` (a message sent before each answer).
 */
export async function startFakeEdge(options = {}) {
  const o = {
    password: 'user',
    role: 'guest',
    edgeId: '0',
    values: () => edgeValues(),
    latencyMs: 0,
    ...options,
  };
  const record = {
    requests: [],
    open: 0,
    maxOpen: 0,
    logins: 0,
    tokenLogins: 0,
    tokens: new Set(),
  };
  let next = 0;
  const loginResult = (token) => ({
    token,
    user: { id: 'guest', name: 'Guest', globalRole: o.role, hasMultipleEdges: false },
    edges: [],
  });
  const later = (fn) => (o.latencyMs > 0 ? setTimeout(fn, o.latencyMs) : setImmediate(fn));
  const answer = (client, body) => later(() => client.readyState === 1 && srv.send(client, body));
  const push = (client, edgeId, params) =>
    answer(client, {
      jsonrpc: '2.0',
      method: 'edgeRpc',
      params: { edgeId, payload: { jsonrpc: '2.0', method: 'currentData', params } },
    });
  const srv = await wsServer({
    onConnection(client) {
      record.open += 1;
      record.maxOpen = Math.max(record.maxOpen, record.open);
      client.on('close', () => {
        record.open -= 1;
      });
    },
    onMessage(text, client) {
      const m = JSON.parse(text);
      record.requests.push(m);
      if (o.extraFirst) srv.send(client, o.extraFirst);
      const ok = (result) => answer(client, { jsonrpc: '2.0', id: m.id, result });
      const error = (code) =>
        answer(client, { jsonrpc: '2.0', id: m.id, error: { code, message: 'no' } });
      if (m.method === 'authenticateWithPassword') {
        record.logins += 1;
        if (o.onLogin === 'close') return void client.close();
        if (o.onLogin === 'silent') return undefined;
        if (o.onLogin === 'garbage') return void answer(client, 'HTTP/1.1 200 OK');
        if (o.onLogin === 'notJsonrpc') return void answer(client, { id: m.id, result: {} });
        if (o.onLogin === 'error') return void error(1001);
        if (m.params?.password !== o.password) return void error(1003);
        const token = `tok-${(next += 1)}`;
        record.tokens.add(token);
        return void ok(loginResult(token));
      }
      if (m.method === 'authenticateWithToken') {
        record.tokenLogins += 1;
        if (o.tokenLogin === 'silent') return undefined;
        if (o.tokenLogin === 'close') return void client.close();
        if (!record.tokens.has(m.params?.token)) return void error(1003);
        return void ok(loginResult(m.params.token));
      }
      if (m.method === 'subscribeEdges') {
        if (o.subscribeEdges === 'silent') return undefined;
        return void (o.subscribeEdges === 'error' ? error(-32601) : ok({}));
      }
      if (m.method === 'edgeRpc' && m.params?.payload?.method === 'subscribeChannels') {
        const inner = m.params.payload;
        if (o.subscribe === 'silent') return undefined;
        if (o.subscribe === 'otherId') {
          return void ok({ payload: { jsonrpc: '2.0', id: 'other', result: {} } });
        }
        if (o.subscribe === 'error') {
          return void ok({
            payload: { jsonrpc: '2.0', id: inner.id, error: { code: 1002, message: 'no' } },
          });
        }
        ok({ payload: { jsonrpc: '2.0', id: inner.id, result: {} } });
        const edgeId = m.params.edgeId;
        if (o.data === 'none') return undefined;
        if (o.data === 'otherEdge') return void push(client, 'edge9', o.values());
        if (o.data === 'empty') return void push(client, edgeId, { '_host/Hostname': 'x' });
        if (o.data === 'big') {
          return void push(client, edgeId, { ...o.values(), pad: 'x'.repeat(400_000) });
        }
        if (o.data === 'flood') {
          for (let i = 0; i < 60; i += 1) push(client, edgeId, { '_host/Hostname': 'x' });
          return undefined;
        }
        push(client, edgeId, o.values());
        return undefined;
      }
      return void error(-32601);
    },
  });
  return {
    srv,
    record,
    options: o,
    host: srv.host,
    port: srv.port,
    close: () => srv.close(),
  };
}
