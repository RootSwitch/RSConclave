import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionToMarkdown } from '../exportMd.ts';
import type { Session, TranscriptEntry } from '../types.ts';

function entry(partial: Partial<TranscriptEntry>): TranscriptEntry {
  return { id: 'x', ts: '', kind: 'participant', speaker: 'sage:30b', text: '', ...partial };
}

function chatSession(entries: TranscriptEntry[]): Session {
  return {
    id: 's1',
    mode: 'chat',
    title: 'A chat',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'done',
    config: { endpointId: 'e', model: 'sage:30b' },
    entries,
  } as Session;
}

test('export: an unbalanced code fence is closed', () => {
  // Left open, the fence swallows every later turn into one code block.
  const md = sessionToMarkdown(chatSession([
    entry({ text: 'Here is the code:\n```js\nconst x = 1;' }),
    entry({ kind: 'user', speaker: 'You', text: 'thanks' }),
  ]));
  const fences = md.match(/^[ \t]*```/gm) ?? [];
  assert.equal(fences.length % 2, 0, 'fences must be balanced');
  assert.match(md, /thanks/);
});

test('export: a balanced fence is left alone', () => {
  const md = sessionToMarkdown(chatSession([entry({ text: '```js\nconst x = 1;\n```' })]));
  assert.equal((md.match(/^[ \t]*```/gm) ?? []).length, 2);
});

test('export: reasoning becomes a visible blockquote, not invisible HTML', () => {
  const md = sessionToMarkdown(chatSession([
    entry({ text: '<think>weighing it up\nsecond line</think>The answer is 4.' }),
  ]));
  assert.doesNotMatch(md, /<think>/, 'a markdown renderer hides unknown tags entirely');
  assert.match(md, /> \*\*reasoning\*\*/);
  assert.match(md, /> weighing it up/);
  assert.match(md, /> second line/);
  assert.match(md, /The answer is 4\./);
});

test('export: an unclosed think block still exports as reasoning', () => {
  const md = sessionToMarkdown(chatSession([entry({ text: 'Lead.<think>cut off mid-thought' })]));
  assert.doesNotMatch(md, /<think>/);
  assert.match(md, /> cut off mid-thought/);
  assert.match(md, /Lead\./);
});

test('export: a user writing the tag literally keeps it', () => {
  // Their words are not reasoning output, and mangling them loses the question.
  const md = sessionToMarkdown(chatSession([
    entry({ kind: 'user', speaker: 'You', text: 'what does <think> do?' }),
  ]));
  assert.match(md, /what does <think> do\?/);
});

test('export: a cancelled turn is marked as incomplete', () => {
  const md = sessionToMarkdown(chatSession([
    entry({ text: 'half an ans', error: 'cancelled' }),
  ]));
  assert.match(md, /stopped part-way/);
});

test('export: an errored turn reports its error', () => {
  const md = sessionToMarkdown(chatSession([
    entry({ kind: 'error', text: '', error: 'Cannot reach box' }),
  ]));
  assert.match(md, /⚠ error: Cannot reach box/);
});

test('export: header carries mode, status and tags', () => {
  const s = chatSession([entry({ text: 'hi' })]);
  s.tags = ['keep', 'later'];
  const md = sessionToMarkdown(s);
  assert.match(md, /^# A chat/m);
  assert.match(md, /- Mode: chat/);
  assert.match(md, /- Status: done/);
  assert.match(md, /- Tags: keep, later/);
});

test('export: a chat with a persona carries the full system prompt, memory included', () => {
  // The transcript alone showed a model that plainly knew things with no
  // trace of how it knew them - the persona and memory layers never reached
  // the export, only the free-text field did.
  const s = chatSession([entry({ kind: 'user', speaker: 'You', text: 'hi' })]);
  const config = s.config as { personaId?: string; systemPrompt?: string };
  config.personaId = 'p1';
  config.systemPrompt = 'Session-only instructions.';
  const personas = [{
    id: 'p1', name: 'Archivist', systemPrompt: 'You keep records.',
    memories: [{ id: 'm', at: '2026-08-20T00:00:00Z', text: 'The user prefers terse answers.' }],
  }];
  const md = sessionToMarkdown(s, personas);
  assert.ok(md.includes('## System prompt'));
  assert.ok(md.includes('You keep records.'));
  assert.ok(md.includes('[2026-08-20] The user prefers terse answers.'));
  assert.ok(md.includes('Session-only instructions.'));
  // Honest about what the section is: the prompt as it renders NOW, which for
  // an evolving memory is not necessarily what every earlier turn was sent.
  assert.match(md, /memories evolve/);
});

test('export: without a persona the system prompt section is unchanged', () => {
  const s = chatSession([entry({ text: 'hi' })]);
  (s.config as { systemPrompt?: string }).systemPrompt = 'Only this.';
  const md = sessionToMarkdown(s);
  assert.ok(md.includes('## System prompt'));
  assert.ok(md.includes('Only this.'));
  assert.ok(!md.includes('memories evolve'), 'no caveat when nothing evolves');
});
