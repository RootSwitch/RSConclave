import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entriesBeforeStage, renderStagePrompt, resolveStageInput, validatePipeline } from '../pipeline.ts';
import type { TranscriptEntry } from '../types.ts';

function entry(partial: Partial<TranscriptEntry>): TranscriptEntry {
  return { id: 'x', ts: '', kind: 'participant', speaker: '?', text: '', ...partial };
}

test('resolveStageInput: stage 0 gets the user input', () => {
  const entries = [entry({ kind: 'user', text: 'raw input' })];
  assert.equal(resolveStageInput(entries, 0), 'raw input');
});

test('resolveStageInput: later stages get previous stage output, think-stripped', () => {
  const entries = [
    entry({ kind: 'user', text: 'in' }),
    entry({ memberIndex: 0, text: '<think>hmm</think>draft text' }),
  ];
  assert.equal(resolveStageInput(entries, 1), 'draft text');
});

test('resolveStageInput: rerun output wins (last entry for the stage)', () => {
  const entries = [
    entry({ kind: 'user', text: 'in' }),
    entry({ memberIndex: 0, text: 'first draft' }),
    entry({ memberIndex: 0, text: 'better draft' }),
  ];
  assert.equal(resolveStageInput(entries, 1), 'better draft');
});

test('resolveStageInput: errored stage yields a clear error', () => {
  const entries = [
    entry({ kind: 'user', text: 'in' }),
    entry({ kind: 'error', memberIndex: 0, text: '', error: 'boom' }),
  ];
  assert.throws(() => resolveStageInput(entries, 1), /no input/);
});

test('renderStagePrompt: replaces {{INPUT}}', () => {
  assert.equal(renderStagePrompt('Critique this:\n{{INPUT}}', 'a draft'), 'Critique this:\na draft');
});

test('renderStagePrompt: appends input when placeholder missing', () => {
  assert.equal(renderStagePrompt('Critique this:', 'a draft'), 'Critique this:\n\na draft');
});

test('validatePipeline: rejects empty input/stages', () => {
  assert.throws(() => validatePipeline({ input: ' ', stages: [{ endpointId: 'e', model: 'm', template: 't' }] }));
  assert.throws(() => validatePipeline({ input: 'x', stages: [] }));
});

/*
 * Re-run from a stage discards that stage's output and everything downstream:
 * output derived from text being replaced is not worth keeping. The engine calls
 * entriesBeforeStage for the splice, so these exercise the real predicate rather
 * than a copy of it.
 */
const keptByRerun = entriesBeforeStage;

test('rerun discard: keeps earlier stages and the input, drops this stage onward', () => {
  const entries = [
    entry({ kind: 'user', text: 'seed' }),
    entry({ memberIndex: 0, text: 'one' }),
    entry({ memberIndex: 1, text: 'two' }),
    entry({ memberIndex: 2, text: 'three' }),
  ];
  const kept = keptByRerun(entries, 1);
  assert.deepEqual(kept.map((e) => e.text), ['seed', 'one']);
});

test('rerun discard: from stage 0 keeps only the input', () => {
  const entries = [
    entry({ kind: 'user', text: 'seed' }),
    entry({ memberIndex: 0, text: 'one' }),
    entry({ memberIndex: 1, text: 'two' }),
  ];
  assert.deepEqual(keptByRerun(entries, 0).map((e) => e.text), ['seed']);
});

test('rerun discard: an errored stage entry is dropped too', () => {
  // Otherwise the failure it recorded outlives the attempt that caused it.
  const entries = [
    entry({ kind: 'user', text: 'seed' }),
    entry({ memberIndex: 0, text: 'one' }),
    entry({ kind: 'error', memberIndex: 1, text: '', error: 'boom' }),
  ];
  assert.deepEqual(keptByRerun(entries, 1).map((e) => e.text), ['seed', 'one']);
});

test('rerun discard: leaves exactly one entry per stage after re-running', () => {
  // The duplicate-card symptom: two stage-1 outputs with nothing marking which
  // was current, both offering "Re-run from here".
  const afterFirstRun = [
    entry({ kind: 'user', text: 'seed' }),
    entry({ memberIndex: 0, text: 'one' }),
    entry({ memberIndex: 1, text: 'two' }),
  ];
  const regenerated = [...keptByRerun(afterFirstRun, 1), entry({ memberIndex: 1, text: 'two again' })];
  const stages = regenerated.filter((e) => e.memberIndex !== undefined).map((e) => e.memberIndex);
  assert.equal(new Set(stages).size, stages.length, 'no stage may appear twice');
});
