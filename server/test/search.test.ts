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

test('search: matches tags', () => {
  // Tags render in the sidebar and drive its filter chips; searching for one
  // that appears nowhere else must still find the session.
  const r = searchSessions([
    session({ id: 'tagged', title: 'Untitled', tags: ['paccourt', 'demo'] }),
    session({ id: 'untagged', title: 'Also untitled' }),
  ], 'paccourt');
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'tagged');
  assert.equal(r[0].hits[0].speaker, 'tags');
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

test('search: snippet stays on the match when case-folding changes length', () => {
  /*
   * "İ" lowercases to two code units, so an index taken from the lowercased
   * copy pointed past the real match in the original and the snippet slid off it.
   */
  const lead = 'İ'.repeat(30);
  const sessions = [session({ entries: [entry('m', `${lead} the needle is here`)] })];
  const [r] = searchSessions(sessions, 'needle');
  assert.ok(r, 'the match must still be found');
  assert.match(r.hits[0].snippet, /needle/, 'the snippet must contain what was searched for');
});

test('search: ordinary text is unaffected by the offset mapping', () => {
  const sessions = [session({ entries: [entry('m', 'a'.repeat(200) + ' findme ' + 'b'.repeat(200))] })];
  const [r] = searchSessions(sessions, 'FINDME');
  assert.match(r.hits[0].snippet, /findme/);
  assert.match(r.hits[0].snippet, /^…/);
  assert.match(r.hits[0].snippet, /…$/);
});
