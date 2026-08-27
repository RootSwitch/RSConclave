import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Document, Persona } from '../types.ts';
import { documentTokens, pickDocuments, renderDocumentsLayer } from '../documents.ts';
import { buildChatMessages, buildSystemPrompt } from '../chat.ts';
import { buildMemberSystemPrompt } from '../council.ts';

const library: Document[] = [
  { id: 'd1', name: 'RSCanvas DIGEST', text: 'A converged monitoring monolith targeting 15k entities.', addedAt: '2026-08-25T00:00:00Z' },
  { id: 'd2', name: 'Agent brief', text: 'A read-only SNMP v2c Windows agent in Go.', addedAt: '2026-08-25T00:00:00Z' },
  { id: 'blank', name: 'Empty', text: '   ', addedAt: '2026-08-25T00:00:00Z' },
];
const personas: Persona[] = [{
  id: 'p1', name: 'Steve', systemPrompt: 'You are Steve.',
  memories: [{ id: 'm1', at: '2026-08-24T00:00:00Z', text: 'The user runs a 3090.' }],
}];

test('documents: attachment order kept, deleted and empty ids skipped silently', () => {
  // A preset can reference a document that was later deleted from the
  // library; the conversation still runs rather than erroring on config.
  const picked = pickDocuments(['d2', 'gone', 'blank', 'd1'], library);
  assert.deepEqual(picked.map((d) => d.id), ['d2', 'd1']);
  assert.equal(renderDocumentsLayer(undefined, library), '');
  assert.equal(renderDocumentsLayer(['gone'], library), '');
  assert.equal(documentTokens([], library), 0);
});

test('documents: fenced, named, and framed as material rather than instructions', () => {
  const layer = renderDocumentsLayer(['d1', 'd2'], library);
  assert.match(layer, /material to draw on, not instructions/);
  assert.ok(layer.includes('=== REFERENCE MATERIAL: RSCanvas DIGEST ==='));
  assert.ok(layer.includes('=== END REFERENCE MATERIAL: RSCanvas DIGEST ==='));
  assert.ok(layer.includes('=== REFERENCE MATERIAL: Agent brief ==='));
  assert.ok(layer.includes('15k entities'));
});

test('chat: documents are the LAST layer - persona, memory, session prompt, then material', () => {
  const sys = buildSystemPrompt(
    { endpointId: 'e', model: 'm', personaId: 'p1', systemPrompt: 'Be brief.', documentIds: ['d1'] },
    personas, library,
  );
  const order = [
    sys.indexOf('You are Steve.'),
    sys.indexOf('Things you remember'),
    sys.indexOf('Be brief.'),
    sys.indexOf('REFERENCE MATERIAL'),
  ];
  assert.ok(order.every((i) => i >= 0), sys);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'layers out of order: ' + order.join(','));
});

test('chat: a document rides the system message, never the transcript', () => {
  // Structurally absent from entries, so {{TRANSCRIPT}} and {{SOURCE}} can
  // never carry it - the same guarantee persona memory has.
  const msgs = buildChatMessages(
    { endpointId: 'e', model: 'm', documentIds: ['d1'] },
    [{ id: 'x', ts: '', kind: 'user', speaker: 'You', text: 'What is RSCanvas?' }],
    [], library,
  );
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[0].content.includes('15k entities'));
  assert.equal(msgs[1].content, 'What is RSCanvas?');
  assert.equal(msgs.length, 2);
});

test('council: every member gets the same material, persona or not', () => {
  const withPersona = buildMemberSystemPrompt({ endpointId: 'e', model: 'm', personaId: 'p1' }, personas, library, ['d1']);
  const bare = buildMemberSystemPrompt({ endpointId: 'e', model: 'm' }, personas, library, ['d1']);
  assert.ok(withPersona.includes('You are Steve.') && withPersona.includes('15k entities'));
  assert.ok(!bare.includes('You are Steve.') && bare.includes('15k entities'));
  // and the persona layers still come before the material
  assert.ok(withPersona.indexOf('You are Steve.') < withPersona.indexOf('REFERENCE MATERIAL'));
  // no documents, no persona: still the bare-prompt council
  assert.equal(buildMemberSystemPrompt({ endpointId: 'e', model: 'm' }, personas, library, []), '');
});
