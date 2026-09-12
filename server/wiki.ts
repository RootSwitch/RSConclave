/*
 * Local wiki lookups for the document library.
 *
 * A kiwix-serve on the LAN - or a proxy in front of one - reached over HTTP
 * the same way an inference endpoint is. Three calls: the OPDS catalog
 * for which books exist and when each snapshot was taken, /suggest for
 * titles, and the article itself. Then a converter that turns the article's
 * HTML into the plain text a model reads.
 *
 * Nothing is indexed here and no embeddings are involved. The ZIM carries its
 * own title index, and the person picks the article; the app's job is the
 * plumbing and the honesty line at the top of every fetched document saying
 * which snapshot it came from. Absence from that snapshot is not absence from
 * the world, and the line is worded so a model can say so.
 *
 * kiwix's quirks, learned against a real server rather than its docs: the
 * searchable book id is the last segment of the entry's text/html link, not
 * the catalog <name>; /suggest takes `content=` where /search takes
 * `books.name=`; a suggestion's plain title is in `value` and its `label`
 * carries <b> tags.
 */
import { estimate } from './tokens.ts';

export interface WikiBook {
  /** The content path segment: /content/<id>/..., /suggest?content=<id>. */
  id: string;
  title: string;
  /** YYYY-MM-DD, or null when the catalog carries no usable date. Never guessed. */
  snapshot: string | null;
  /** False when the date came from <updated>, an entry timestamp rather than a publication date. */
  snapshotExact: boolean;
  articleCount: number | null;
}

export interface WikiSuggestion {
  title: string;
  /** Relative to the book, as /suggest returns it: "Doom_(1993_video_game)". */
  path: string;
}

export interface WikiArticle {
  title: string;
  /** Everything before the first section heading: the summary and the infobox. */
  lead: string;
  /** The whole article, minus reference lists, navigation and "See also". */
  full: string;
  /** Sections kept in `full`, not counting the lead. */
  sections: number;
}

const TIMEOUT_MS = 15_000;
const MAX_HTML = 8 * 1024 * 1024;
const CATALOG_TTL_MS = 60_000;

function base(url: string): string {
  return url.replace(/\/+$/, '');
}

