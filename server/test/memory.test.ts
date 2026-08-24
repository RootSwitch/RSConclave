import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Persona, RoundtableConfig, TranscriptEntry } from '../types.ts';
import { DEFAULT_COMPACT_TEMPLATE, DEFAULT_DISTIL_TEMPLATE, DEFAULT_SUMMARIZE_TEMPLATE, NOTHING_NEW } from '../types.ts';
import { DUPLICATE_OVERLAP, findNearDuplicate, isNothingNew, memoryTokens, overlap, renderMemoryLayer, renderMemoryPlain } from '../memory.ts';
import { buildChatMessages, buildSystemPrompt } from '../chat.ts';
import { buildSystemPrompt as buildRoundtablePrompt } from '../roundtable.ts';
import { fillTemplate, renderSourceText, renderTranscriptText } from '../text.ts';

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

test('default templates: fenced reference block, no meta-commentary, and a sentinel', () => {
  for (const t of [DEFAULT_SUMMARIZE_TEMPLATE, DEFAULT_DISTIL_TEMPLATE]) {
    // The memory is fenced and labelled reference-only. Unfenced, it sat at
    // the bottom of the prompt looking exactly like the answer being asked
    // for, and models copied it.
    assert.ok(t.includes('{{MEMORY}}'));
    assert.match(t, /ALREADY REMEMBERED/);
    assert.match(t, /END ALREADY REMEMBERED/);
    assert.match(t, /reference only/i);
    // The bug this template caused: "no new information was shared" written as
    // CONTENT, saved as a memory, then copied by the next summariser.
    assert.match(t, /what was or was not new/i);
    // A sentinel, not a sentence, so the app can recognise and refuse it.
    assert.ok(t.includes(NOTHING_NEW));
  }
  assert.ok(DEFAULT_SUMMARIZE_TEMPLATE.includes('{{TRANSCRIPT}}'));
  assert.ok(DEFAULT_COMPACT_TEMPLATE.includes('{{MEMORY}}'));
  assert.ok(!DEFAULT_COMPACT_TEMPLATE.includes('{{TRANSCRIPT}}'));
  assert.match(DEFAULT_COMPACT_TEMPLATE, /shorter than the input/i);
});
test('source rendering: the material only, with every model reply left out', () => {
  // The whole point of {{SOURCE}}: a conversation ABOUT a document is not the
  // document, and a distillation prompt handed the assistant's clarifying
  // questions writes them back out as though they were facts.
  const entries = [
    entry({ kind: 'user', speaker: 'You', text: '# RSCanvas\nA converged monitoring monolith.' }),
    entry({ speaker: 'qwen', text: 'Thanks! Would you like me to focus on the architecture?' }),
    entry({ kind: 'user', speaker: 'You', text: 'It targets 15k entities.' }),
    entry({ kind: 'consolidation', speaker: 'qwen', text: 'A summary of the above.' }),
  ];
  const source = renderSourceText(entries);
  assert.ok(source.includes('# RSCanvas'));
  assert.ok(source.includes('It targets 15k entities.'));
  assert.ok(!source.includes('Would you like me'), 'the assistant is not source material');
  assert.ok(!source.includes('A summary of the above'), 'nor is a previous summary');
  // The transcript form still carries everything - the two are different jobs.
  const transcript = renderTranscriptText(entries);
  assert.ok(transcript.includes('Would you like me'));
});

test('source rendering: narrator injections count, because a person typed them', () => {
  const source = renderSourceText([
    entry({ kind: 'narrator', speaker: 'Narrator', text: 'The building loses power.' }),
    entry({ speaker: 'model', text: 'I reach for the torch.' }),
  ]);
  assert.equal(source, 'The building loses power.');
});

test('default templates: the distillation reads SOURCE and is about the subject', () => {
  assert.ok(DEFAULT_DISTIL_TEMPLATE.includes('{{SOURCE}}'));
  // It must not be handed the whole exchange - that is the other template.
  assert.ok(!DEFAULT_DISTIL_TEMPLATE.includes('{{TRANSCRIPT}}'));
  assert.match(DEFAULT_DISTIL_TEMPLATE, /SUBJECT/);
  assert.match(DEFAULT_DISTIL_TEMPLATE, /as a document/i);
});
test('nothing-new: the sentinel is recognised, a real memory is not', () => {
  assert.equal(isNothingNew('NOTHING NEW'), true);
  assert.equal(isNothingNew('NOTHING NEW.'), true);
  assert.equal(isNothingNew('nothing new'), true);
  // Models rarely answer with a bare token; a short apologetic wrapper counts.
  assert.equal(isNothingNew('NOTHING NEW - the conversation added no facts.'), true);
  // But a real memory that happens to use the words does not, because it is
  // long enough to be carrying content.
  assert.equal(isNothingNew(
    'The user runs a 3090 and prefers Q4_K_M quants. They decided nothing new would be '
    + 'added to the RSOperator fork until persona memory has been tested properly, and they '
    + 'are running the comparison with two forks of the same persona.'), false);
  assert.equal(isNothingNew(''), false);
});

test('near-duplicate: an echoed memory scores high, an unrelated one does not', () => {
  // The real failure: a summariser handed the memory block wrote a summary of
  // the last memory instead of the conversation.
  const memory = 'The user is testing TFTP functionality on Ubuntu and is open to using tftp-hpa '
    + 'for more reliable and debuggable TFTP operations. The user is interested in TFTP client '
    + 'options for network device or embedded system testing.';
  const echoed = 'The user is testing TFTP functionality on Ubuntu and is open to using tftp-hpa '
    + 'for reliable debuggable TFTP operations. The user is interested in TFTP client options '
    + 'for network device or embedded system testing. No new facts were introduced.';
  const genuine = 'The user runs multiple sim-racing setups with Logitech G923 wheels on Windows '
    + '11 and bought Crashday Redline Edition, looking for inexpensive networked multiplayer '
    + 'racing games with wheel support and computer opponents.';
  assert.ok(overlap(echoed, memory) >= DUPLICATE_OVERLAP, String(overlap(echoed, memory)));
  assert.ok(overlap(genuine, memory) < 0.3, String(overlap(genuine, memory)));

  const persona = { memories: [
    { id: 'a', at: '2026-08-24T00:00:00Z', text: 'The user runs MobaXTerm on Windows.' },
    { id: 'b', at: '2026-08-24T04:00:00Z', text: memory },
  ] };
  assert.equal(findNearDuplicate(persona, echoed)?.entry.id, 'b');
  assert.equal(findNearDuplicate(persona, genuine), null);
});

test('near-duplicate: a one-line memory is not "contained" in every longer one', () => {
  /*
   * Caught by the test above before it shipped. Containment against a very
   * short memory is carried entirely by phrasing: an unrelated memory about
   * sim racing scored 0.80 against "The user runs MobaXTerm on Windows",
   * purely on "the user runs windows" - which would have refused a genuine
   * new memory as a duplicate.
   */
  const short = 'The user runs MobaXTerm on Windows.';
  const unrelated = 'The user runs multiple sim-racing setups with Logitech G923 wheels on Windows '
    + '11 and bought Crashday Redline Edition, looking for inexpensive networked multiplayer '
    + 'racing games with wheel support and computer opponents.';
  assert.equal(overlap(unrelated, short), 0, 'too short to judge, so it does not judge');
  assert.equal(findNearDuplicate({ memories: [{ id: 'a', at: '2026-08-24T00:00:00Z', text: short }] }, unrelated), null);
});
