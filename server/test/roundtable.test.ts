import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, buildSystemPrompt, nextSpeaker, stripSelfPrefix } from '../roundtable.ts';
import type { Participant, Persona, RoundtableConfig, TranscriptEntry } from '../types.ts';

const alice: Participant = { id: 'a', name: 'Alice', endpointId: 'e', model: 'm1' };
const bob: Participant = { id: 'b', name: 'Bob', endpointId: 'e', model: 'm2' };
const config: RoundtableConfig = {
  participants: [alice, bob],
  scenario: 'A debate about tabs vs spaces.',
  turnOrder: 'round-robin',
};
const personas: Persona[] = [{ id: 'p1', name: 'Skeptic', systemPrompt: 'You doubt everything.' }];

function entry(partial: Partial<TranscriptEntry>): TranscriptEntry {
  return { id: Math.random().toString(36).slice(2), ts: '', kind: 'participant', speaker: '?', text: 'x', ...partial };
}

test('nextSpeaker: round-robin from last participant entry', () => {
  const entries = [entry({ participantId: 'a', speaker: 'Alice' })];
  assert.equal(nextSpeaker(config, entries).id, 'b');
});

test('nextSpeaker: first participant when transcript empty or only injections', () => {
  assert.equal(nextSpeaker(config, []).id, 'a');
  assert.equal(nextSpeaker(config, [entry({ kind: 'narrator', speaker: 'Narrator' })]).id, 'a');
});

test('nextSpeaker: wraps around', () => {
  const entries = [entry({ participantId: 'b', speaker: 'Bob' })];
  assert.equal(nextSpeaker(config, entries).id, 'a');
});

test('buildMessages: own entries are assistant, others prefixed user', () => {
  const entries = [
    entry({ participantId: 'a', speaker: 'Alice', text: 'Tabs are better.' }),
    entry({ participantId: 'b', speaker: 'Bob', text: 'Spaces, obviously.' }),
  ];
  const msgs = buildMessages(alice, config, entries, personas);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].content, 'Tabs are better.');
  assert.equal(msgs[2].role, 'user');
  assert.equal(msgs[2].content, '[Bob]: Spaces, obviously.');
});

test('buildMessages: consecutive same-role messages merge', () => {
  const entries = [
    entry({ participantId: 'b', speaker: 'Bob', text: 'One.' }),
    entry({ kind: 'narrator', speaker: 'Narrator', text: 'Meanwhile…' }),
    entry({ kind: 'user', speaker: 'User', text: 'Carry on.' }),
  ];
  const msgs = buildMessages(alice, config, entries, personas);
  assert.equal(msgs.length, 2); // system + one merged user message
  assert.equal(msgs[1].role, 'user');
  assert.equal(msgs[1].content, '[Bob]: One.\n\n[Narrator]: Meanwhile…\n\n[User]: Carry on.');
});

test('buildMessages: appends moderator continue when last entry is own', () => {
  const entries = [
    entry({ participantId: 'b', speaker: 'Bob', text: 'Hi.' }),
    entry({ participantId: 'a', speaker: 'Alice', text: 'Hello.' }),
  ];
  const msgs = buildMessages(alice, config, entries, personas);
  assert.equal(msgs.at(-1)!.role, 'user');
  assert.equal(msgs.at(-1)!.content, '[Moderator]: Continue.');
});

test('buildMessages: empty transcript gets a moderator kickoff', () => {
  const msgs = buildMessages(alice, config, [], personas);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].role, 'user');
});

test('buildMessages: error entries and empty texts are excluded', () => {
  const entries = [
    entry({ kind: 'error', participantId: 'b', speaker: 'Bob', text: '' }),
    entry({ participantId: 'b', speaker: 'Bob', text: 'Real message.' }),
  ];
  const msgs = buildMessages(alice, config, entries, personas);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].content, '[Bob]: Real message.');
});

test('buildMessages: keepLastTurns truncates and notes it', () => {
  const cfg: RoundtableConfig = { ...config, keepLastTurns: 2 };
  const entries = [
    entry({ participantId: 'a', speaker: 'Alice', text: 'old' }),
    entry({ participantId: 'b', speaker: 'Bob', text: 'mid' }),
    entry({ participantId: 'b', speaker: 'Bob', text: 'new' }),
  ];
  const msgs = buildMessages(alice, cfg, entries, personas);
  const all = msgs.map((m) => m.content).join('|');
  assert.ok(all.includes('(earlier conversation truncated)'));
  assert.ok(!all.includes('old'));
  assert.ok(all.includes('mid') && all.includes('new'));
});

test('buildSystemPrompt: layers preamble, persona, overlay, scenario', () => {
  const p: Participant = { ...alice, personaId: 'p1', overlayPrompt: 'You argue for tabs.' };
  const sys = buildSystemPrompt(p, config, personas);
  assert.ok(sys.indexOf('You are Alice') < sys.indexOf('You doubt everything.'));
  assert.ok(sys.indexOf('You doubt everything.') < sys.indexOf('You argue for tabs.'));
  assert.ok(sys.indexOf('You argue for tabs.') < sys.indexOf('SCENARIO:'));
  assert.ok(sys.includes('Other participants: Bob'));
});

test('stripSelfPrefix: removes name prefixes, keeps clean text', () => {
  assert.equal(stripSelfPrefix('Alice', 'Alice: hello'), 'hello');
  assert.equal(stripSelfPrefix('Alice', '[Alice]: hello'), 'hello');
  assert.equal(stripSelfPrefix('Alice', 'hello Alice: yes'), 'hello Alice: yes');
  assert.equal(stripSelfPrefix('DM (Dave)', 'DM (Dave): roll initiative'), 'roll initiative');
});

test('stripSelfPrefix: a seat named with brackets strips both spellings', () => {
  // "[Bot]:" always stripped (the optional bracket matched empty around the
  // escaped name); the de-bracketed "Bot:" is the case that used to survive.
  assert.equal(stripSelfPrefix('[Bot]', '[Bot]: reply'), 'reply');
  assert.equal(stripSelfPrefix('[Bot]', 'Bot: reply'), 'reply');
  // regex metacharacters in names still match literally
  assert.equal(stripSelfPrefix('C++', 'C++: reply'), 'reply');
  // a name that is nothing but brackets falls back to itself
  assert.equal(stripSelfPrefix('[]', '[]: reply'), 'reply');
});
