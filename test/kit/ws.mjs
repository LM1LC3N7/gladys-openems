// Copied from ~/code/ref/gladys-testkit (src/ws.mjs, Apache-2.0, same author),
// with `ws` imported from this repo: a minimal WebSocket device on 127.0.0.1.

import { WebSocketServer } from 'ws';

export const HOST = '127.0.0.1';

/**
 * - onConnection(client, request): what to send at once, or nothing;
 * - onMessage(text, client): the answer (object -> JSON, string), or nothing.
 */
export async function wsServer({ onConnection, onMessage, ...options } = {}) {
  const wss = new WebSocketServer({ host: HOST, port: 0, ...options });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  const send = (client, data) => {
    if (data != null) {
      client.send(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
    }
  };
  const srv = {
    host: HOST,
    port: wss.address().port,
    url: '',
    connections: 0,
    clients: wss.clients,
    /** { at, data (text) } of every message received. */
    messages: [],
    send,
    broadcast(data) {
      for (const client of wss.clients) send(client, data);
    },
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(() => resolve()));
    },
  };
  srv.url = `ws://${HOST}:${srv.port}`;
  wss.on('connection', (client, request) => {
    srv.connections += 1;
    client.on('error', () => {});
    client.on('message', async (raw) => {
      const data = raw.toString();
      srv.messages.push({ at: performance.now(), data });
      send(client, await onMessage?.(data, client));
    });
    send(client, onConnection?.(client, request));
  });
  return srv;
}
