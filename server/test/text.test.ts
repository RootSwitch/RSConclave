import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTranscriptText, stripThink } from '../text.ts';
import type { TranscriptEntry } from '../types.ts';

test('stripThink: removes a complete think block', () => {
  assert.equal(stripThink('<think>hmm let me reason</think>\nThe answer is 4.'), 'The answer is 4.');
});

test('stripThink: removes an unclosed think block (stream cut)', () => {
  assert.equal(stripThink('prefix <think>reasoning that never closed'), 'prefix');
});

test('stripThink: removes multiple blocks', () => {
  assert.equal(stripThink('<think>a</think>X<think>b</think>Y'), 'XY');
});

test('stripThink: leaves plain text untouched', () => {
  assert.equal(stripThink('Just an answer.'), 'Just an answer.');
});

test('stripThink: multiline think content', () => {
  assert.equal(stripThink('<think>\nline1\nline2\n</think>\nfinal'), 'final');
});

function entry(partial: Partial<TranscriptEntry>): TranscriptEntry {
  return { id: 'x', ts: '', kind: 'participant', speaker: '?', text: '', ...partial };
}

test('renderTranscriptText: labels speakers, skips errors/consolidations/think-only', () => {
  const out = renderTranscriptText([
    entry({ speaker: 'Alice', text: 'Hello.' }),
    entry({ kind: 'error', speaker: 'Bob', text: 'broken' }),
    entry({ kind: 'consolidation', speaker: 'Judge', text: 'verdict' }),
    entry({ kind: 'narrator', speaker: 'Narrator', text: 'Meanwhile.' }),
    entry({ speaker: 'Bob', text: '<think>secret</think>Visible.' }),
    entry({ speaker: 'Carol', text: '<think>only thoughts, no answer' }),
  ]);
  assert.equal(out, '[Alice]: Hello.\n\n[Narrator]: Meanwhile.\n\n[Bob]: Visible.');
});
