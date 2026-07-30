import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConsolidatorPrompt, buildMemberHistory, joinedPrompts, renderResponses, renderTemplate } from '../council.ts';
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
