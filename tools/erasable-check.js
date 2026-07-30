'use strict';
// House rule: TypeScript here must be ERASABLE. Node strips type annotations
// and runs the JavaScript underneath - it never transforms anything - so any
// construct that needs codegen fails at runtime. Scans tracked .ts files and
// exits non-zero. Run: node tools/erasable-check.js
//
// tsconfig.json already sets erasableSyntaxOnly, but that only bites if someone
// runs tsc, and this project has no typescript dependency to run. Enforcement
// was editor-only: a contributor without a TS-aware editor could add an enum and
// nothing in `npm test` would notice. It would fail at runtime instead, and only
// if a test happened to import that particular file.
//
// Keywords like "enum" and "namespace" turn up constantly in prose, so comments,
// strings and regex literals are blanked before scanning. Without that the first
// false positive is a comment explaining why we avoid enums, and a checker that
// cries wolf gets switched off.
//
// This file is .js, so unlike charcheck.js it cannot match itself. The patterns
// below mention every construct they ban and that is fine.
//
// KNOWN GAP: importing a type without the `type` keyword
// (`import { SomeInterface } from './types.ts'`) also breaks at runtime, because
// stripping leaves the import in place and the binding does not exist. Detecting
// it needs cross-file knowledge of which exports are types, which is past what
// this tool should attempt - setting verbatimModuleSyntax in tsconfig.json is the
// right lever for that one.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/*
 * Blank out comments, strings and regex literals, preserving every newline so
 * reported line numbers still line up with the real file.
 *
 * The awkward case is telling a regex literal from a division sign, since both
 * are "/". The rule used here is the standard one: a slash starts a regex unless
 * the previous meaningful character could end a value. The keyword list exists
 * because `return /re/.test(x)` is a regex even though "n" is an identifier
 * character, so looking at the character alone gets it backwards.
 */
function stripNonCode(src) {
    const AFTER_VALUE = /[A-Za-z0-9_$)\]]/;
    const REGEX_AFTER = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void',
        'instanceof', 'new', 'do', 'else', 'yield', 'await']);
    const blank = (s) => s.replace(/[^\n]/g, ' ');

    let out = '';
    let i = 0;
    let lastChar = '';   // last meaningful character emitted
    let lastWord = '';   // identifier currently being emitted, if any

    while (i < src.length) {
        const c = src[i];
        const c2 = src[i + 1];

        if (c === '/' && c2 === '/') {
            const nl = src.indexOf('\n', i);
            const end = nl === -1 ? src.length : nl;
            out += blank(src.slice(i, end));
            i = end;
            continue;
        }
        if (c === '/' && c2 === '*') {
            const close = src.indexOf('*/', i + 2);
            const end = close === -1 ? src.length : close + 2;
            out += blank(src.slice(i, end));
            i = end;
            continue;
        }
        // Template literals are blanked whole, embedded ${...} included. Nothing
        // this tool looks for can be declared inside an interpolation, so the
        // blind spot is harmless.
        if (c === '"' || c === "'" || c === '`') {
            let j = i + 1;
            while (j < src.length) {
                if (src[j] === '\\') { j += 2; continue; }
                if (src[j] === c) { j++; break; }
                j++;
            }
            out += blank(src.slice(i, j));
            i = j;
            lastChar = 'x';
            lastWord = '';
            continue;
        }
        if (c === '/' && (!AFTER_VALUE.test(lastChar) || REGEX_AFTER.has(lastWord))) {
            let j = i + 1;
            let inClass = false;
            while (j < src.length) {
                const d = src[j];
                if (d === '\\') { j += 2; continue; }
                if (d === '\n') break; // unterminated: treat as division after all
                if (inClass) { if (d === ']') inClass = false; }
                else if (d === '[') inClass = true;
                else if (d === '/') { j++; break; }
                j++;
            }
            out += blank(src.slice(i, j));
            i = j;
            lastChar = 'x';
            lastWord = '';
            continue;
        }

        out += c;
        if (!/\s/.test(c)) {
            lastChar = c;
            lastWord = /[A-Za-z0-9_$]/.test(c) ? lastWord + c : '';
        }
        i++;
    }
    return out;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** `declare enum` and `declare namespace` are type-only, so they do erase. */
