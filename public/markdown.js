// Minimal markdown for model output. Two layers on purpose:
//  - parseMarkdown(text): pure text -> block tree, no DOM, so node:test can
//    exercise it (server/test/markdown.test.ts loads this file via require -
//    hence the module.exports shim at the bottom).
//  - mdRender(container, text): browser-only, builds real DOM nodes from the
//    tree. Model output NEVER passes through innerHTML: "<script>" in a
//    reply stays six literal characters.
//
// Coverage is what local models actually emit: #-headings, **bold**,
// *italic*, `code`, ``` fences, - / 1. lists, | tables |, --- rules. Plus a
// translation table for the LaTeX symbol tokens some models (Gemma
// especially) sprinkle into prose, which no markdown renderer would touch:
// "$\rightarrow$" reads as an arrow, not as TeX source.
'use strict';

// \left..\right pairs and $-wrapped singles both appear in the wild.
const MD_LATEX = [
  ['rightarrow', '→'], ['Rightarrow', '⇒'], ['to', '→'],
  ['leftarrow', '←'], ['Leftarrow', '⇐'],
  ['leftrightarrow', '↔'], ['uparrow', '↑'], ['downarrow', '↓'],
  ['times', '×'], ['approx', '≈'], ['neq', '≠'], ['ne', '≠'],
  ['leq', '≤'], ['le', '≤'], ['geq', '≥'], ['ge', '≥'],
  ['pm', '±'], ['infty', '∞'], ['cdot', '·'], ['deg', '°'],
];

function mdReplaceLatex(text) {
  for (const [name, sym] of MD_LATEX) {
    // "$\rightarrow$", "\rightarrow" - with or without the $ wrappers
    text = text.replaceAll('$\\' + name + '$', sym);
    // word boundary so \to does not eat \total
    text = text.replace(new RegExp('\\\\' + name + '(?![A-Za-z])', 'g'), sym);
  }
  return text;
}

// --- inline: text -> [{t:'text'|'bold'|'italic'|'code', s:string}] ---
function mdInline(text) {
  const out = [];
  let i = 0;
  const plain = (s) => { if (s) out.push({ t: 'text', s }); };
  while (i < text.length) {
    const rest = text.slice(i);
    let m;
    if ((m = rest.match(/^`([^`]+)`/))) {
      out.push({ t: 'code', s: m[1] });
    } else if ((m = rest.match(/^\*\*([^*]+)\*\*/))) {
      out.push({ t: 'bold', s: m[1] });
    } else if ((m = rest.match(/^\*([^*\s][^*]*)\*/))) {
      out.push({ t: 'italic', s: m[1] });
    } else {
      const next = rest.slice(1).search(/[`*]/);
      const upto = next === -1 ? rest.length : next + 1;
      plain(rest.slice(0, upto));
      i += upto;
      continue;
    }
    i += m[0].length;
  }
  return out;
}

