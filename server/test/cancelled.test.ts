/*
 * One rule, six call sites.
 *
 * A cancelled partial used to be context in the roundtable and in the council's
 * consolidator but not in chat, council follow-ups or a pipeline stage - and the
 * UI called it "partial output kept" in all of them. These tests pin the agreed
 * behaviour in every mode at once, because the failure mode is not one module
 * being wrong, it is two modules drifting apart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { incompleteNote, isFinishedTurn, renderTranscriptText } from '../text.ts';
import { buildChatMessages } from '../chat.ts';
import { buildMessages } from '../roundtable.ts';
import { buildMemberHistory, renderResponses } from '../council.ts';
import { resolveStageInput } from '../pipeline.ts';
import type {
  ChatConfig, CouncilConfig, Participant, Persona, RoundtableConfig, TranscriptEntry,
} from '../types.ts';

function entry(partial: Partial<TranscriptEntry>): TranscriptEntry {
  return { id: Math.random().toString(36).slice(2), ts: '', kind: 'participant', speaker: '?', text: '', ...partial };
}

/** A reply the user stopped part-way: real text, marked cancelled. */
function cancelled(partial: Partial<TranscriptEntry>): TranscriptEntry {
  return entry({ error: 'cancelled', ...partial });
}

const personas: Persona[] = [];

test('isFinishedTurn: a cancelled partial is not a finished turn', () => {
  assert.equal(isFinishedTurn(cancelled({ text: 'I was about to say' })), false);
});

test('isFinishedTurn: a clean reply is', () => {
  assert.equal(isFinishedTurn(entry({ text: 'Done.' })), true);
});

test('isFinishedTurn: errors and empties are not, think-only counts as empty', () => {
  assert.equal(isFinishedTurn(entry({ kind: 'error', text: 'boom' })), false);
  assert.equal(isFinishedTurn(entry({ text: '   ' })), false);
  assert.equal(isFinishedTurn(entry({ text: '<think>only thoughts' })), false);
});

test('isFinishedTurn: user text is not think-stripped, so a literal tag still counts', () => {
  // A person typing "<think>" means it literally; stripping their message to
  // nothing would silently drop what they asked.
  assert.equal(isFinishedTurn(entry({ kind: 'user', text: '<think>what does this tag do?' })), true);
});

test('incompleteNote: marks cancelled only', () => {
  assert.equal(incompleteNote(cancelled({ text: 'x' })), ' (INCOMPLETE - CANCELLED PART-WAY)');
  assert.equal(incompleteNote(entry({ text: 'x' })), '');
});

/* ---------- the four conversational histories all withhold it ---------- */

test('chat: a cancelled partial is not sent as context', () => {
  const config: ChatConfig = { endpointId: 'e', model: 'm' };
  const msgs = buildChatMessages(config, [
    entry({ kind: 'user', text: 'first question' }),
    cancelled({ text: 'I was about to say' }),
    entry({ kind: 'user', text: 'second question' }),
  ], personas);
  assert.deepEqual(msgs, [{ role: 'user', content: 'first question\n\nsecond question' }]);
});

test('roundtable: a cancelled partial is not sent as context', () => {
  const alice: Participant = { id: 'a', name: 'Alice', endpointId: 'e', model: 'm1' };
  const bob: Participant = { id: 'b', name: 'Bob', endpointId: 'e', model: 'm2' };
  const config: RoundtableConfig = { participants: [alice, bob], scenario: 'S', turnOrder: 'round-robin' };
  const msgs = buildMessages(bob, config, [
    entry({ participantId: 'a', speaker: 'Alice', text: 'Tabs are better.' }),
    cancelled({ participantId: 'a', speaker: 'Alice', text: 'And another thi' }),
  ], personas);
  const body = msgs.filter((m) => m.role !== 'system').map((m) => m.content).join('\n');
  assert.match(body, /Tabs are better\./);
  assert.doesNotMatch(body, /And another thi/);
});

test('council follow-ups: a member does not see its own cancelled partial', () => {
  const msgs = buildMemberHistory([
    entry({ kind: 'user', text: 'Q1' }),
    cancelled({ memberIndex: 0, text: 'half an answer' }),
    entry({ kind: 'user', text: 'Q2' }),
  ], 0);
  assert.deepEqual(msgs, [
    { role: 'user', content: 'Q1' },
    { role: 'user', content: 'Q2' },
  ]);
});

test('pipeline: a cancelled stage output is not fed to the next stage', () => {
  const entries = [
    entry({ kind: 'user', text: 'in' }),
    entry({ memberIndex: 0, text: 'good draft' }),
    cancelled({ memberIndex: 0, text: 'a rerun I stopped' }),
  ];
  // The latest GOOD output for the stage, not simply the latest.
  assert.equal(resolveStageInput(entries, 1), 'good draft');
});

test('pipeline: a fragment is not silently accepted as the stage input', () => {
  const entries = [
    entry({ kind: 'user', text: 'in' }),
    cancelled({ memberIndex: 0, text: 'a fragment' }),
  ];
  // Refusing out loud beats feeding half a sentence to the next stage, and beats
  // an empty string that would look like the stage simply had nothing to say.
  assert.throws(() => resolveStageInput(entries, 1), /stage 0 produced no output/);
});

/* ---------- the two labelled renderings keep it, marked ---------- */

test('council {{RESPONSES}}: a cancelled partial is included and marked incomplete', () => {
  const config: CouncilConfig = {
    prompt: 'Q',
    members: [{ endpointId: 'e', model: 'sage:30b' }],
    consolidator: { endpointId: 'e', model: 'sage:30b', template: '{{RESPONSES}}' },
  };
  const out = renderResponses(config, [cancelled({ memberIndex: 0, text: 'Half of an argument' })]);
  assert.match(out, /RESPONSE FROM: sage:30b \(INCOMPLETE - CANCELLED PART-WAY\)/);
  assert.match(out, /Half of an argument/);
  // Reporting it as absent would contradict the text sitting on the user's screen.
  assert.doesNotMatch(out, /no response/);
});

test('judge transcript: a cancelled partial is included and marked incomplete', () => {
  const out = renderTranscriptText([
    entry({ speaker: 'Alice', text: 'Tabs.' }),
    cancelled({ speaker: 'Bob', text: 'Spac' }),
  ]);
  assert.equal(out, '[Alice]: Tabs.\n\n[Bob (INCOMPLETE - CANCELLED PART-WAY)]: Spac');
});
