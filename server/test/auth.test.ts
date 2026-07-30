import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, noteLoginAttempt, parseCookies, recordLoginSuccess, validUsername, verifyPassword } from '../auth.ts';

test('hashPassword/verifyPassword: round trip', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.ok(stored.startsWith('scrypt$'));
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
});

test('verifyPassword: wrong password fails', async () => {
  const stored = await hashPassword('right');
  assert.equal(await verifyPassword('wrong', stored), false);
});

test('verifyPassword: two hashes of the same password differ (fresh salt)', async () => {
  const a = await hashPassword('same');
  const b = await hashPassword('same');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same', a), true);
  assert.equal(await verifyPassword('same', b), true);
});

test('verifyPassword: garbage stored value fails instead of throwing', async () => {
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
  assert.equal(await verifyPassword('x', ''), false);
  assert.equal(await verifyPassword('x', 'scrypt$N=16384$bad$bad'), false);
});

test('validUsername: usernames become directory names, so paths are rejected', () => {
  assert.equal(validUsername('alice'), true);
  assert.equal(validUsername('bob.smith-2_x'), true);
  assert.equal(validUsername('AB'), true);
  // the dangerous shapes
  assert.equal(validUsername('..'), false);
  assert.equal(validUsername('.hidden'), false);
  assert.equal(validUsername('../escape'), false);
  assert.equal(validUsername('a/b'), false);
  assert.equal(validUsername('a\\b'), false);
  // the merely invalid shapes
  assert.equal(validUsername('a'), false); // too short
  assert.equal(validUsername('x'.repeat(33)), false); // too long
  assert.equal(validUsername(''), false);
  assert.equal(validUsername('has space'), false);
});

test('parseCookies: normal, malformed, and missing headers', () => {
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookies(undefined), {});
  // an undecodable value must be skipped, not throw
  assert.deepEqual(parseCookies('bad=%; good=ok'), { good: 'ok' });
  assert.equal(parseCookies('rsconclave_session=tok123; x=y').rsconclave_session, 'tok123');
});

/*
 * The counting has to happen at the START of an attempt. When it ran after the
 * awaited scrypt, concurrent requests all passed the check before any of them
 * had recorded a failure - the review tried 60 passwords at once for zero 429s.
 * These tests use distinct IPs because the limiter is per source address.
 */
test('noteLoginAttempt: allows MAX_FAILURES attempts then locks the IP out', () => {
  const ip = 'test-ip-lockout';
  for (let i = 0; i < 5; i++) {
    assert.equal(noteLoginAttempt(ip), true, `attempt ${i + 1} should be allowed`);
  }
  assert.equal(noteLoginAttempt(ip), false, 'the 6th attempt must be refused');
  assert.equal(noteLoginAttempt(ip), false, 'and it stays refused');
});

test('noteLoginAttempt: a successful sign-in clears the count', () => {
  const ip = 'test-ip-success';
  noteLoginAttempt(ip);
  noteLoginAttempt(ip);
  recordLoginSuccess(ip);
  // Back to a full budget: someone who mistyped twice and then got it right
  // must not be one attempt away from a lockout.
  for (let i = 0; i < 5; i++) assert.equal(noteLoginAttempt(ip), true);
});

test('noteLoginAttempt: lockouts are per IP', () => {
  const a = 'test-ip-a';
  const b = 'test-ip-b';
  for (let i = 0; i < 6; i++) noteLoginAttempt(a);
  assert.equal(noteLoginAttempt(a), false);
  assert.equal(noteLoginAttempt(b), true, 'one attacker must not lock everyone else out');
});