function isDeclared(code, index) {
    return /\bdeclare\s+$/.test(code.slice(Math.max(0, index - 40), index));
}

/** Span of a balanced (...) starting at openIndex. */
function parenSpan(code, openIndex) {
    let depth = 0;
    for (let i = openIndex; i < code.length; i++) {
        if (code[i] === '(') depth++;
        else if (code[i] === ')') { depth--; if (depth === 0) return code.slice(openIndex, i + 1); }
    }
    return code.slice(openIndex);
}

function scan(src) {
    const code = stripNonCode(src);
    const hits = [];
    const add = (index, what, fix) => hits.push({ line: lineOf(code, index), what, fix });

    let m;

    const enumRe = /(?:\bconst\s+)?\benum\s+[A-Za-z_$]/g;
    while ((m = enumRe.exec(code))) {
        if (!isDeclared(code, m.index)) {
            add(m.index, 'enum declaration', 'use a union of string literals, or an object with `as const`');
        }
    }

    const nsRe = /\b(?:namespace|module)\s+[\w$.]+\s*\{/g;
    while ((m = nsRe.exec(code))) {
        if (!isDeclared(code, m.index)) {
            add(m.index, 'namespace/module block', 'use a separate module file, or a plain object');
        }
    }

    // Parameter properties: constructor(private readonly x). Params are matched
    // by counting parens rather than with [^)]*, because a real signature
    // contains parens of its own - in default values and in function types.
    const ctorRe = /\bconstructor\s*\(/g;
    while ((m = ctorRe.exec(code))) {
        if (code[m.index - 1] === '.') continue; // obj.constructor(...)
        const params = parenSpan(code, code.indexOf('(', m.index));
        const mod = /\b(private|public|protected|readonly)\b/.exec(params);
        if (mod) {
            add(m.index, `parameter property (${mod[1]})`, 'declare the field, then assign it in the constructor body');
        }
    }

    // A bare @name at statement position. In stripped code there is no other
    // legal reason for an @ to be there.
    const decRe = /(?:^|\n)[ \t]*@[A-Za-z_$][\w$]*/g;
    while ((m = decRe.exec(code))) {
        add(m.index + 1, 'decorator', 'call the wrapper function explicitly');
    }

    const importEqRe = /\bimport\s+[A-Za-z_$][\w$]*\s*=\s*require\s*\(/g;
    while ((m = importEqRe.exec(code))) {
        add(m.index, 'import-equals', "use `import x from '...'`");
    }

    const exportEqRe = /\bexport\s*=/g;
    while ((m = exportEqRe.exec(code))) {
        add(m.index, 'export-assignment', 'use named or default exports');
    }

    return hits.sort((a, b) => a.line - b.line);
}

function main() {
    let files;
    try {
        files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
            .split('\n').filter((f) => /\.(ts|mts|cts)$/.test(f));
    } catch (_) {
        console.error('erasable-check: not a git checkout - nothing to scan');
        process.exit(0);
    }

    let bad = 0;
    for (const rel of files) {
        let text;
        try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (_) { continue; }
        for (const hit of scan(text)) {
            console.error(`${rel}:${hit.line}: ${hit.what} - ${hit.fix}`);
            bad++;
        }
    }

    if (bad > 0) {
        console.error(`erasable-check: ${bad} non-erasable construct${bad === 1 ? '' : 's'} - ` +
            'Node strips types, it does not transform them');
        process.exit(1);
    }
    console.log(`ok - erasable-check clean (${files.length} TypeScript files)`);
}

if (require.main === module) main();
// Exported so the scanner can be tested directly, the same shim
// public/markdown.js uses for its pure half.
module.exports = { scan, stripNonCode };
