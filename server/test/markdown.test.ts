import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
// The renderer is a browser script with a CommonJS shim exactly so the pure
// parser half stays testable here.
const require2 = createRequire(import.meta.url);
const { parseMarkdown, mdInline, mdReplaceLatex, mdFileName } = require2('../../public/markdown.js');

/*
 * Regression: a table-looking line with no separator row under it used to spin
 * parseMarkdown forever, freezing the tab. Models emit bare pipe rows
 * constantly, so this was the most likely field crash in the app. The timeout
 * is the assertion - a hang here fails the suite rather than wedging it.
 */
test('markdown: a bare pipe row does not hang the parser', { timeout: 3000 }, () => {
  const kinds = (src: string) => parseMarkdown(src).map((b: { t: string }) => b.t);
  assert.deepEqual(kinds('| a | b |'), ['p']);
  assert.deepEqual(kinds('| a | b |\n| c | d |'), ['p', 'p']);
  assert.deepEqual(kinds('|'), ['p']);
  assert.deepEqual(kinds('text\n| a | b |'), ['p', 'p']);
  // a well-formed table must still be a table
  const ok = parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.equal(ok.length, 1);
  assert.equal(ok[0].t, 'table');
});

// A fence labelled ```constructor used to resolve through Object.prototype and
// produce "snippet.function Object() { [native code] }" as a download name.
test('markdown: prototype keys as a fence language fall back to .txt', () => {
  assert.equal(mdFileName('py'), 'snippet.py');
  assert.equal(mdFileName('constructor'), 'snippet.txt');
  assert.equal(mdFileName('__proto__'), 'snippet.txt');
  assert.equal(mdFileName('toString'), 'snippet.txt');
});

test('markdown: headings, paragraphs and rules', () => {
  const b = parseMarkdown('### Summary\n\nSome text.\n\n---');
  assert.equal(b[0].t, 'h');
  assert.equal(b[0].level, 3);
  assert.equal(b[1].t, 'p');
  assert.equal(b[2].t, 'hr');
});

test('markdown: inline bold, italic, code', () => {
  const parts = mdInline('a **bold** and *ital* and `code` end');
  assert.deepEqual(parts.map((p: any) => p.t), ['text', 'bold', 'text', 'italic', 'text', 'code', 'text']);
  assert.equal(parts[1].s, 'bold');
  assert.equal(parts[5].s, 'code');
});

test('markdown: fenced code keeps content verbatim, including markup', () => {
  const b = parseMarkdown('```\n**not bold** <script>alert(1)</script>\n```');
  assert.equal(b[0].t, 'pre');
  assert.equal(b[0].s, '**not bold** <script>alert(1)</script>');
});

test('markdown: tables parse into head and rows', () => {
  const b = parseMarkdown([
    '| Feature | G.711 | T.38 |',
    '| :--- | :--- | :--- |',
    '| **Method** | audio | data |',
    '| Reliability | Low | High |',
  ].join('\n'));
  assert.equal(b[0].t, 'table');
  assert.equal(b[0].head.length, 3);
  assert.equal(b[0].rows.length, 2);
  assert.equal(b[0].rows[0][0][0].t, 'bold'); // **Method** cell
});

test('markdown: ordered and unordered lists', () => {
  const b = parseMarkdown('- one\n- two\n\n1. first\n2. second');
  assert.equal(b[0].t, 'list');
  assert.equal(b[0].ordered, false);
  assert.equal(b[0].items.length, 2);
  assert.equal(b[1].ordered, true);
});

test('markdown: latex symbol tokens become symbols', () => {
  assert.equal(mdReplaceLatex('Analog $\\rightarrow$ IP'), 'Analog → IP');
  assert.equal(mdReplaceLatex('a \\times b \\approx c'), 'a × b ≈ c');
  assert.equal(mdReplaceLatex('x \\leq 5, y \\geq 2'), 'x ≤ 5, y ≥ 2');
});

test('markdown: latex replacement respects word boundaries', () => {
  // \to must convert, but never inside a longer command name
  assert.equal(mdReplaceLatex('a \\to b'), 'a → b');
  assert.equal(mdReplaceLatex('\\total'), '\\total');
});

test('markdown: html in prose stays literal text in the parse tree', () => {
  const b = parseMarkdown('try <script>alert(1)</script> now');
  assert.equal(b[0].t, 'p');
  const flat = b[0].lines[0].map((p: any) => p.s).join('');
  assert.ok(flat.includes('<script>alert(1)</script>'));
});

test('markdown: fence info string is captured and lowercased', () => {
  const b = parseMarkdown('```PowerShell\nGet-ChildItem\n```\n\n```\nbare\n```');
  assert.equal(b[0].lang, 'powershell');
  assert.equal(b[1].lang, '');
});

test('markdown: mdFileName maps labels to extensions', () => {
  assert.equal(mdFileName('powershell'), 'snippet.ps1');
  assert.equal(mdFileName('csv'), 'snippet.csv');
  assert.equal(mdFileName('yaml'), 'snippet.yml');
  assert.equal(mdFileName('dockerfile'), 'Dockerfile');
  assert.equal(mdFileName('klingon'), 'snippet.txt');
  assert.equal(mdFileName(''), 'snippet.txt');
});
