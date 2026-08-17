// Fake Ollama server for testing without the GPU box.
// Run: node dev/mock-ollama.ts   (listens on 127.0.0.1:11435)
// Streams canned tokens at ~30 tok/s, honors client abort, simulates model-load delay.
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 11435);
const MODELS = ['mock-sage:30b', 'mock-scribe:13b', 'mock-jester:7b', 'mock-cutoff:7b'];

const LOREM =
  `As {model}, I have considered the question carefully. The core issue splits into three parts. ` +
  `First, the framing itself deserves scrutiny - assumptions hide there. Second, the practical ` +
  `constraints matter more than elegance. Third, any answer must survive contact with reality. ` +
  `On balance I lean toward a measured approach, noting that {model} tends to weigh caution heavily. ` +
  `In conclusion: proceed, but instrument everything and revisit after the first failure.`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/tags') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: MODELS.map((name) => ({ name, size: 1 })) }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/show') {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const model: string = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').model ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      // mock-sage has a tiny Modelfile num_ctx to exercise the truncation warning
      parameters: model.startsWith('mock-sage') ? 'num_ctx 2048\nstop "<|end|>"' : 'stop "<|end|>"',
      model_info: { 'general.architecture': 'mock', 'mock.context_length': 8192 },
    }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/ps') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: MODELS[0], size_vram: 1.5e9 }] }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const model: string = body.model ?? 'unknown';
    const numPredict: number = Number(body.options?.num_predict ?? 0) || 0;
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });

    let aborted = false;
    req.on('close', () => (aborted = true));

    // simulate model load time on first token
    await sleep(1200);

    // Two reasoning shapes on purpose: mock-sage puts <think> INLINE in
    // content (older templates); mock-scribe streams a SEPARATE thinking
    // field first (modern Ollama). Both must land in the same place.
    const text = (model.startsWith('mock-sage') ? '<think> pondering the imponderable… </think> ' : '') +
      LOREM.replaceAll('{model}', model);
    const words = text.split(' ');
    let count = 0;
    if (model.startsWith('mock-scribe')) {
      // slower cadence on purpose: a multi-second reasoning window is what
      // real reasoning models produce, and what UI checks need to catch
      for (const w of 'weighing every angle of this question with great care before committing to anything'.split(' ')) {
        if (aborted) return;
        res.write(JSON.stringify({ model, message: { role: 'assistant', content: '', thinking: w + ' ' }, done: false }) + '\n');
        count++;
        await sleep(150);
      }
    }
    for (const w of words) {
      if (aborted) return;
      res.write(JSON.stringify({ model, message: { role: 'assistant', content: w + ' ' }, done: false }) + '\n');
      count++;
      /*
       * The runner dying mid-generation: real tokens, then the connection
       * closes with NO done frame. Observed in the wild as "the model just
       * stopped mid-sentence" - an OOM-killed runner on a card that could
       * not hold the model at that context. The client must not read this
       * as a finished answer.
       */
      // res.end(), not destroy(): a CLEAN close with no done frame, which is
      // what the client cannot tell from a finished answer. A destroyed socket
      // makes fetch throw and already surfaces as an error.
      if (model.startsWith('mock-cutoff') && count > 6) return res.end();
      /*
       * The output cap. Real Ollama stops at num_predict and says
       * done_reason "length"; the mock ignored it and always finished
       * cleanly, so the commonest way a turn ends unfinished had no way to
       * be reproduced here at all.
       */
      if (numPredict > 0 && count >= numPredict) {
        res.write(JSON.stringify({ model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'length', eval_count: count, total_duration: count * 33e6 }) + '\n');
        return res.end();
      }
      await sleep(33);
    }
    res.write(JSON.stringify({ model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: count, total_duration: count * 33e6 }) + '\n');
    res.end();
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-ollama listening on http://127.0.0.1:${PORT} with models: ${MODELS.join(', ')}`);
});
