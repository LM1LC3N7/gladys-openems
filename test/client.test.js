// -----------------------------------------------------------------------------
// The client against a fake OpenEMS Edge on 127.0.0.1 (a real WebSocket
// server): the requests of a read, one at a time; a wrong password; every
// odd answer; the bounds; one connection at a time, closed before the read
// ends; the password never leaves but in the log-in request.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { OpenemsClient, edgeOf, urlOf } from '../src/openems/client.js';
import { edgeValues, startFakeEdge } from './helpers/fakeEdge.js';

const PASSWORD = 'user';
/** Short delays: a silent Edge ends a read in 0.3 s instead of 8 s. */
const client = () =>
  new OpenemsClient({ timeouts: { connect: 1000, answer: 300, data: 300, session: 3000 } });

async function edge(t, options) {
  const fake = await startFakeEdge(options);
  t.after(() => fake.close());
  return fake;
}

const creds = (fake, password = PASSWORD) => ({
  host: fake.host,
  port: fake.port,
  username: 'x',
  password,
});

const codeOf = async (promise) => {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return err.code;
  }
};

test('the URL of an address: port 8085 at /, port 80 at /websocket, IPv6 in brackets', () => {
  assert.equal(urlOf({ host: '192.168.1.60', port: 8085 }), 'ws://192.168.1.60:8085/');
  assert.equal(urlOf({ host: 'fems.local', port: 80 }), 'ws://fems.local:80/websocket');
  assert.equal(urlOf({ host: 'fe80::1', port: 8085 }), 'ws://[fe80::1]:8085/');
});

test('the Edge of a log-in answer: id, version and role, checked', () => {
  assert.deepEqual(edgeOf({ edges: [{ id: '0', version: '2026.7.2', role: 'GUEST' }] }), {
    id: '0',
    version: '2026.7.2',
    role: 'guest',
  });
  assert.deepEqual(edgeOf({}), { id: '0', version: undefined, role: undefined });
  assert.deepEqual(edgeOf({ edges: [{ id: 'a b', version: '<x>', role: 'root' }] }), {
    id: '0',
    version: undefined,
    role: undefined,
  });
});

test('a read: log-in, subscribeEdges, subscribeChannels, the first data, closed', async (t) => {
  const fake = await edge(t);
  const reader = client();
  const answer = await reader.read(creds(fake));
  assert.deepEqual(answer.edge, { id: '0', version: '2026.7.2', role: 'guest' });
  assert.equal(answer.params['_sum/EssSoc'], 77);
  assert.equal(answer.params['_host/Hostname'], 'fems12345');
  assert.deepEqual(
    fake.record.requests.map((m) => m.method),
    ['authenticateWithPassword', 'subscribeEdges', 'edgeRpc'],
  );
  const sub = fake.record.requests[2].params;
  assert.equal(sub.edgeId, '0');
  assert.equal(sub.payload.method, 'subscribeChannels');
  assert.ok(sub.payload.params.channels.includes('_sum/ProductionActiveEnergy'));
  // The password only in the log-in request.
  const others = fake.record.requests.slice(1).map((m) => JSON.stringify(m));
  assert.ok(others.every((text) => !text.includes(PASSWORD)));
  // Closed when the read resolves: a new connection only after.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.record.open, 0);
  assert.equal(fake.record.maxOpen, 1);
});

test('one request at a time: each answer awaited before the next request', async (t) => {
  const fake = await edge(t, { latencyMs: 30 });
  const answer = await client().read(creds(fake));
  assert.equal(answer.edge.id, '0');
  const at = fake.srv.messages.map((m) => m.at);
  assert.equal(at.length, 3);
  // Each request after the 30 ms answer of the previous one.
  assert.ok(at[1] - at[0] >= 25 && at[2] - at[1] >= 25, at.join(' '));
});

test('a wrong password is "refused" (1003); another error on the log-in is not', async (t) => {
  const fake = await edge(t);
  assert.equal(await codeOf(client().read(creds(fake, 'wrong'))), 'refused');
  const other = await edge(t, { onLogin: 'error' });
  assert.equal(await codeOf(client().read(creds(other))), 'protocol');
});

test('closed or silent at the log-in: "closed" / "timeout", never "refused"', async (t) => {
  const closed = await edge(t, { onLogin: 'close' });
  assert.equal(await codeOf(client().read(creds(closed))), 'closed');
  const silent = await edge(t, { onLogin: 'silent' });
  const started = performance.now();
  assert.equal(await codeOf(client().read(creds(silent))), 'timeout');
  assert.ok(performance.now() - started < 2_000);
});

test('an answer that is not JSON-RPC 2.0 is "protocol" (the envelope first)', async (t) => {
  for (const onLogin of ['garbage', 'notJsonrpc']) {
    const fake = await edge(t, { onLogin });
    assert.equal(await codeOf(client().read(creds(fake))), 'protocol', onLogin);
  }
});

test('subscribeEdges answered with an error is ignored (secondary)', async (t) => {
  const fake = await edge(t, { subscribeEdges: 'error' });
  const answer = await client().read(creds(fake));
  assert.equal(answer.params['_sum/EssSoc'], 77);
});

test('the channels refused after the log-in: "denied", not a refusal of the password', async (t) => {
  const fake = await edge(t, { subscribe: 'error' });
  assert.equal(await codeOf(client().read(creds(fake))), 'denied');
});

test('data of another Edge, or without any value, never ends a read as alive', async (t) => {
  for (const data of ['otherEdge', 'empty', 'none']) {
    const fake = await edge(t, { data });
    assert.equal(await codeOf(client().read(creds(fake))), 'timeout', data);
  }
});

test('an answer of another request id is not ours', async (t) => {
  const fake = await edge(t, {
    extraFirst: { jsonrpc: '2.0', id: 'not-ours', result: { edges: [{ id: 'evil' }] } },
  });
  const answer = await client().read(creds(fake));
  assert.equal(answer.edge.id, '0');
});

test('a message over 256 KiB is cut from its header; a flood ends the session', async (t) => {
  const big = await edge(t, { data: 'big' });
  assert.equal(await codeOf(client().read(creds(big))), 'protocol');
  const flood = await edge(t, { data: 'flood' });
  assert.equal(await codeOf(client().read(creds(flood))), 'protocol');
});

test('an HTTP server, not a WebSocket: "protocol"; a closed port: "unreachable"', async (t) => {
  const server = createServer((req, res) => res.end('<html>'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const reader = client();
  assert.equal(
    await codeOf(reader.read({ host: '127.0.0.1', port, username: 'x', password: 'p' })),
    'protocol',
  );
  server.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    await codeOf(reader.read({ host: '127.0.0.1', port, username: 'x', password: 'p' })),
    'unreachable',
  );
});

test('one session at a time: a second read is "busy"; abort cuts the first', async (t) => {
  const fake = await edge(t, { data: 'none' });
  const reader = client();
  const first = reader.read(creds(fake));
  assert.equal(await codeOf(reader.read(creds(fake))), 'busy');
  await new Promise((resolve) => setTimeout(resolve, 50));
  reader.abort();
  assert.equal(await codeOf(first), 'aborted');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.record.open, 0);
  assert.equal(fake.record.maxOpen, 1);
  // And the next read works.
  fake.options.data = undefined;
  const answer = await reader.read(creds(fake));
  assert.deepEqual(answer.params['_sum/EssSoc'], edgeValues()['_sum/EssSoc']);
});
