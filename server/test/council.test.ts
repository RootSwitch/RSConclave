import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConsolidatorPrompt, buildMemberHistory, buildMemberSystemPrompt, joinedPrompts, memberChat, renderResponses, renderTemplate } from '../council.ts';
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

/* ---------- memberChat: one answer, carried into a chat ---------- */

function ids() {
  let n = 0;
  return () => `new${++n}`;
}

const chatCouncil: CouncilConfig = {
  prompt: 'Which engine?',
  members: [
    { endpointId: 'box-a', model: 'sage:30b', params: { num_ctx: 32768, temperature: 0.4 }, personaId: 'terse' },
    { endpointId: 'box-b', model: 'jester:7b' },
  ],
  consolidator: { endpointId: 'box-a', model: 'sage:30b', template: '{{RESPONSES}}' },
  documentIds: ['doc1'],
};

// Two rounds. Member 0 errored once in round two and was re-run; member 1
// answered both rounds; a third round was asked after.
const rounds: TranscriptEntry[] = [
  entry({ id: 'u1', kind: 'user', speaker: 'User', text: 'Which engine?' }),
  entry({ id: 'a1', memberIndex: 0, model: 'sage:30b', text: 'Godot.', stats: { evalCount: 3 } }),
  entry({ id: 'b1', memberIndex: 1, model: 'jester:7b', text: 'Write your own.' }),
  entry({ id: 'c1', kind: 'consolidation', memberIndex: -1, model: 'sage:30b', text: 'Mostly Godot.' }),
  entry({ id: 'u2', kind: 'user', speaker: 'User', text: 'Why?' }),
  entry({ id: 'a2x', memberIndex: 0, model: 'sage:30b', text: '', error: 'timed out' }),
  entry({ id: 'b2', memberIndex: 1, model: 'jester:7b', text: 'Because it is fun.', truncated: true }),
  entry({ id: 'a2', memberIndex: 0, model: 'sage:30b', text: 'Open source, and it runs everywhere.' }),
  entry({ id: 'a2r', memberIndex: 0, model: 'sage:30b', text: 'A second reading of why.' }),
  entry({ id: 'u3', kind: 'user', speaker: 'User', text: 'And for 3D?' }),
  entry({ id: 'b3', memberIndex: 1, model: 'jester:7b', text: 'Still your own.' }),
];

test('memberChat: one round - the prompt and that answer, nothing from the other seats', () => {
  const { chat, entries } = memberChat(chatCouncil, rounds.slice(0, 4), 'b1', ids());
  assert.deepEqual(chat, { endpointId: 'box-b', model: 'jester:7b', documentIds: ['doc1'] });
  assert.deepEqual(entries.map((e) => [e.kind, e.speaker, e.text]), [
    ['user', 'You', 'Which engine?'],
    ['participant', 'jester:7b', 'Write your own.'],
  ]);
});

test('memberChat: the seat\'s model, settings, persona and the council\'s documents come along', () => {
  const { chat } = memberChat(chatCouncil, rounds, 'a1', ids());
  assert.deepEqual(chat, {
    endpointId: 'box-a', model: 'sage:30b',
    params: { num_ctx: 32768, temperature: 0.4 }, personaId: 'terse', documentIds: ['doc1'],
  });
  assert.notEqual(chat.params, chatCouncil.members[0].params, 'a copy, not the council\'s own object');
});

test('memberChat: later rounds hold that member\'s own earlier answers, as buildMemberHistory does', () => {
  const { entries } = memberChat(chatCouncil, rounds, 'b2', ids());
  assert.deepEqual(entries.map((e) => e.text), ['Which engine?', 'Write your own.', 'Why?', 'Because it is fun.']);
  assert.equal(entries.at(-1)!.truncated, true, 'a truncated answer stays marked, so Continue still offers');
  assert.ok(!entries.some((e) => e.text === 'And for 3D?'), 'a round asked after the answer is not part of it');
});

test('memberChat: the chosen re-run is the one carried, not a later one in the same round', () => {
  const chosen = memberChat(chatCouncil, rounds, 'a2', ids()).entries;
  assert.deepEqual(chosen.map((e) => e.text), ['Which engine?', 'Godot.', 'Why?', 'Open source, and it runs everywhere.']);
  const later = memberChat(chatCouncil, rounds, 'a2r', ids()).entries;
  assert.equal(later.at(-1)!.text, 'A second reading of why.');
  assert.equal(later.length, 4, 'the errored attempt and the superseded answer are both gone');
});

test('memberChat: a round the member never answered leaves its prompt standing alone, as the member saw it', () => {
  const missed: TranscriptEntry[] = [
    entry({ id: 'u1', kind: 'user', speaker: 'User', text: 'One?' }),
    entry({ id: 'x1', memberIndex: 0, model: 'sage:30b', text: '', error: 'skipped' }),
    entry({ id: 'u2', kind: 'user', speaker: 'User', text: 'Two?' }),
    entry({ id: 'x2', memberIndex: 0, model: 'sage:30b', text: 'Two.' }),
  ];
  const { entries } = memberChat(chatCouncil, missed, 'x2', ids());
  assert.deepEqual(entries.map((e) => [e.kind, e.text]), [['user', 'One?'], ['user', 'Two?'], ['participant', 'Two.']]);
  const history = buildMemberHistory(missed, 0);
  assert.deepEqual(history.map((m) => m.content), ['One?', 'Two?'], 'the same shape the member was sent');
});

test('memberChat: fresh ids, stats kept, and the council\'s entries left alone', () => {
  const before = structuredClone(rounds);
  const { entries } = memberChat(chatCouncil, rounds, 'a1', ids());
  assert.deepEqual(entries.map((e) => e.id), ['new1', 'new2']);
  assert.deepEqual(entries[1].stats, { evalCount: 3 });
  assert.equal(entries[1].memberIndex, undefined, 'a chat reply has no council seat');
  assert.deepEqual(rounds, before);
});

test('memberChat: refuses a consolidation, an unfinished answer, and an entry that is not there', () => {
  assert.throws(() => memberChat(chatCouncil, rounds, 'c1', ids()), /consolidation cannot be continued/);
  assert.throws(() => memberChat(chatCouncil, rounds, 'a2x', ids()), /did not finish/);
  assert.throws(() => memberChat(chatCouncil, rounds, 'u1', ids()), /only a council member/);
  assert.throws(() => memberChat(chatCouncil, rounds, 'nope', ids()), /not part of this session/);
  const thinkOnly = [entry({ id: 'u', kind: 'user', text: 'q' }), entry({ id: 't', memberIndex: 0, text: '<think>hmm</think>' })];
  assert.throws(() => memberChat(chatCouncil, thinkOnly, 't', ids()), /did not finish/);
});
