import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { BIG_BODY, SMALL_BODY, readJsonBody, tooLargeMessage } from '../router.ts';
import { requireText } from '../errors.ts';

/** A request as readJsonBody sees one: a stream with headers. */
function request(body: string, declareLength: boolean): IncomingMessage {
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  (req as any).headers = declareLength ? { 'content-length': String(Buffer.byteLength(body)) } : {};
  queueMicrotask(() => {
    // In pieces, as a real upload arrives, so the running count is exercised.
    for (let i = 0; i < body.length; i += 64 * 1024) req.write(body.slice(i, i + 64 * 1024));
    req.end();
  });
  return req;
}

// A file the size of the DIGEST.md that a chat refused and a council accepted:
// 236,000 characters, markdown, a newline every 64 or so.
const digest = Array.from({ length: 3669 }, (_, i) => `line ${i}: ${'x'.repeat(57)}`).join('\n').slice(0, 236_000);

test('a DIGEST-sized message now goes through a chat the way it went through a council', async () => {
  for (const declared of [true, false]) {
    const body = await readJsonBody(request(JSON.stringify({ text: digest }), declared));
    assert.equal(requireText(body.text, 'message').length, digest.trim().length);
  }
});

test('over the cap: refused with a 413 that says the limit and where a big file goes', async () => {
  const huge = JSON.stringify({ text: 'y'.repeat(1024 * 1024 + 10) });
  for (const declared of [true, false]) {
    await assert.rejects(readJsonBody(request(huge, declared)), (err: any) => {
      assert.equal(err.status, 413);
      assert.match(err.message, /^That is too large to send: the limit is 1 MB per message/);
      assert.match(err.message, /roughly 250,000 tokens/);
      assert.match(err.message, /document library/);
      return true;
    }, declared ? 'refused on the declared length, before reading' : 'refused while streaming');
  }
});

test('tooLargeMessage: other caps state their own size, without the document-library advice', () => {
  assert.equal(tooLargeMessage(SMALL_BODY), 'That is too large to send: the limit here is 4 KB.');
  assert.equal(tooLargeMessage(BIG_BODY), 'That is too large to send: the limit here is 10 MB.');
});