async function reach(url: string, accept: string, wikiUrl: string): Promise<Response> {
  try {
    return await fetch(url, { headers: { accept }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err: any) {
    const why = err?.name === 'TimeoutError' ? 'timed out' : (err?.message ?? String(err));
    throw new Error(`Cannot reach the local wiki (${wikiUrl}): ${why} - is it running?`);
  }
}

/* ---------- catalog ---------- */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

function decodeXml(s: string): string {
  return s.replace(/&(#39|amp|lt|gt|quot|apos);/g, (m, n) => ENTITIES[n] ?? m);
}

function tagValue(block: string, names: string[]): { value: string; tag: string } | null {
  for (const name of names) {
    const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i');
    const m = re.exec(block);
    if (m) {
      const value = decodeXml(m[1].trim());
      if (value) return { value, tag: name };
    }
  }
  return null;
}

/** The entry's reading link, e.g. /content/wikipedia_en_all_nopic_2024-01. */
function contentHref(block: string): string | null {
  for (const link of block.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/type\s*=\s*["']text\/html["']/i.test(link)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(link);
    if (href) return decodeXml(href[1]);
  }
  return null;
}

// Only a real calendar date counts. <updated> is last: in OPDS it means "when
// this entry changed", which is only incidentally the snapshot date.
const DATE_TAGS = ['dc:issued', 'issued', 'dc:date', 'date', 'updated'];

export function parseCatalog(xml: string): WikiBook[] {
  const books: WikiBook[] = [];
  for (const block of xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? []) {
    const href = contentHref(block);
    if (!href) continue; // no reading link: not something /suggest can search
    let id = '';
    try {
      id = decodeURIComponent(href.replace(/\/+$/, '').split('/').pop() ?? '');
    } catch {
      continue;
    }
    if (!id) continue;
    const title = tagValue(block, ['title', 'dc:title']);
    const date = tagValue(block, DATE_TAGS);
    const count = tagValue(block, ['articleCount', 'dc:articleCount']);
    const m = date ? /^(\d{4})-(\d{2})-(\d{2})/.exec(date.value) : null;
    const snapshot = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
    books.push({
      id,
      title: title?.value ?? id,
      snapshot,
      snapshotExact: Boolean(snapshot) && date?.tag !== 'updated',
      articleCount: count ? Number(count.value) || null : null,
    });
  }
  return books;
}

let catalogCache: { url: string; at: number; books: WikiBook[] } | null = null;

/** The books the wiki serves, cached for a minute so a typeahead does not hammer the catalog. */
export async function listBooks(wikiUrl: string, fresh = false): Promise<WikiBook[]> {
  const url = base(wikiUrl);
  if (!fresh && catalogCache && catalogCache.url === url && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.books;
  }
  const res = await reach(`${url}/catalog/v2/entries`, 'application/atom+xml', wikiUrl);
  if (!res.ok) throw new Error(`the wiki's catalog answered HTTP ${res.status} - is ${wikiUrl} a kiwix-serve or RSCodex address?`);
  const books = parseCatalog(await res.text());
  catalogCache = { url, at: Date.now(), books };
  return books;
}

/* ---------- suggest ---------- */

export async function suggestTitles(wikiUrl: string, bookId: string, term: string, count = 12): Promise<WikiSuggestion[]> {
  const q = new URLSearchParams({ content: bookId, term, count: String(count) });
  const res = await reach(`${base(wikiUrl)}/suggest?${q}`, 'application/json', wikiUrl);
  if (!res.ok) throw new Error(`the wiki answered HTTP ${res.status} to a title search`);
  const data: unknown = await res.json().catch(() => null);
  if (!Array.isArray(data)) return [];
  const out: WikiSuggestion[] = [];
  for (const s of data) {
    if (!s || typeof s !== 'object') continue;
    const item = s as Record<string, unknown>;
    // kind "pattern" is the trailing "search the full text for ..." entry,
    // which is not an article.
    if (item.kind && item.kind !== 'path') continue;
    const path = typeof item.path === 'string' ? item.path : '';
    const title = typeof item.value === 'string' ? item.value.trim() : '';
    if (!path || !title) continue;
    out.push({ title, path });
  }
  return out;
}

/* ---------- article ---------- */

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

/**
 * The article's HTML as stored in the ZIM. /raw/ serves the item untouched;
 * a server old enough to lack it answers 404, and /content/ then serves the
 * same HTML with at most a head tag or two added, which the converter drops.
 */
export async function fetchArticleHtml(wikiUrl: string, bookId: string, path: string): Promise<string> {
  const b = base(wikiUrl);
  const book = encodeURIComponent(bookId);
  const p = encodePath(path);
  for (const url of [`${b}/raw/${book}/content/${p}`, `${b}/content/${book}/${p}`]) {
    const res = await reach(url, 'text/html', wikiUrl);
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      continue;
    }
    if (!res.ok) throw new Error(`the wiki answered HTTP ${res.status} for "${path}"`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_HTML) throw new Error(`"${path}" is ${Math.round(declared / 1e6)} MB of HTML, more than this will read`);
    const html = await res.text();
    if (html.length > MAX_HTML) throw new Error(`"${path}" is larger than this will read`);
    return html;
  }
  throw new Error(`no article at "${path}" in ${bookId}`);
}

/* ---------- HTML to text ---------- */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Whole elements that are never article text. */
const DROP_TAGS = new Set(['nav', 'header', 'footer', 'template', 'svg', 'iframe', 'object', 'audio', 'video', 'button', 'form']);
/**
 * Wikipedia's furniture, by class: navigation boxes, hatnotes, maintenance
 * banners, citation superscripts, the reference lists themselves, category
 * links. Word-matched against the class attribute, so "reference" does not
 * catch "reference-text" (which lives inside a dropped list anyway).
 */
const DROP_CLASSES = new Set([
  'navbox', 'navbox-styles', 'vertical-navbox', 'sidebar', 'hatnote', 'noprint', 'toc', 'mw-editsection',
  'metadata', 'ambox', 'mbox-small', 'sistersitebox', 'side-box', 'catlinks', 'printfooter', 'mw-indicators',
  'mw-jump-link', 'portal', 'portalbox', 'navigation-not-searchable', 'mw-authority-control', 'shortdescription',
  'mw-empty-elt', 'reflist', 'references', 'mw-references-wrap', 'mw-cite-backlink', 'reference', 'mw-ref',
  'noexcerpt', 'last-modified-bar', 'page-actions-menu', 'mw-mf-linked-projects', 'mw-hidden-catlinks',
]);
const DROP_IDS = new Set([
  'toc', 'catlinks', 'mw-navigation', 'footer', 'mw-panel', 'siteSub', 'contentSub', 'contentSub2', 'jump-to-nav',
  'mw-head', 'mw-page-base', 'mw-head-base', 'p-lang', 'page-secondary-actions', 'mw-data-after-content',
]);
/** Sections that are lists of links or citations rather than prose. */
const DROP_SECTIONS = new Set([
  'references', 'notes', 'citations', 'footnotes', 'external links', 'see also', 'further reading', 'bibliography',
  'sources', 'notes and references', 'references and notes', 'explanatory notes', 'works cited', 'general references',
  'general and cited references', 'notes and citations', 'cited works',
]);
/** Paragraph-level elements: a blank line on either side. */
const HARD = new Set([
  'p', 'div', 'section', 'article', 'main', 'table', 'dl', 'blockquote', 'figure', 'details', 'summary', 'pre',
  'center', 'aside',
]);
/** Line-level elements: a line break before, nothing after. */
const SOFT = new Set(['tr', 'caption', 'figcaption', 'dt']);

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...',
  thinsp: ' ', ensp: ' ', emsp: ' ', zwnj: '', zwj: '', shy: '', middot: '.', times: 'x', minus: '-',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return m;
      return String.fromCodePoint(cp);
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

function attr(attrs: string, name: string): string {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
}

function classes(attrs: string): string[] {
  return attr(attrs, 'class').split(/\s+/).filter(Boolean);
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** The article title, from the first h1 or the document title, before any furniture is dropped. */
function titleOf(html: string): string {
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1) {
    const t = stripTags(h1[1]);
    if (t) return t;
  }
  const t = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return t ? stripTags(t[1]) : '';
}

/**
 * Article HTML to plain text with markdown-shaped headings. A tokenizer and a
 * stack rather than a DOM, because there is no DOM here and the HTML a ZIM
 * holds is machine-written and well nested. Elements in the drop sets are
 * skipped whole; everything inside the article body (`.mw-parser-output`
 * when present, `<body>` otherwise) becomes text, with block boundaries as
 * newlines, table rows as `cell | cell`, and list items as `- item`.
 */
export function htmlToText(html: string): string {
  // Raw-text elements first, so a "<" inside a script cannot confuse the tokenizer.
  const src = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|head)\b[\s\S]*?<\/\1\s*>/gi, '');

  let out = '';
  // The element being skipped, with a same-name depth so nested divs inside a
  // dropped div do not end the skip early.
  let skip: { name: string; depth: number } | null = null;
  // Same shape for the article body: emit only inside it once it is found.
  let focus: { name: string; depth: number } | null = null;
  const hasFocus = /\bclass\s*=\s*["'][^"']*\bmw-parser-output\b/i.test(src);
  let emitting = !hasFocus;
  let cell = 0; // td/th depth: list items and line breaks inside a cell stay on the row
  let cellStart = 0; // where the current cell's text began, so a cell does not open with "; "
  let list = 0; // ul/ol depth: nested lists get a line break, not a blank line
  let pre = 0;

  const tag = /<\/?([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(src))) {
    if (m[3] !== undefined) {
      if (!emitting || skip) continue;
      const text = decodeEntities(m[3]);
      out += pre ? text : text.replace(/\s+/g, ' ');
      continue;
    }
    const closing = m[0][1] === '/';
    const name = m[1].toLowerCase();
    const attrs = m[2] ?? '';
    const selfClosed = VOID.has(name) || /\/\s*$/.test(attrs);

    if (skip) {
      if (name === skip.name && !selfClosed) {
        if (closing) {
          if (--skip.depth === 0) skip = null;
        } else skip.depth++;
      }
      continue;
    }

    if (!closing) {
      const cls = classes(attrs);
      const id = attr(attrs, 'id');
      const hidden = /display\s*:\s*none/i.test(attr(attrs, 'style'));
      const drop = DROP_TAGS.has(name) || DROP_IDS.has(id) || hidden || cls.some((c) => DROP_CLASSES.has(c));
      if (drop && !selfClosed) {
        skip = { name, depth: 1 };
        continue;
      }
      if (drop) continue;
      if (!emitting && cls.includes('mw-parser-output')) {
        emitting = true;
        focus = { name, depth: 1 };
        continue;
      }
      if (focus && name === focus.name && !selfClosed) focus.depth++;
    } else if (focus && name === focus.name) {
      if (--focus.depth === 0) {
        focus = null;
        emitting = false;
      }
      continue;
    }
    if (!emitting) continue;

    if (name === 'pre') pre += closing ? -1 : 1;
    const heading = /^h[1-6]$/.test(name);
    if (cell) {
      /*
       * Inside a table cell everything stays on the row: an infobox lists
       * platforms as <li>s and splits dates with <br>, and a row that broke
       * into four lines would read as four facts. Blocks become a space,
       * items and breaks a "; ", and the cell's end trims the last one.
       */
      if (name === 'td' || name === 'th') {
        if (closing) {
          cell--;
          out = out.replace(/[;\s]+$/, '') + ' | ';
        } else {
          cell++;
          cellStart = out.length;
        }
      } else if (!closing && (name === 'li' || name === 'br')) {
        if (out.slice(cellStart).trim()) out += '; ';
      } else if (heading || HARD.has(name) || SOFT.has(name)) out += ' ';
      continue;
    }
    if (!closing) {
      if (heading) {
        const level = Number(name[1]);
        out += `\n\n${'#'.repeat(Math.min(Math.max(level, 2), 4))} `;
      } else if (name === 'li') out += '\n- ';
      else if (name === 'dd') out += '\n  ';
      else if (name === 'td' || name === 'th') {
        cell = 1;
        cellStart = out.length;
      } else if (name === 'ul' || name === 'ol') out += list++ ? '\n' : '\n\n';
      else if (name === 'br' || name === 'hr') out += '\n';
      else if (SOFT.has(name)) out += '\n';
      else if (HARD.has(name)) out += '\n\n';
    } else if (name === 'ul' || name === 'ol') {
      list = Math.max(0, list - 1);
      out += list ? '\n' : '\n\n';
    } else if (heading || HARD.has(name)) out += '\n\n';
  }

  return tidy(out);
}

function tidy(text: string): string {
  const lines = text
    .replace(/[­​‌‍﻿]/g, '')
    .split('\n')
    .map((line) => line
      .replace(/[ \t]+/g, ' ')
      .trim()
      .replace(/^(\|\s*)+/, '')       // a row that opened with empty cells
      .replace(/(\s*\|)+\s*$/, '')    // the separator after the last cell
      .replace(/\|(\s*\|)+/g, '|')    // empty cells in the middle
      .replace(/^- $/, '')            // an item whose content was all dropped
      .trim());
  return lines.join('\n')
    .replace(/\n{3,}/g, '\n\n')
    // A heading and its first line belong together; the blank line between
    // them was the paragraph's, not the section's.
    .replace(/^(#{2,4} [^\n]*)\n\n+/gm, '$1\n')
    .trim();
}

/** Split the converted text at its `## ` headings. Deeper headings stay with their section. */
export function splitSections(text: string): { lead: string; sections: Array<{ heading: string; body: string }> } {
  const sections: Array<{ heading: string; body: string }> = [];
  let lead = '';
  let current: { heading: string; body: string } | null = null;
  for (const line of text.split('\n')) {
    const h = /^## (.*)$/.exec(line);
    if (h) {
      current = { heading: h[1].trim(), body: '' };
      sections.push(current);
    } else if (current) current.body += line + '\n';
    else lead += line + '\n';
  }
  for (const s of sections) s.body = s.body.trim();
  return { lead: lead.trim(), sections };
}

function isDroppedSection(heading: string): boolean {
  return DROP_SECTIONS.has(heading.toLowerCase().replace(/[\s:.]+$/, '').trim());
}

export function articleToText(html: string): WikiArticle {
  const { lead, sections } = splitSections(htmlToText(html));
  const kept = sections.filter((s) => !isDroppedSection(s.heading) && s.body);
  const full = [lead, ...kept.map((s) => `## ${s.heading}\n${s.body}`)].filter(Boolean).join('\n\n');
  return { title: titleOf(html), lead, full, sections: kept.length };
}

/* ---------- the document ---------- */

/**
 * The text that goes into the library. The first line is the point: it says
 * which encyclopedia, which article, and how old the snapshot is, so a model
 * reading it can distinguish "not in this material" from "does not exist".
 */
export function composeDocument(article: WikiArticle, book: WikiBook, scope: 'lead' | 'full'): string {
  const when = book.snapshot
    ? `${book.snapshotExact ? 'dated' : 'from around'} ${book.snapshot}`
    : 'of unknown date';
  const what = scope === 'lead'
    ? 'Summary section only.'
    : 'Full article, with reference lists and navigation omitted.';
  const line = `[${book.title} article "${article.title}", from an offline snapshot ${when}. ${what} ` +
    'Nothing that happened after the snapshot is in this material.]';
  return `${line}\n\n${scope === 'lead' ? article.lead : article.full}`;
}

/** "Doom (1993 video game) - Wikipedia": the article, then the shelf it came off. */
export function documentName(article: WikiArticle, book: WikiBook): string {
  const shelf = book.title.replace(/\s*\(.*$/, '').trim().slice(0, 40) || 'wiki';
  return `${article.title} - ${shelf}`;
}

export function documentTokens(text: string): number {
  return estimate(text);
}
