import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchSessions } from '../search.ts';
import type { Session } from '../types.ts';

function session(partial: Partial<Session>): Session {
  return {
    id: 'x', mode: 'chat', title: 't', createdAt: '2026-01-01', updatedAt: '2026-01-01',
    config: { endpointId: 'e', model: 'm' }, entries: [], status: 'done',
    ...partial,
  } as Session;
}

const entry = (speaker: string, text: string) =>
  ({ id: 'e', ts: '', kind: 'participant' as const, speaker, text });

test('search: matches transcript text, case-insensitively, with speaker and snippet', () => {
  const r = searchSessions([session({
    id: 's1', title: 'Weather talk',
    entries: [entry('Sage', 'The TIDAL power question deserves care.')],
  })], 'tidal');
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 's1');
  assert.equal(r[0].hits[0].speaker, 'Sage');
  assert.ok(r[0].hits[0].snippet.includes('TIDAL power'));
});

test('search: matches titles and setup text', () => {
  const r = searchSessions([
    session({ id: 'byTitle', title: 'Dragon campaign' }),
    session({ id: 'byScenario', config: { participants: [], scenario: 'a dragon guards the pass', turnOrder: 'round-robin' } as any }),
  ], 'dragon');
  assert.deepEqual(r.map((x) => x.id).sort(), ['byScenario', 'byTitle']);
  assert.equal(r.find((x) => x.id === 'byTitle')!.hits[0].speaker, 'title');
  assert.equal(r.find((x) => x.id === 'byScenario')!.hits[0].speaker, 'setup');
});

test('search: hits are capped but total counts everything', () => {
  const entries = Array.from({ length: 10 }, (_, i) => entry(`P${i}`, `repeated word here ${i}`));
  const r = searchSessions([session({ entries })], 'repeated');
  assert.equal(r[0].hits.length, 3);
  assert.equal(r[0].total, 10);
});

test('search: long text is snipped around the match with ellipses', () => {
  const long = 'x'.repeat(300) + ' needle ' + 'y'.repeat(300);
  const r = searchSessions([session({ entries: [entry('A', long)] })], 'needle');
  const s = r[0].hits[0].snippet;
  assert.ok(s.length < 130);
  assert.ok(s.startsWith('…') && s.endsWith('…'));
  assert.ok(s.includes('needle'));
});

test('search: short or empty queries return nothing', () => {
  const sessions = [session({ title: 'a' })];
  assert.deepEqual(searchSessions(sessions, ''), []);
  assert.deepEqual(searchSessions(sessions, 'a'), []);
  assert.deepEqual(searchSessions(sessions, '  '), []);
});

test('search: newest sessions first', () => {
  const r = searchSessions([
    session({ id: 'old', title: 'match', updatedAt: '2026-01-01' }),
    session({ id: 'new', title: 'match', updatedAt: '2026-06-01' }),
  ], 'match');
  assert.deepEqual(r.map((x) => x.id), ['new', 'old']);
});
