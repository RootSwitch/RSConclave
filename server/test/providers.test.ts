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

/* ---------- reasoning: only the settings a model honours, think on the wire ---------- */

test('parseModelInfo: reasoning choices are read from what the template actually consults', async () => {
  const { parseModelInfo } = await import('../providers.ts');
  const choices = (data: object) => parseModelInfo({ capabilities: ['thinking'], ...data }).thinkChoices;
  // Excerpts of the real templates on a 3090.
  const gptOss = '{{- if and .IsThinkSet .Think (ne .ThinkLevel "") }}\nReasoning: {{ .ThinkLevel }}\n{{- end }}';
  const qwen36 = '{{- if .Think }}<think>\n{{ .Thinking }}\n</think>{{ end }}';
  const qwen38 = "{%- if enable_thinking is undefined or enable_thinking is true %}\n"
    + "{%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}\n"
    + "{%- if resolved_reasoning_effort == 'high' %}\n"
    + "{%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}";
  const hyMemory = "{%- if not reasoning_effort is defined or reasoning_effort not in ['high', 'low', 'no_think'] %}";
  const flint = '{%- macro flint_text(t) -%}{{- t | replace("\\x00", "") }}{%- endmacro %}<think>';
  const gguf = { template_source: 'gguf_chat_template' };
  // Ollama's Go templates: gpt-oss takes levels but cannot stop reasoning; qwen3.6 only switches.
  assert.deepEqual(choices({ template: gptOss, details: { family: 'gptoss' } }), ['low', 'medium', 'high']);
  assert.deepEqual(choices({ template: qwen36 }), ['off', 'on']);
  // GGUF templates: off only where enable_thinking is read, and only the levels named.
  assert.deepEqual(choices({ template: qwen38, ...gguf }), ['off', 'low', 'medium', 'high']);
  assert.deepEqual(choices({ template: hyMemory, ...gguf }), ['low', 'high'], 'medium would mean no_think');
  assert.deepEqual(choices({ template: flint, ...gguf }), ['on'], 'no switch at all: nothing to choose');
  // A model that does not think has nothing to choose.
  assert.deepEqual(parseModelInfo({ template: qwen36 }).thinkChoices, []);
  assert.deepEqual(parseModelInfo({}).thinkChoices, []);
});

test('parseModelInfo: what Ollama states about reasoning outranks the template', async () => {
  const { parseModelInfo } = await import('../providers.ts');
  // Ollama 0.40.11's own words for three models it renders itself.
  const gptOss = parseModelInfo({ thinking: { values: ['low', 'medium', 'high'], default: 'medium' }, template: '{{ .Prompt }}' });
  assert.deepEqual(gptOss.thinkChoices, ['low', 'medium', 'high']);
  assert.equal(gptOss.thinkDefault, 'medium');
  const nemotron = parseModelInfo({ thinking: { values: [false, true], default: true }, capabilities: ['thinking'] });
  assert.deepEqual(nemotron.thinkChoices, ['off', 'on']);
  assert.equal(nemotron.thinkDefault, 'on');
  // qwen3-coder: thinking off is its only value, so there is nothing to choose.
  assert.deepEqual(parseModelInfo({ thinking: { values: [false], default: false } }).thinkChoices, ['off']);
  assert.equal(parseModelInfo({}).thinkDefault, null);
});

test('thinkParam: the seat choice becomes Ollama\'s think field, or is left out', async () => {
  const { thinkParam } = await import('../providers.ts');
  assert.equal(thinkParam('off'), false);
  assert.equal(thinkParam('on'), true);
  assert.equal(thinkParam('low'), 'low');
  assert.equal(thinkParam('medium'), 'medium');
  assert.equal(thinkParam('high'), 'high');
  // Absent means the model's own default, as every seat had before this.
  assert.equal(thinkParam(undefined), undefined);
  // A stored value from an edited config is dropped, never sent as-is.
  assert.equal(thinkParam('xhigh'), undefined);
  assert.equal(thinkParam(true), undefined);
});
