import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConsolidatorPrompt, buildMemberHistory, buildMemberSystemPrompt, joinedPrompts, renderResponses, renderTemplate } from '../council.ts';
import type { Persona } from '../types.ts';

const personas: Persona[] = [{
  id: 'terse', name: 'Terse', systemPrompt: 'Answer directly.',
  memories: [{ id: 'm', at: '2026-08-20T00:00:00Z', text: 'The user prefers Q4_K_M quants.' }],
}];
import type { CouncilConfig, TranscriptEntry } from '../types.ts';

const config: CouncilConfig = {
  prompt: 'Is a hotdog a sandwich?',
  members: [
    { endpointId: 'e', model: 'sage:30b' },
    { endpointId: 'e', model: 'jester:7b' },
  ],
  consolidator: { endpointId: 'e', model: 'sage:30b', template: 'P: {{PROMPT}}\nR:\n{{RESPONSES}}' },
};

function entry(partial: Partial<TranscriptEntry>): TranscriptEntry {
  return { id: 'x', ts: '', kind: 'participant', speaker: '?', text: '', ...partial };
}

test('renderResponses: labels each member block with its model', () => {
  const entries = [
    entry({ memberIndex: 0, text: 'Yes.' }),
    entry({ memberIndex: 1, text: 'It is a taco.' }),
  ];
  const out = renderResponses(config, entries);
  assert.ok(out.includes('=== RESPONSE FROM: sage:30b ===\nYes.'));
  assert.ok(out.includes('=== RESPONSE FROM: jester:7b ===\nIt is a taco.'));
});

test('renderResponses: errored/missing members noted', () => {
  const entries = [entry({ memberIndex: 0, text: 'Yes.' })];
  const out = renderResponses(config, entries);
  assert.ok(out.includes('=== RESPONSE FROM: jester:7b ===\n(no response - error)'));
});

/*
 * Found in live use, not by inspection: a 120-token cap on a reasoning model
 * produced a 554-character entry whose readable part was empty, because the
 * whole budget went inside <think>. The old gate tested the RAW text, so that
 * counted as a response and the consolidator was handed an empty labelled
 * block to summarise - which it dutifully did.
 */
test('renderResponses: a model that only thought did not answer', () => {
  const entries = [
    entry({ memberIndex: 0, text: '<think>Let me weigh both sides carefully.</think>' }),
    entry({ memberIndex: 1, text: 'It is a taco.' }),
  ];
  const out = renderResponses(config, entries);
  assert.ok(
    out.includes('=== RESPONSE FROM: sage:30b ===\n(no answer - the model used its whole output budget reasoning)'),
    'a think-only entry must not be presented as an answer');
  assert.ok(!out.includes('=== RESPONSE FROM: sage:30b ===\n\n'),
    'and must never render as an empty block');
  assert.ok(out.includes('=== RESPONSE FROM: jester:7b ===\nIt is a taco.'),
    'the real answer still comes through');
});

test('renderResponses: thinking is stripped but the answer after it survives', () => {
  const entries = [entry({ memberIndex: 0, text: '<think>weighing</think>\n\nYes, narrowly.' })];
  const out = renderResponses(config, entries);
  assert.ok(out.includes('=== RESPONSE FROM: sage:30b ===\nYes, narrowly.'));
  assert.ok(!out.includes('weighing'));
});

test('renderResponses: rerun replaces earlier response (last entry wins)', () => {
  const entries = [
    entry({ memberIndex: 0, text: 'First try.' }),
    entry({ memberIndex: 1, text: 'B.' }),
    entry({ memberIndex: 0, text: 'Second try.' }),
  ];
  const out = renderResponses(config, entries);
  assert.ok(out.includes('Second try.'));
  assert.ok(!out.includes('First try.'));
});

test('renderTemplate: replaces all placeholders', () => {
  const out = renderTemplate('{{PROMPT}} + {{PROMPT}} / {{RESPONSES}}', 'p', 'r');
  assert.equal(out, 'p + p / r');
});

