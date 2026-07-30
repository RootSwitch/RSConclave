import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
// tools/erasable-check.js is a CommonJS CLI with a module.exports shim, exactly
// like public/markdown.js, so the scanner half can be tested here.
const require2 = createRequire(import.meta.url);
const { scan, stripNonCode } = require2('../../tools/erasable-check.js');

// Fixtures live in template literals on purpose: the checker blanks strings
// before scanning, so this file does not trip its own rules.

test('erasable: clean TypeScript produces nothing', () => {
  const src = `
    export interface Endpoint { id: string; kind: 'ollama' | 'openai' }
    export type Phase = 'idle' | 'generating';
    declare const VERSION: string;
    export abstract class Base<T> { abstract run(x: T): Promise<void>; }
    const modes = ['chat', 'council'] as const;
    export function pick<T>(xs: T[]): T | undefined { return xs.at(-1); }
    class Ok { private n = 0; constructor(n: number) { this.n = n; } }
  `;
  assert.deepEqual(scan(src), []);
});

test('erasable: flags enum and const enum, but not declare enum', () => {
  assert.equal(scan(`enum Color { Red }`).length, 1);
  assert.equal(scan(`const enum Color { Red }`).length, 1);
  assert.equal(scan(`declare enum Color { Red }`).length, 0);
  assert.match(scan(`enum Color { Red }`)[0].what, /enum/);
});

test('erasable: flags namespace and module blocks, but not declare namespace', () => {
  assert.equal(scan(`namespace Utils { export const x = 1; }`).length, 1);
  assert.equal(scan(`module Legacy.Thing { }`).length, 1);
  assert.equal(scan(`declare namespace NodeJS { interface Global {} }`).length, 0);
});

test('erasable: flags parameter properties', () => {
  assert.equal(scan(`class A { constructor(private x: number) {} }`).length, 1);
  assert.equal(scan(`class A { constructor(readonly x: number) {} }`).length, 1);
  assert.equal(scan(`class A { constructor(x: number) { this.x = x; } }`).length, 0);
  assert.match(scan(`class A { constructor(protected x: number) {} }`)[0].what, /protected/);
});

test('erasable: parameter scan counts parens, so nested signatures do not hide one', () => {
  // [^)]* would stop at the first ")" inside the function type and miss `private`.
  const src = `class A { constructor(cb: (a: string) => void, private dep: Map<string, () => number>) {} }`;
  assert.equal(scan(src).length, 1);
  // And a clean constructor with the same shape stays clean.
  const ok = `class B { constructor(cb: (a: string) => void, dep: Map<string, () => number>) {} }`;
  assert.deepEqual(scan(ok), []);
});

test('erasable: ignores a constructor accessed as a property', () => {
  assert.deepEqual(scan(`const c = obj.constructor(1);`), []);
});

test('erasable: flags decorators, import-equals and export-assignment', () => {
  assert.equal(scan(`  @Injectable\n  class S {}`).length, 1);
  assert.equal(scan(`import fs = require('node:fs');`).length, 1);
  assert.equal(scan(`export = handler;`).length, 1);
});

/*
 * The false-positive guards matter more than the detections. A checker that
 * fires on a comment explaining why we avoid enums is a checker someone
 * disables, and then it protects nothing.
 */
test('erasable: keywords in comments and strings are not flagged', () => {
  assert.deepEqual(scan(`// we deliberately avoid enum here, use a union instead`), []);
  assert.deepEqual(scan(`/* namespace blocks need codegen, so they are banned */`), []);
  assert.deepEqual(scan(`const help = 'pass enum Color { Red } to see it rejected';`), []);
  assert.deepEqual(scan(`const t = \`namespace Foo { }\`;`), []);
});

test('erasable: a regex literal does not desync the scanner', () => {
  // The quotes inside this regex would open a phantom string in a naive
  // scanner, swallowing whatever followed.
  const src = `const q = /['"\`]/g;\nenum Sneaky { A }`;
  const hits = scan(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
});

test('erasable: division is not mistaken for a regex', () => {
  const src = `const half = (total + 1) / 2;\nconst ratio = width / height;\nenum After { A }`;
  const hits = scan(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
});

test('erasable: a regex after a keyword is still a regex', () => {
  // "return /x/" is a regex even though the preceding character is a letter.
  const src = `function f(s: string) { return /a['"]b/.test(s); }\nenum After { A }`;
  const hits = scan(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
});

test('erasable: stripNonCode preserves line numbering', () => {
  const src = `const a = 1; // note\n/* two\n   lines */\nconst s = 'x';\n`;
  assert.equal(stripNonCode(src).split('\n').length, src.split('\n').length);
});

test('erasable: reports the line the construct is on', () => {
  const src = `// header\n\nexport interface A { x: number }\n\nenum B { C }\n`;
  assert.deepEqual(scan(src).map((h: { line: number }) => h.line), [5]);
});
