import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatMessages, buildSystemPrompt } from '../chat.ts';
import type { ChatConfig, Persona, TranscriptEntry } from '../types.ts';

const personas: Persona[] = [{ id: 'p1', name: 'Terse', systemPrompt: 'Answer in one sentence.' }];
const config: ChatConfig = { endpointId: 'e', model: 'm' };

function entry(partial: Partial<TranscriptEntry>): TranscriptEntry {
  return { id: Math.random().toString(36).slice(2), ts: '', kind: 'participant', speaker: '?', text: '', ...partial };
}

test('buildSystemPrompt: persona then free-text system prompt', () => {
  const sys = buildSystemPrompt({ ...config, personaId: 'p1', systemPrompt: 'You are offline.' }, personas);
  assert.equal(sys, 'Answer in one sentence.\n\nYou are offline.');
});

test('buildSystemPrompt: empty when neither is set', () => {
  assert.equal(buildSystemPrompt(config, personas), '');
});

test('buildChatMessages: no system message when there is no system prompt', () => {
  const msgs = buildChatMessages(config, [entry({ kind: 'user', text: 'hi' })], personas);
  assert.deepEqual(msgs, [{ role: 'user', content: 'hi' }]);
});

test('buildChatMessages: maps turns onto user/assistant in order', () => {
  const msgs = buildChatMessages({ ...config, personaId: 'p1' }, [
    entry({ kind: 'user', text: 'hi' }),
    entry({ text: 'hello' }),
    entry({ kind: 'user', text: 'again' }),
  ], personas);
  assert.deepEqual(msgs, [
    { role: 'system', content: 'Answer in one sentence.' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'again' },
  ]);
});

test('buildChatMessages: strips think blocks from assistant turns only', () => {
  const msgs = buildChatMessages(config, [
    entry({ kind: 'user', text: 'why <think> is fine in my question' }),
    entry({ text: '<think>reasoning</think>answer' }),
  ], personas);
  assert.equal(msgs[0].content, 'why <think> is fine in my question');
  assert.equal(msgs[1].content, 'answer');
});

test('buildChatMessages: errored and cancelled turns are excluded', () => {
  const msgs = buildChatMessages(config, [
    entry({ kind: 'user', text: 'hi' }),
    entry({ kind: 'error', text: '', error: 'boom' }),
    entry({ text: 'partial', error: 'cancelled' }),
    entry({ text: 'good' }),
  ], personas);
  assert.deepEqual(msgs, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'good' },
  ]);
});

test('buildChatMessages: consecutive same-role turns merge', () => {
  const msgs = buildChatMessages(config, [
    entry({ kind: 'user', text: 'one' }),
    entry({ kind: 'user', text: 'two' }),
  ], personas);
  assert.deepEqual(msgs, [{ role: 'user', content: 'one\n\ntwo' }]);
});
