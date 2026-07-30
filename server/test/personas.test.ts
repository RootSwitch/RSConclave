import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PERSONAS } from '../types.ts';
import { buildSystemPrompt } from '../chat.ts';

test('default personas: every one has a unique id, a name and a prompt', () => {
  assert.ok(DEFAULT_PERSONAS.length >= 4);
  const ids = new Set(DEFAULT_PERSONAS.map((p) => p.id));
  assert.equal(ids.size, DEFAULT_PERSONAS.length);
  for (const p of DEFAULT_PERSONAS) {
    assert.match(p.id, /^[a-z0-9-]+$/);
    assert.ok(p.name.trim().length > 0, `${p.id} needs a name`);
    assert.ok(p.systemPrompt.trim().length > 40, `${p.id} needs a real prompt`);
  }
});

test('default personas: ship an opposing pair, which is what makes a roundtable argue', () => {
  const names = DEFAULT_PERSONAS.map((p) => p.name);
  assert.ok(names.includes('Skeptic'));
  assert.ok(names.includes('Advocate'));
});

test('default personas: resolve through the normal persona lookup', () => {
  const dm = DEFAULT_PERSONAS.find((p) => p.name === 'Dungeon Master')!;
  const sys = buildSystemPrompt(
    { endpointId: 'e', model: 'm', personaId: dm.id },
    DEFAULT_PERSONAS,
  );
  assert.equal(sys, dm.systemPrompt);
});

test('default personas: an unknown persona id contributes nothing', () => {
  const sys = buildSystemPrompt(
    { endpointId: 'e', model: 'm', personaId: 'no-such-persona' },
    DEFAULT_PERSONAS,
  );
  assert.equal(sys, '');
});
