import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickOption, tallyBallot, ballotInstruction, tallyToMarkdown } from '../vote.ts';
import type { TranscriptEntry } from '../types.ts';

const member = (model: string, text: string, extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  id: model + '-' + Math.abs(text.length),
  ts: '2026-01-01T00:00:00.000Z',
  kind: 'participant',
  speaker: model,
  model,
  memberIndex: 0,
  text,
  ...extra,
});

test('vote: picks a plain answer', () => {
  assert.equal(pickOption('Yes', ['Yes', 'No']), 'Yes');
  assert.equal(pickOption('no', ['Yes', 'No']), 'No');
  assert.equal(pickOption('Water is wet.', ['Yes', 'No']), null);
});

test('vote: reads from the end, so reasoning-out-loud does not miscount', () => {
  // The model mentions both options while thinking and commits at the end.
  const text = 'It could be No if you weight cost heavily, but on balance I say\n\nYes';
  assert.equal(pickOption(text, ['Yes', 'No']), 'Yes');
});

test('vote: a more specific option wins over one contained in it', () => {
  const options = ['Yes', 'Yes, with conditions'];
  assert.equal(pickOption('Final answer: Yes, with conditions', options), 'Yes, with conditions');
  assert.equal(pickOption('Final answer: Yes', options), 'Yes');
});

test('vote: tolerates markdown and trailing punctuation around the answer', () => {
  assert.equal(pickOption('**Approve**.', ['Approve', 'Reject']), 'Approve');
  assert.equal(pickOption('- Reject\n', ['Approve', 'Reject']), 'Reject');
});

test('vote: tally counts voters per option and records who', () => {
  const r = tallyBallot(['Yes', 'No'], [
    { ...member('a', 'Yes'), kind: 'user', memberIndex: undefined } as TranscriptEntry, // ignored
    member('gpt', 'after thought, Yes'),
    member('gemma', 'No'),
    member('mistral', 'Yes'),
  ]);
  assert.equal(r.votesCast, 3);
  assert.deepEqual(r.tallies.find((t) => t.option === 'Yes')?.voters, ['gpt', 'mistral']);
  assert.equal(r.tallies.find((t) => t.option === 'No')?.count, 1);
  assert.deepEqual(r.undecided, []);
});

test('vote: errored and unmatched members are undecided, not silently dropped', () => {
  const r = tallyBallot(['Yes', 'No'], [
    member('gpt', 'Yes'),
    member('broken', '', { error: 'unreachable' }),
    member('rambler', 'I would rather not commit to either position'),
  ]);
  assert.equal(r.votesCast, 1);
  assert.deepEqual(r.undecided, ['broken', 'rambler']);
});

test('vote: the consolidation entry is not a vote', () => {
  const r = tallyBallot(['Yes', 'No'], [
    member('gpt', 'Yes'),
    { ...member('judge', 'The council said No overall'), kind: 'consolidation', memberIndex: -1 },
  ]);
  assert.equal(r.votesCast, 1);
  assert.equal(r.tallies.find((t) => t.option === 'No')?.count, 0);
});

test('vote: instruction lists every option', () => {
  const s = ballotInstruction(['Yes', 'No', 'Unclear']);
  for (const o of ['Yes', 'No', 'Unclear']) assert.ok(s.includes(o));
});

test('vote: markdown is empty when nothing was tallied', () => {
  assert.equal(tallyToMarkdown({ tallies: [{ option: 'Yes', count: 0, voters: [] }], undecided: [], votesCast: 0 }), '');
  const md = tallyToMarkdown(tallyBallot(['Yes'], [member('gpt', 'Yes')]));
  assert.match(md, /## Ballot/);
  assert.match(md, /\*\*Yes\*\* - 1/);
});
