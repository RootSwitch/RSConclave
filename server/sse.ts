// SSE hub: connected browser clients, per-user broadcast, heartbeat,
// snapshot-on-connect. Every connection is tagged with the authenticated
// username so one user's tokens never stream into another user's browser.
import type { IncomingMessage, ServerResponse } from 'node:http';

interface Client {
  res: ServerResponse;
  username: string;
}

const clients = new Set<Client>();

let snapshotProvider: (username: string) => Record<string, unknown> = () => ({});

/** Register the function that produces the full-state snapshot pushed to new clients. */
export function onConnectSnapshot(fn: (username: string) => Record<string, unknown>): void {
  snapshotProvider = fn;
}

export function handleSse(req: IncomingMessage, res: ServerResponse, username: string): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // stop nginx-style reverse proxies buffering the stream
  });
  res.write(': connected\n\n');
  const client: Client = { res, username };
  clients.add(client);
  req.on('close', () => clients.delete(client));
  send(res, 'snapshot', snapshotProvider(username));
}

function send(res: ServerResponse, type: string, payload: unknown): void {
  res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/**
 * toUser scopes delivery to that user's connections; omit it only for events
 * that are truly global (there are currently none that carry content).
 */
export function broadcast(type: string, payload: unknown, toUser?: string): void {
  for (const c of clients) {
    if (toUser === undefined || c.username === toUser) send(c.res, type, payload);
  }
}

/**
 * Drop a user's live streams. A connection is authenticated once, when it opens,
 * and never re-checked - so signing out or changing your password invalidated
 * the cookie while an already-open stream carried on delivering that user's
 * tokens. Called from auth when sessions are destroyed.
 */
export function closeUserStreams(username: string): void {
  for (const c of [...clients]) {
    if (c.username !== username) continue;
    clients.delete(c);
    try {
      c.res.end();
    } catch {}
  }
}

setInterval(() => {
  for (const c of clients) c.res.write(': ping\n\n');
}, 15_000).unref();
