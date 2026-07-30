import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputError, requireText } from '../errors.ts';
import { HttpError } from '../router.ts';

test('HttpError is an InputError, so dispatch maps both onto their status', () => {
  assert.ok(new HttpError(404, 'nope') instanceof InputError);
  assert.equal(new HttpError(409, 'busy').status, 409);
});

test('a plain Error is NOT an InputError, so real faults stay 500', () => {
  // The whole point of the split: mapping unknown throws to 400 would hide bugs.
  assert.equal(new Error('undefined is not a function') instanceof InputError, false);
});

test('InputError defaults to 400', () => {
  assert.equal(new InputError('bad').status, 400);
});

test('requireText rejects non-strings rather than letting .trim throw', () => {
  // This is the 500 the review found: `text?.trim()` passes a number through.
  assert.throws(() => requireText(123, 'text'), /text must be text/);
  assert.throws(() => requireText(null, 'text'), /text must be text/);
  assert.throws(() => requireText({}, 'text'), /text must be text/);
});

test('requireText rejects blank and whitespace-only input', () => {
  assert.throws(() => requireText('', 'message'), /message is empty/);
  assert.throws(() => requireText('   \n\t ', 'message'), /message is empty/);
});

test('requireText returns the trimmed string and enforces a limit', () => {
  assert.equal(requireText('  hello  ', 'text'), 'hello');
  assert.throws(() => requireText('abcdef', 'text', 3), /too long/);
});

test('requireText failures carry a 400', () => {
  try {
    requireText(undefined, 'text');
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal((err as InputError).status, 400);
  }
});
