import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Persona, RoundtableConfig, TranscriptEntry } from '../types.ts';
import { DEFAULT_COMPACT_TEMPLATE, DEFAULT_SUMMARIZE_TEMPLATE } from '../types.ts';
import { memoryTokens, renderMemoryLayer, renderMemoryPlain } from '../memory.ts';
import { buildChatMessages, buildSystemPrompt } from '../chat.ts';
import { buildSystemPrompt as buildRoundtablePrompt } from '../roundtable.ts';
import { fillTemplate, renderTranscriptText } from '../text.ts';

const remembering: Persona = {
  id: 'p1',
  name: 'Archivist',
  systemPrompt: 'You keep records.',
  memories: [
    { id: 'm1', at: '2026-08-20T10:00:00.000Z', text: 'The user runs a 3090 and prefers Q4_K_M quants.', model: 'mock' },
    { id: 'm2', at: '2026-08-23T09:30:00.000Z', text: 'Decided to hold RSOperator until the memory feature lands.' },
  ],
};
const forgetful: Persona = { id: 'p2', name: 'Blank', systemPrompt: 'You are new here.' };

function entry(partial: Partial<TranscriptEntry>): TranscriptEntry {
  return { id: Math.random().toString(36).slice(2), ts: '', kind: 'participant', speaker: '?', text: '', ...partial };
}

test('memory: nothing rendered for a persona with no memories', () => {
  assert.equal(renderMemoryLayer(forgetful), '');
  assert.equal(renderMemoryPlain(forgetful), '');
  assert.equal(memoryTokens(forgetful), 0);
  assert.equal(renderMemoryLayer({ memories: [] }), '');
});

test('memory: entries are dated by day and framed as remembered, not instructed', () => {
  const layer = renderMemoryLayer(remembering);
  assert.match(layer, /^Things you remember from earlier conversations/);
  assert.match(layer, /summaries .* not verbatim/);
  assert.ok(layer.includes('[2026-08-20] The user runs a 3090'));
  assert.ok(layer.includes('[2026-08-23] Decided to hold'));
  assert.ok(!layer.includes('10:00'), 'the time of day is noise in a memory');
  // The plain form is the entries alone, for {{MEMORY}} in a template.
  const plain = renderMemoryPlain(remembering);
  assert.ok(plain.startsWith('[2026-08-20]'));
  assert.ok(!plain.includes('Things you remember'));
  assert.ok(memoryTokens(remembering) > 20);
});

test('memory: a blank entry is dropped rather than rendered as a bare date', () => {
  const p = { memories: [{ id: 'x', at: '2026-08-01T00:00:00Z', text: '   ' }] };
  assert.equal(renderMemoryPlain(p), '');
  assert.equal(renderMemoryLayer(p), '');
});

test('chat: the layers go persona, memory, then the session prompt', () => {
  const sys = buildSystemPrompt(
    { endpointId: 'e', model: 'm', personaId: 'p1', systemPrompt: 'Today: be brief.' },
    [remembering],
  );
  const iPersona = sys.indexOf('You keep records.');
  const iMemory = sys.indexOf('Things you remember');
  const iSession = sys.indexOf('Today: be brief.');
  assert.ok(iPersona >= 0 && iMemory > iPersona && iSession > iMemory, sys);
});

test('chat: a persona without memories adds no memory layer', () => {
  const sys = buildSystemPrompt({ endpointId: 'e', model: 'm', personaId: 'p2' }, [forgetful]);
  assert.equal(sys, 'You are new here.');
});

test('roundtable: a seat wearing the persona remembers too, between persona and overlay', () => {
  const config: RoundtableConfig = {
    participants: [
      { id: 'a', name: 'A', endpointId: 'e', model: 'm', personaId: 'p1', overlayPrompt: 'Argue for it.' },
      { id: 'b', name: 'B', endpointId: 'e', model: 'm' },
    ],
    scenario: 'A debate.',
    turnOrder: 'round-robin',
  };
  const sys = buildRoundtablePrompt(config.participants[0], config, [remembering]);
  const iPersona = sys.indexOf('You keep records.');
  const iMemory = sys.indexOf('Things you remember');
  const iOverlay = sys.indexOf('Argue for it.');
  assert.ok(iPersona >= 0 && iMemory > iPersona && iOverlay > iMemory, sys);
});

test('summariser input: the transcript carries neither the system prompt nor the memory', () => {
  // The memory lives in the persona record and the system prompt; neither is
  // an entry, so the text a summariser reads cannot contain them. That is
  // what lets the summariser be told "record only what is new" without being
  // asked to ignore something it can see.
  const entries = [
    entry({ kind: 'user', speaker: 'You', text: 'What quant should I use?' }),
    entry({ speaker: 'mock', text: 'As you told me before, you prefer Q4_K_M.' }),
  ];
  const transcript = renderTranscriptText(entries);
  assert.ok(!transcript.includes('Things you remember'));
  assert.ok(!transcript.includes('You keep records.'));
  assert.ok(transcript.includes('[You]: What quant'));
});

test('chat history: a summary is not sent back to the model as a turn', () => {
  const entries = [
    entry({ kind: 'user', speaker: 'You', text: 'hello' }),
    entry({ speaker: 'mock', text: 'hi there' }),
    entry({ kind: 'consolidation', speaker: 'mock', model: 'mock', text: 'The user said hello.' }),
    entry({ kind: 'user', speaker: 'You', text: 'and again' }),
  ];
  const msgs = buildChatMessages({ endpointId: 'e', model: 'm' }, entries, []);
  assert.deepEqual(msgs.map((m) => m.content), ['hello', 'hi there', 'and again']);
});

test('fillTemplate: every placeholder is filled, and $ in a value stays literal', () => {
  const out = fillTemplate('A:{{MEMORY}} B:{{TRANSCRIPT}} C:{{MEMORY}}', {
    MEMORY: 'costs $5 & more',
    TRANSCRIPT: "it's $&",
  });
  assert.equal(out, "A:costs $5 & more B:it's $& C:costs $5 & more");
});

test('default templates: the summariser sees the memory and is asked for the delta; the compactor sees only the memory', () => {
  assert.ok(DEFAULT_SUMMARIZE_TEMPLATE.includes('{{TRANSCRIPT}}'));
  assert.ok(DEFAULT_SUMMARIZE_TEMPLATE.includes('{{MEMORY}}'));
  assert.match(DEFAULT_SUMMARIZE_TEMPLATE, /only what is NEW/);
  assert.ok(DEFAULT_COMPACT_TEMPLATE.includes('{{MEMORY}}'));
  assert.ok(!DEFAULT_COMPACT_TEMPLATE.includes('{{TRANSCRIPT}}'));
  assert.match(DEFAULT_COMPACT_TEMPLATE, /shorter than the input/i);
});