test('buildConsolidatorPrompt: template override wins', () => {
  const out = buildConsolidatorPrompt(config, [entry({ memberIndex: 0, text: 'Yes.' })], 'OVERRIDE {{PROMPT}}');
  assert.ok(out.startsWith('OVERRIDE Is a hotdog'));
});

test('buildMemberHistory: initial round is just the prompt', () => {
  const entries = [entry({ kind: 'user', speaker: 'User', text: 'Q1' })];
  assert.deepEqual(buildMemberHistory(entries, 0), [{ role: 'user', content: 'Q1' }]);
});

test('buildMemberHistory: follow-up round includes own prior answer only', () => {
  const entries = [
    entry({ kind: 'user', speaker: 'User', text: 'Q1' }),
    entry({ memberIndex: 0, text: 'A1 from me' }),
    entry({ memberIndex: 1, text: 'A1 from other' }),
    entry({ kind: 'consolidation', memberIndex: -1, text: 'synthesis' }),
    entry({ kind: 'user', speaker: 'User', text: 'Q2' }),
  ];
  assert.deepEqual(buildMemberHistory(entries, 0), [
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: 'A1 from me' },
    { role: 'user', content: 'Q2' },
  ]);
});

test('buildMemberHistory: rerun replaces earlier answer and think is stripped', () => {
  const entries = [
    entry({ kind: 'user', speaker: 'User', text: 'Q1' }),
    entry({ memberIndex: 0, text: 'first try' }),
    entry({ memberIndex: 0, text: '<think>reason</think>second try' }),
    entry({ kind: 'user', speaker: 'User', text: 'Q2' }),
  ];
  assert.deepEqual(buildMemberHistory(entries, 0), [
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: 'second try' },
    { role: 'user', content: 'Q2' },
  ]);
});

test('buildMemberHistory: pending answer after final prompt is dropped (rerun case)', () => {
  const entries = [
    entry({ kind: 'user', speaker: 'User', text: 'Q1' }),
    entry({ memberIndex: 0, text: 'about to be rerolled' }),
  ];
  assert.deepEqual(buildMemberHistory(entries, 0), [{ role: 'user', content: 'Q1' }]);
});

test('joinedPrompts: single and multiple prompts', () => {
  assert.equal(joinedPrompts([entry({ kind: 'user', text: 'Q1' })]), 'Q1');
  assert.equal(
    joinedPrompts([entry({ kind: 'user', text: 'Q1' }), entry({ kind: 'user', text: 'Q2' })]),
    'Q1\n\nFOLLOW-UP:\nQ2',
  );
});

test('buildMemberSystemPrompt: nothing for a member without a persona', () => {
  // The council default is the bare prompt. That is what makes one member's
  // answer comparable with another's, so a persona has to be asked for.
  assert.equal(buildMemberSystemPrompt({ endpointId: 'e', model: 'm' }, personas), '');
  assert.equal(buildMemberSystemPrompt({ endpointId: 'e', model: 'm', personaId: 'nope' }, personas), '');
});

test('buildMemberSystemPrompt: persona then its memories, as everywhere else', () => {
  const sys = buildMemberSystemPrompt({ endpointId: 'e', model: 'm', personaId: 'terse' }, personas);
  const iPrompt = sys.indexOf('Answer directly.');
  const iMemory = sys.indexOf('Things you remember');
  assert.ok(iPrompt >= 0 && iMemory > iPrompt, sys);
  assert.ok(sys.includes('prefers Q4_K_M'));
});

test('buildMemberHistory: a system prompt rides ahead of the history', () => {
  const entries = [
    entry({ kind: 'user', speaker: 'You', text: 'Q1' }),
    entry({ kind: 'participant', memberIndex: 0, text: 'A1' }),
    entry({ kind: 'user', speaker: 'You', text: 'Q2' }),
  ];
  assert.deepEqual(buildMemberHistory(entries, 0, undefined, 'Be terse.'), [
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'Q2' },
  ]);
  // Two members, two personas, same question: the comparison the + button is
  // for. Only the system message differs.
  const a = buildMemberHistory(entries, 0, undefined, 'Be terse.');
  const b = buildMemberHistory(entries, 0, undefined, '');
  assert.equal(a.length, b.length + 1);
  assert.deepEqual(a.slice(1), b);
});
