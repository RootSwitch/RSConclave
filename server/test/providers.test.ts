import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLines } from '../providers.ts';

function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        const c = chunks[i++];
        controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
      } else controller.close();
    },
  });
}

async function collect(chunks: (string | Uint8Array)[]): Promise<string[]> {
  const out: string[] = [];
  const ac = new AbortController();
  for await (const line of readLines(streamOf(chunks), ac.signal)) out.push(line);
  return out;
}

test('readLines: simple lines', async () => {
  assert.deepEqual(await collect(['a\nb\n']), ['a', 'b']);
});

test('readLines: line split across chunks', async () => {
  assert.deepEqual(await collect(['{"x":', '1}\n{"y":2', '}\n']), ['{"x":1}', '{"y":2}']);
});

test('readLines: CRLF handled', async () => {
  assert.deepEqual(await collect(['a\r\nb\r\n']), ['a', 'b']);
});

test('readLines: trailing line without newline still yielded', async () => {
  assert.deepEqual(await collect(['a\nb']), ['a', 'b']);
});

test('readLines: multi-byte char split across chunk boundary', async () => {
  const bytes = new TextEncoder().encode('héllo\n'); // é is 2 bytes
  const split = 2; // cut inside the é
  const lines = await collect([bytes.slice(0, split), bytes.slice(split)]);
  assert.deepEqual(lines, ['héllo']);
});

test('readLines: many lines in one chunk', async () => {
  assert.deepEqual(await collect(['a\nb\nc\nd\n']), ['a', 'b', 'c', 'd']);
});

test('parseModelInfo: extracts arch context_length and Modelfile num_ctx', async () => {
  const { parseModelInfo } = await import('../providers.ts');
  const info = parseModelInfo({
    parameters: 'stop "<|im_end|>"\nnum_ctx 8192\ntemperature 0.7',
    model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 262144, 'qwen3.rope.freq_base': 1000000 },
  });
  assert.deepEqual(info, { contextLength: 262144, numCtx: 8192 });
});

test('parseModelInfo: no Modelfile num_ctx → null (server default applies)', async () => {
  const { parseModelInfo } = await import('../providers.ts');
  const info = parseModelInfo({
    parameters: 'stop "<|end|>"',
    model_info: { 'llama.context_length': 131072 },
  });
  assert.deepEqual(info, { contextLength: 131072, numCtx: null });
});

test('parseModelInfo: degenerate response → nulls', async () => {
  const { parseModelInfo } = await import('../providers.ts');
  assert.deepEqual(parseModelInfo({}), { contextLength: null, numCtx: null });
});

test('thinkNormalizer: separate thinking then content becomes inline tags', async () => {
  const { makeThinkNormalizer } = await import('../providers.ts');
  let out = '';
  const n = makeThinkNormalizer((d) => { out += d; });
  n.thinking('hmm ');
  n.thinking('okay ');
  n.content('The answer ');
  n.content('is 4.');
  n.finish();
  assert.equal(out, '<think>hmm okay </think>\nThe answer is 4.');
});

test('thinkNormalizer: content-only stream is untouched', async () => {
  const { makeThinkNormalizer } = await import('../providers.ts');
  let out = '';
  const n = makeThinkNormalizer((d) => { out += d; });
  n.content('plain ');
  n.content('answer');
  n.finish();
  assert.equal(out, 'plain answer');
});

test('thinkNormalizer: thinking-only stream (cancelled mid-think) still closes the tag', async () => {
  const { makeThinkNormalizer } = await import('../providers.ts');
  let out = '';
  const n = makeThinkNormalizer((d) => { out += d; });
  n.thinking('endless pondering');
  n.finish();
  assert.equal(out, '<think>endless pondering</think>');
});

test('thinkNormalizer: empty deltas open nothing', async () => {
  const { makeThinkNormalizer } = await import('../providers.ts');
  let out = '';
  const n = makeThinkNormalizer((d) => { out += d; });
  n.thinking('');
  n.content('answer');
  n.finish();
  assert.equal(out, 'answer');
});
