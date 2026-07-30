import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStagePrompt, resolveStageInput, validatePipeline } from '../pipeline.ts';
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
