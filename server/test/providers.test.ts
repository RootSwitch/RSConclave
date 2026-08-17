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
test('parseModelInfo: reads the whole show response, not just the context numbers', async () => {
  const { parseModelInfo } = await import('../providers.ts');
  // Real /api/show shape: parameters is column-padded text, and `stop` repeats.
  const info = parseModelInfo({
    parameters: 'stop                           "<|im_start|>"\nstop                           "<|im_end|>"\nnum_ctx                        262144\ntemperature                    0.7',
    details: { parameter_size: '33.4B', quantization_level: 'Q4_K_M', family: 'laguna' },
    capabilities: ['completion', 'tools', 'thinking'],
    model_info: { 'general.architecture': 'laguna', 'laguna.context_length': 262144 },
  });
  assert.equal(info.contextLength, 262144);
  assert.equal(info.numCtx, 262144);
  assert.equal(info.quantization, 'Q4_K_M');
  assert.equal(info.parameterSize, '33.4B');
  assert.deepEqual(info.capabilities, ['completion', 'tools', 'thinking']);
  assert.equal(info.params.temperature, '0.7');
  // Both stop sequences survive; keeping only the last would misreport the model.
  assert.equal(info.params.stop, '"<|im_start|>" "<|im_end|>"');
});

test('parseModelInfo: no Modelfile num_ctx -> null (server default applies)', async () => {
  const { parseModelInfo } = await import('../providers.ts');
  const info = parseModelInfo({
    parameters: 'stop                           "<|end|>"',
    model_info: { 'llama.context_length': 131072 },
  });
  assert.equal(info.contextLength, 131072);
  assert.equal(info.numCtx, null);
  // Absent, not zero: Ollama omits an unset temperature and its own default
  // applies, so reporting a number here would be inventing one.
  assert.equal(info.params.temperature, undefined);
});

test('parseModelInfo: degenerate response -> nulls, never undefined fields', async () => {
  const { parseModelInfo } = await import('../providers.ts');
  const info = parseModelInfo({});
  assert.equal(info.contextLength, null);
  assert.equal(info.numCtx, null);
  assert.equal(info.quantization, null);
  assert.deepEqual(info.capabilities, []);
  assert.deepEqual(info.params, {});
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
