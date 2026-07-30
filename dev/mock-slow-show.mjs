// Ollama stub whose /api/show is deliberately SLOW.
//
// It exists to make one specific window observable: runTurn calls getModelInfo
// (a POST /api/show) on the way to starting a generation, and the guards that
// stop a second generation key off phase === 'generating'. Whatever happens
// before that phase is set is a window where every guard passes. A real box
// gives you the same window on a model's first use; this makes it wide enough
// to hit by hand.
//
//   MOCK_PORT=11436 SHOW_DELAY=2500 node dev/mock-slow-show.mjs
import http from 'node:http';
const PORT = Number(process.env.MOCK_PORT ?? 11436);
const SHOW_DELAY = Number(process.env.SHOW_DELAY ?? 2500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let chatCalls = 0;

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const read = async () => { const c = []; for await (const x of req) c.push(x); return JSON.parse(Buffer.concat(c).toString() || '{}'); };

  if (url.pathname === '/api/tags') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ models: [{ name: 'slow:7b', size: 1 }] }));
  }
  if (url.pathname === '/api/show') {
    await read();
    await sleep(SHOW_DELAY); // the window
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ parameters: 'num_ctx 8192', model_info: { 'llama.context_length': 8192 } }));
  }
  if (url.pathname === '/api/ps') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ models: [] }));
  }
  if (url.pathname === '/api/chat') {
    await read();
    const n = ++chatCalls;
    console.log(`  [stub] /api/chat call #${n}`);
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    for (let i = 0; i < 6; i++) {
      res.write(JSON.stringify({ model: 'slow:7b', message: { role: 'assistant', content: `t${i} ` }, done: false }) + '\n');
      await sleep(120);
    }
    res.write(JSON.stringify({ model: 'slow:7b', message: { role: 'assistant', content: '' }, done: true, eval_count: 6 }) + '\n');
    return res.end();
  }
  res.writeHead(404).end('{}');
}).listen(PORT, '127.0.0.1', () => console.log(`slow-show stub on :${PORT} (show delay ${SHOW_DELAY}ms)`));