// --- blocks ---
function parseMarkdown(raw) {
  const lines = mdReplaceLatex(raw.replace(/\r\n/g, '\n')).split('\n');
  const blocks = [];
  let i = 0;
  const isTableLine = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isSepLine = (l) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes('-');

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) { i++; continue; }

    let fence;
    if ((fence = line.match(/^\s*```\s*(\S*)/))) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence (or EOF)
      // The info string is the model TELLING us the format - the same
      // convention every chat app leans on for badges and file extensions.
      blocks.push({ t: 'pre', s: buf.join('\n'), lang: fence[1].toLowerCase() });
      continue;
    }

    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      blocks.push({ t: 'h', level: m[1].length, inline: mdInline(m[2]) });
      i++;
      continue;
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { blocks.push({ t: 'hr' }); i++; continue; }

    if (isTableLine(line) && i + 1 < lines.length && isTableLine(lines[i + 1]) && isSepLine(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => mdInline(c.trim()));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableLine(lines[i])) rows.push(cells(lines[i++]));
      blocks.push({ t: 'table', head, rows });
      continue;
    }

    if ((m = line.match(/^\s*([-*]|\d+\.)\s+/))) {
      const ordered = /\d/.test(m[1]);
      const items = [];
      while (i < lines.length && (m = lines[i].match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/))) {
        items.push(mdInline(m[1]));
        i++;
      }
      blocks.push({ t: 'list', ordered, items });
      continue;
    }

    // paragraph: consecutive non-blank, non-structural lines; single
    // newlines inside stay as breaks - models use them for layout
    const buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*```/.test(lines[i]) &&
           !/^#{1,6}\s/.test(lines[i]) && !isTableLine(lines[i]) &&
           !/^\s*(?:[-*]|\d+\.)\s+/.test(lines[i]) && !/^\s*(---+|\*\*\*+)\s*$/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    blocks.push({ t: 'p', lines: buf.map(mdInline) });
  }
  return blocks;
}

// Fence info string -> a filename for "save". Pure so the test suite can
// pin the mapping. Unknown or missing labels fall back to .txt - a wrong
// extension is a rename, a failed save is a bug report.
const MD_EXT = {
  powershell: 'ps1', ps1: 'ps1', python: 'py', py: 'py',
  javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts',
  bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh',
  batch: 'cmd', bat: 'cmd', cmd: 'cmd',
  csv: 'csv', tsv: 'tsv', json: 'json', yaml: 'yml', yml: 'yml',
  xml: 'xml', html: 'html', css: 'css', sql: 'sql',
  markdown: 'md', md: 'md', toml: 'toml', ini: 'ini', diff: 'diff',
  c: 'c', cpp: 'cpp', java: 'java', go: 'go', rust: 'rs', rs: 'rs',
  ruby: 'rb', rb: 'rb', php: 'php', kotlin: 'kt', swift: 'swift',
};
function mdFileName(lang) {
  if (lang === 'dockerfile') return 'Dockerfile';
  return 'snippet.' + (MD_EXT[lang] ?? 'txt');
}

// --- DOM (browser only; the el() helper comes from app.js) ---

function mdSaveButton(getText, lang) {
  return el('button', { class: 'mini', title: 'Save this block as a file', onclick: () => {
    const url = URL.createObjectURL(new Blob([getText()], { type: 'text/plain' }));
    const a = el('a', { href: url, download: mdFileName(lang) });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } }, 'save');
}
function mdRender(container, text) {
  container.classList.add('md');
  const inline = (parts) => parts.map((p) =>
    p.t === 'bold' ? el('strong', {}, p.s)
      : p.t === 'italic' ? el('em', {}, p.s)
        : p.t === 'code' ? el('code', {}, p.s)
          : document.createTextNode(p.s));

  for (const b of parseMarkdown(text)) {
    if (b.t === 'h') {
      container.append(el('div', { class: `md-h md-h${b.level}` }, ...inline(b.inline)));
    } else if (b.t === 'pre') {
      container.append(el('div', { class: 'md-codeblock' },
        el('div', { class: 'md-codebar' },
          el('span', { class: 'md-lang' }, b.lang || 'text'),
          el('span', { class: 'grow' }),
          copyButton(() => b.s),
          mdSaveButton(() => b.s, b.lang)),
        el('pre', {}, el('code', {}, b.s))));
    } else if (b.t === 'hr') {
      container.append(el('hr', {}));
    } else if (b.t === 'table') {
      container.append(el('div', { class: 'md-tablewrap' },
        el('table', {},
          el('thead', {}, el('tr', {}, ...b.head.map((c) => el('th', {}, ...inline(c))))),
          el('tbody', {}, ...b.rows.map((r) => el('tr', {}, ...r.map((c) => el('td', {}, ...inline(c)))))))));
    } else if (b.t === 'list') {
      container.append(el(b.ordered ? 'ol' : 'ul', {}, ...b.items.map((it) => el('li', {}, ...inline(it)))));
    } else {
      const p = el('p', {});
      b.lines.forEach((lineParts, idx) => {
        if (idx > 0) p.append(el('br', {}));
        p.append(...inline(lineParts));
      });
      container.append(p);
    }
  }
}

// node:test loads the pure parser through this; browsers ignore it
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseMarkdown, mdInline, mdReplaceLatex, mdFileName };
}
