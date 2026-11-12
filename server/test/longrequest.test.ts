import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { errorText, longRequest } from '../longrequest.ts';
import { streamChat } from '../providers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A local server whose handler is the test's; returns its base URL. */
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

test('longRequest: a standard Response whose body streams as it arrives', async () => {
  const s = await serve(async (req, res) => {
    let got = '';
    for await (const c of req) got += c;
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'x-echo': encodeURIComponent(got) });
    res.write('one\n');
    await sleep(150);
    res.end('two\n');
  });
  try {
    const res = await longRequest(`${s.url}/api/chat`, { method: 'POST', body: '{"a":"€"}', headers: { 'content-type': 'application/json' } });
    assert.equal(res.status, 200);
    assert.equal(res.ok, true);
    assert.equal(decodeURIComponent(res.headers.get('x-echo')!), '{"a":"€"}', 'body arrived intact, multi-byte content-length included');
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), 'one\n', 'the first chunk is readable before the server finishes');
    let rest = '';
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
    assert.equal(rest, 'two\n');
  } finally {
    await s.close();
  }
});

test('longRequest: waits for late headers, which is the whole point', async () => {
  // Ollama holds its headers until the first token. The real wait that broke
  // fetch was five minutes; this only shows the wait is not cut short.
  const s = await serve(async (_req, res) => {
    await sleep(1200);
    res.writeHead(200);
    res.end('late\n');
  });
  try {
    const res = await longRequest(s.url);
    assert.equal(await res.text(), 'late\n');
  } finally {
    await s.close();
  }
});

test('longRequest: an error status still resolves, with its body readable', async () => {
  const s = await serve((_req, res) => { res.writeHead(404); res.end('{"error":"model not found"}'); });
  try {
    const res = await longRequest(s.url);
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), '{"error":"model not found"}');
  } finally {
    await s.close();
  }
});

test('longRequest: a 204 resolves with no body instead of throwing', async () => {
  const s = await serve((_req, res) => { res.writeHead(204); res.end(); });
  try {
    const res = await longRequest(s.url);
    assert.equal(res.status, 204);
    assert.equal(res.body, null);
  } finally {
    await s.close();
  }
});

test('longRequest: aborting while waiting for headers rejects and drops the connection', async () => {
  let serverSawClose = false;
  const s = await serve((req) => { req.socket.on('close', () => { serverSawClose = true; }); });
  try {
    const ac = new AbortController();
    const pending = longRequest(s.url, { signal: ac.signal });
    await sleep(100);
    ac.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await sleep(100);
    assert.equal(serverSawClose, true, 'the server must see the request go away, or Ollama keeps loading for nobody');
  } finally {
    await s.close();
  }
});

test('longRequest: cancelling the body mid-stream closes the socket, which is how Ollama stops generating', async () => {
  let serverSawClose = false;
  const s = await serve((req, res) => {
    req.socket.on('close', () => { serverSawClose = true; });
    res.writeHead(200);
    res.write('token\n'); // and never ends
  });
  try {
    const res = await longRequest(s.url);
    const reader = res.body!.getReader();
    await reader.read();
    reader.releaseLock();
    await res.body!.cancel();
    await sleep(100);
    assert.equal(serverSawClose, true);
  } finally {
    await s.close();
  }
});

test('errorText: says why, not just "fetch failed"', async () => {
  // fetch's shape: the reason is on .cause.
  const timeout = Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' });
  assert.equal(errorText(new TypeError('fetch failed', { cause: timeout })), 'fetch failed (Headers Timeout Error)');
  // A refused connect on a host with several addresses: an empty message, the text on .errors.
  const both = new AggregateError([new Error('connect ECONNREFUSED ::1:11434'), new Error('connect ECONNREFUSED 127.0.0.1:11434')], '');
  assert.equal(errorText(both), 'connect ECONNREFUSED ::1:11434; connect ECONNREFUSED 127.0.0.1:11434');
  assert.equal(errorText(Object.assign(new Error(''), { code: 'ECONNRESET' })), 'ECONNRESET');
  assert.equal(errorText('plain string'), 'plain string');
});

test('longRequest: a refused connection reports the address and the reason', async () => {
  const s = await serve(() => {});
  const url = s.url;
  await s.close(); // nothing listens on that port now
  await assert.rejects(longRequest(url), (err: unknown) => /ECONNREFUSED/.test(errorText(err)));
});

/* ---------- streamChat through it ---------- */

const ollamaEndpoint = (url: string) => ({ id: 'box', name: 'box', baseUrl: url, kind: 'ollama' as const });

test('streamChat: an Ollama that holds its headers until the first token still streams the turn', async () => {
  const s = await serve(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    await sleep(800); // "loading" and "reading the prompt": nothing at all on the wire
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { content: 'Hello' }, done: false }) + '\n');
    res.end(JSON.stringify({ message: { content: ' there' }, done: true, done_reason: 'stop', eval_count: 2, eval_duration: 1e8 }) + '\n');
  });
  try {
    let firstTokens = 0;
    const out = await streamChat({
      endpoint: ollamaEndpoint(s.url), model: 'm', messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal, onDelta: () => {}, onFirstToken: () => { firstTokens++; },
    });
    assert.equal(out.text, 'Hello there');
    assert.equal(out.doneReason, 'stop');
    assert.equal(out.stats.evalCount, 2);
    assert.equal(firstTokens, 1);
  } finally {
    await s.close();
  }
});

test('streamChat: an unreachable box says why it could not be reached', async () => {
  const s = await serve(() => {});
  const url = s.url;
  await s.close();
  await assert.rejects(
    streamChat({ endpoint: ollamaEndpoint(url), model: 'm', messages: [], signal: new AbortController().signal, onDelta: () => {} }),
    (err: Error) => err.message.startsWith(`Cannot reach box (${url}/api/chat): `) && /ECONNREFUSED/.test(err.message) && !/fetch failed/.test(err.message),
  );
});

test('streamChat: Cancel during the wait for headers is a cancel, not "Cannot reach"', async () => {
  const s = await serve(() => { /* never answers */ });
  try {
    const ac = new AbortController();
    const pending = streamChat({ endpoint: ollamaEndpoint(s.url), model: 'm', messages: [], signal: ac.signal, onDelta: () => {} });
    await sleep(100);
    ac.abort();
    await assert.rejects(pending, (err: Error) => !/Cannot reach/.test(err.message));
  } finally {
    await s.close();
  }
});
