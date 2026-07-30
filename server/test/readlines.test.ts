import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLines } from '../providers.ts';

/** A stream that emits exactly the byte chunks given, then closes. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) c.enqueue(chunks[i++]);
      else c.close();
    },
  });
}

const bytes = (s: string) => new TextEncoder().encode(s);

async function collect(chunks: Uint8Array[]): Promise<string[]> {
  const out: string[] = [];
  for await (const line of readLines(streamOf(chunks), new AbortController().signal)) out.push(line);
  return out;
}

test('readLines: splits on newlines across chunk boundaries', async () => {
  assert.deepEqual(await collect([bytes('one\ntw'), bytes('o\nthree\n')]), ['one', 'two', 'three']);
});

test('readLines: strips CR from CRLF lines', async () => {
  assert.deepEqual(await collect([bytes('a\r\nb\r\n')]), ['a', 'b']);
});

test('readLines: strips CR from a final line with no newline', async () => {
  // The tail used to skip the CR strip that every other line got.
  assert.deepEqual(await collect([bytes('a\r\ntail\r')]), ['a', 'tail']);
});

test('readLines: a truncated final character is reported, not silently dropped', async () => {
  /*
   * Every decode() passes {stream: true}, which holds back the bytes of a
   * character that might continue in the next chunk. If the stream simply STOPS
   * there, those bytes sat in the decoder and the missing flush dropped them
   * without a trace. The flush turns them into U+FFFD instead, so a truncated
   * response looks truncated.
   *
   * Note the narrow scope: a COMPLETE character split across the last two
   * chunks already worked (the test below), so this only bites when a stream is
   * cut off mid-character. Written the other way round first, the test passed
   * against the unfixed code and proved nothing.
   */
  const euro = bytes('cost: €'); // the euro sign is e2 82 ac
  const truncated = euro.slice(0, euro.length - 1); // drop its last byte
  assert.deepEqual(await collect([truncated]), ['cost: �']);
});

test('readLines: a character split across chunks mid-line survives', async () => {
  const b = bytes('a€b\n');
  assert.deepEqual(await collect([b.slice(0, 2), b.slice(2)]), ['a€b']);
});

test('readLines: the flush can complete a final newline-terminated line', async () => {
  const b = bytes('x€\n');
  assert.deepEqual(await collect([b.slice(0, 2), b.slice(2)]), ['x€']);
});

test('readLines: blank trailing buffer yields nothing extra', async () => {
  assert.deepEqual(await collect([bytes('a\n   ')]), ['a']);
});
