import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {
  WikiCertError, articleToText, composeDocument, documentName, fetchArticleHtml, htmlToText, listBooks, parseCatalog,
  probeCertificate,
  splitSections, suggestTitles,
} from '../wiki.ts';

/*
 * The fixtures are fictional (RFC 2606 names, invented titles), so nothing
 * about a real deployment or a real encyclopedia lives in a tracked file.
 * The markup shapes are real: the Minerva skin mwoffliner wrote in 2024 and
 * the Vector 2022 skin it writes now, which share nothing above
 * .mw-parser-output.
 */

const CATALOG = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/">
  <entry>
    <id>urn:uuid:11111111-1111-4111-8111-111111111111</id>
    <title>Foxglove Encyclopaedia (text &amp; tables)</title>
    <updated>2026-02-11T00:00:00Z</updated>
    <name>foxglove_en_all_nopic</name>
    <articleCount>6412300</articleCount>
    <dc:issued>2026-01-04T00:00:00Z</dc:issued>
    <link rel="http://opds-spec.org/acquisition/open-access" type="application/x-zim" href="/content/foxglove_en_all_nopic_2026-01.zim"/>
    <link type="text/html" href="/content/foxglove_en_all_nopic_2026-01"/>
  </entry>
  <entry>
    <id>urn:uuid:22222222-2222-4222-8222-222222222222</id>
    <title>Thistlewood Dictionary</title>
    <updated>2025-11-20T00:00:00Z</updated>
    <name>thistlewood_en_all</name>
    <link type="text/html" href="/content/thistlewood_en_all"/>
  </entry>
  <entry>
    <id>urn:uuid:33333333-3333-4333-8333-333333333333</id>
    <title>Marlow Question Archive</title>
    <link type="text/html" href="/content/marlow_qa"/>
  </entry>
  <entry>
    <id>urn:uuid:44444444-4444-4444-8444-444444444444</id>
    <title>No reading link at all</title>
  </entry>
</feed>`;

/** Minerva, as the 2024 nopic snapshot has it: sections wrapped, headings with mw-headline spans. */
const MINERVA = `<!DOCTYPE html><html class="client-js"><head><meta charset="utf-8"><title>Foxglove (video game)</title>
<style data-mw-deduplicate="TemplateStyles:r1">.infobox{border:1px solid #a2a9b1}</style>
<script>window.RLQ = []; if (1 < 2) { document.title = "x"; }</script>
<link rel="stylesheet" href="../-/s/style.css"></head>
<body class="mediawiki skin-minerva"><div id="mw-mf-viewport"><div id="mw-mf-page-center">
<div class="pre-content heading-holder"><h1 id="section_0" class="firstHeading">Foxglove (video game)</h1></div>
<div id="content" class="mw-body"><div id="bodyContent" class="content mw-parser-output">
<section class="mf-section-0" id="mf-section-0">
<div class="shortdescription nomobile noexcerpt" style="display:none">1994 video game</div>
<div role="note" class="hatnote navigation-not-searchable">For the plant, see <a href="Foxglove">Foxglove</a>.</div>
<table class="infobox ib-video-game hproduct"><caption class="infobox-title">Foxglove</caption><tbody>
<tr><th scope="row">Developer(s)</th><td>Thistlewood Software</td></tr>
<tr><th scope="row">Platform(s)</th><td><div class="plainlist"><ul><li>MS-DOS</li><li>Amiga</li></ul></div></td></tr>
<tr><th scope="row">Release</th><td>12 March 1994<br>Amiga: 1995</td></tr>
<tr><th scope="row">Mode(s)</th><td>Single-player, <span class="nowrap">multiplayer</span></td></tr>
</tbody></table>
<p><b>Foxglove</b> is a 1994 <a href="First-person_shooter">first-person shooter</a> developed by
<a href="Thistlewood_Software">Thistlewood Software</a>.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup>
It sold 200,000&nbsp;copies<sup class="noprint Inline-Template">[<i>citation needed</i>]</sup> and was the studio&#8217;s
first &amp; last release.<sup id="cite_ref-2" class="mw-ref reference"><a href="#cite_note-2">[2]</a></sup></p>
<span data-sort-value="000" style="display:none">sortkey</span>
</section>
<section class="mf-section-1"><h2 class="section-heading"><span class="mw-headline" id="Gameplay">Gameplay</span></h2>
<p>The player explores twelve levels.</p>
<h3 class="in-block"><span class="mw-headline" id="Weapons">Weapons</span></h3>
<p>Six weapons are available.</p></section>
<section class="mf-section-2"><h2 class="section-heading"><span class="mw-headline" id="Reception">Reception</span></h2>
<table class="wikitable"><tr><th>Publication</th><th>Score</th></tr><tr><td>Marlow Gazette</td><td>9/10</td></tr></table>
<p>Critics praised the level design.</p></section>
<section class="mf-section-3"><h2 class="section-heading"><span class="mw-headline" id="See_also">See also</span></h2>
<ul><li><a href="Foxglove_II">Foxglove II</a></li></ul></section>
<section class="mf-section-4"><h2 class="section-heading"><span class="mw-headline" id="References">References</span></h2>
<div class="reflist"><ol class="references"><li id="cite_note-1">Marlow Gazette, 1994.</li><li id="cite_note-2">Interview, 2001.</li></ol></div></section>
<section class="mf-section-5"><h2 class="section-heading"><span class="mw-headline" id="External_links">External links</span></h2>
<ul><li><a href="https://example.com/foxglove">Official site</a></li></ul></section>
<div class="navbox"><table><tr><td>Thistlewood Software games: Foxglove, Foxglove II, Bramble</td></tr></table></div>
</div></div>
<div id="page-secondary-actions"><a href="#">Languages</a></div>
<div class="last-modified-bar">Last edited 3 years ago</div>
</div></div>
<footer id="footer"><p>Content is available under CC BY-SA.</p></footer>
</body></html>`;

/** Vector 2022, as the 2026 snapshots have it: headings in mw-heading wrappers, bare mw-ref sups. */
const VECTOR = `<!DOCTYPE html><html><head><title>Bramble (video game)</title></head>
<body class="skin-vector-2022"><div class="mw-page-container"><header class="mw-body-header vector-page-titlebar">
<h1 id="firstHeading" class="firstHeading mw-first-heading"><span class="mw-page-title-main">Bramble (video game)</span></h1></header>
<div class="vector-body"><div id="mw-content-text" class="mw-body-content"><div class="mw-content-ltr mw-parser-output" lang="en" dir="ltr">
<p><b>Bramble</b> is an unreleased 1996 platformer.<sup class="mw-ref"><a href="#cite_note-1">[1]</a></sup></p>
<div class="mw-heading mw-heading2"><h2 id="Development">Development</h2></div>
<p>Development began in 1995.</p>
<div class="mw-heading mw-heading2"><h2 id="Notes">Notes</h2></div>
<ol class="references"><li id="cite_note-1">Unpublished.</li></ol>
</div></div></div></div>
<nav id="mw-navigation">Main menu</nav>
</body></html>`;

test('parseCatalog: the searchable id is the last segment of the reading link, not <name>', () => {
  const books = parseCatalog(CATALOG);
  assert.equal(books.length, 3, 'an entry without a text/html link is not a book');
  assert.equal(books[0].id, 'foxglove_en_all_nopic_2026-01');
  assert.equal(books[0].title, 'Foxglove Encyclopaedia (text & tables)');
  assert.equal(books[0].articleCount, 6412300);
});

test('parseCatalog: three date outcomes - exact, approximate from <updated>, unknown', () => {
  const [exact, approx, unknown] = parseCatalog(CATALOG);
  assert.deepEqual([exact.snapshot, exact.snapshotExact], ['2026-01-04', true]);
  assert.deepEqual([approx.snapshot, approx.snapshotExact], ['2025-11-20', false]);
  assert.deepEqual([unknown.snapshot, unknown.snapshotExact], [null, false]);
});

test('htmlToText: Minerva article - furniture dropped, infobox kept as rows, entities decoded', () => {
  const text = htmlToText(MINERVA);
  assert.match(text, /^Foxglove\nDeveloper\(s\) \| Thistlewood Software/, 'the infobox caption then its rows');
  assert.match(text, /Platform\(s\) \| MS-DOS; Amiga/, 'a list inside a cell stays on the row');
  assert.match(text, /Release \| 12 March 1994; Amiga: 1995/, 'a <br> inside a cell stays on the row');
  assert.match(text, /Mode\(s\) \| Single-player, multiplayer/);
  assert.match(text, /sold 200,000 copies and was the studio.s first & last release\./, 'nbsp, apostrophe and ampersand decoded');
  assert.doesNotMatch(text, /\[1\]|\[2\]|citation needed/, 'citation superscripts dropped');
  assert.doesNotMatch(text, /1994 video game|For the plant|sortkey/, 'shortdescription, hatnote and display:none dropped');
  assert.doesNotMatch(text, /Thistlewood Software games|Last edited|CC BY-SA|Languages/, 'navbox, footer and chrome dropped');
  assert.doesNotMatch(text, /window\.RLQ|border:1px/, 'script and style bodies gone');
  assert.doesNotMatch(text, /^# Foxglove/m, 'the h1 sits outside .mw-parser-output and is not body text');
  assert.match(text, /\n## Gameplay\nThe player explores twelve levels\.\n\n### Weapons\nSix weapons are available\./);
  assert.match(text, /## Reception\nPublication \| Score\nMarlow Gazette \| 9\/10\n\nCritics praised/, 'rows on consecutive lines, then a paragraph break');
});

test('articleToText: title from h1, lead before the first heading, link-list sections dropped', () => {
  const a = articleToText(MINERVA);
  assert.equal(a.title, 'Foxglove (video game)');
  assert.match(a.lead, /^Foxglove\nDeveloper/);
  assert.match(a.lead, /first & last release\.$/);
  assert.doesNotMatch(a.lead, /Gameplay/);
  assert.equal(a.sections, 2, 'Gameplay and Reception; See also, References and External links dropped');
  assert.doesNotMatch(a.full, /See also|References|External links|Marlow Gazette, 1994|Official site/);
  assert.match(a.full, /## Gameplay[\s\S]*## Reception/);
});

test('articleToText: Vector 2022 article - mw-heading wrappers and bare mw-ref sups', () => {
  const a = articleToText(VECTOR);
  assert.equal(a.title, 'Bramble (video game)');
  assert.equal(a.lead, 'Bramble is an unreleased 1996 platformer.');
  assert.equal(a.full, 'Bramble is an unreleased 1996 platformer.\n\n## Development\nDevelopment began in 1995.');
  assert.equal(a.sections, 1);
});

test('articleToText: an h1 inside the body container is the title, not a section', () => {
  // As the 2024 nopic snapshot really has it: the heading-holder sits inside
  // #bodyContent.mw-parser-output, before the lead paragraph.
  const inside = MINERVA
    .replace('<div class="pre-content heading-holder"><h1 id="section_0" class="firstHeading">Foxglove (video game)</h1></div>\n', '')
    .replace('<section class="mf-section-0" id="mf-section-0">',
      '<div class="pre-content heading-holder"><h1 id="section_0" class="firstHeading">Foxglove (video game)</h1></div><section class="mf-section-0" id="mf-section-0">');
  const a = articleToText(inside);
  assert.equal(a.title, 'Foxglove (video game)');
  assert.match(a.lead, /^Foxglove\nDeveloper/, 'the lead starts with the infobox, not with a heading');
  assert.doesNotMatch(a.full, /## Foxglove \(video game\)/);
  assert.equal(a.sections, 2);
});

test('articleToText: no .mw-parser-output at all still yields the body text', () => {
  const a = articleToText('<html><head><title>Plain</title></head><body><p>Just a <i>page</i>.</p><h2>More</h2><p>Text.</p></body></html>');
  assert.equal(a.title, 'Plain');
  assert.equal(a.lead, 'Just a page.');
  assert.equal(a.full, 'Just a page.\n\n## More\nText.');
});

test('splitSections: deeper headings stay inside their section', () => {
  const { lead, sections } = splitSections('Lead.\n\n## A\na\n\n### A1\na1\n\n## B\nb');
  assert.equal(lead, 'Lead.');
  assert.deepEqual(sections.map((s) => s.heading), ['A', 'B']);
  assert.equal(sections[0].body, 'a\n\n### A1\na1');
});

test('composeDocument: the first line names the shelf, the article, the snapshot and the scope', () => {
  const a = articleToText(MINERVA);
  const [book] = parseCatalog(CATALOG);
  const lead = composeDocument(a, book, 'lead');
  assert.match(lead, /^\[Foxglove Encyclopaedia \(text & tables\) article "Foxglove \(video game\)", from an offline snapshot dated 2026-01-04\. Summary section only\. Nothing that happened after the snapshot is in this material\.\]\n\n/);
  assert.match(lead, /first & last release\.$/);
  const full = composeDocument(a, book, 'full');
  assert.match(full, /Full article, with reference lists and navigation omitted\./);
  assert.match(full, /## Reception/);
  const approx = composeDocument(a, parseCatalog(CATALOG)[1], 'lead');
  assert.match(approx, /from around 2025-11-20/, 'a date read from <updated> is not presented as exact');
  const unknown = composeDocument(a, parseCatalog(CATALOG)[2], 'lead');
  assert.match(unknown, /snapshot of unknown date/);
});

test('documentName: article then shelf, with the shelf trimmed at its parenthesis', () => {
  const a = articleToText(MINERVA);
  assert.equal(documentName(a, parseCatalog(CATALOG)[0]), 'Foxglove (video game) - Foxglove Encyclopaedia');
});

/* ---------- against a fake kiwix-serve ---------- */

const seen: string[] = [];
function handle(req: http.IncomingMessage, res: http.ServerResponse, log: string[]) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  // URL.pathname keeps its percent-escapes; kiwix compares decoded paths.
  const pathname = decodeURIComponent(url.pathname);
  log.push(req.url ?? '');
  if (pathname === '/catalog/v2/entries') {
    res.writeHead(200, { 'content-type': 'application/atom+xml' });
    res.end(CATALOG);
  } else if (pathname === '/suggest') {
    if (url.searchParams.get('content') !== 'foxglove_en_all_nopic_2026-01') {
      res.writeHead(400, { 'content-type': 'text/html' });
      res.end('<html>No such book</html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([
      { value: 'Foxglove (video game)', label: '<b>Foxglove</b> (video game)', kind: 'path', path: 'Foxglove_(video_game)' },
      { value: 'Foxglove', label: '<b>Foxglove</b>', kind: 'path', path: 'Foxglove' },
      { value: 'foxglove ', label: 'containing \'foxglove\'...', kind: 'pattern' },
    ]));
  } else if (pathname === '/raw/foxglove_en_all_nopic_2026-01/content/Foxglove_(video_game)') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(MINERVA);
  } else if (pathname === '/content/foxglove_en_all_nopic_2026-01/Old/Bramble (video game)') {
    // An older server without /raw/: the first try 404s, this one answers.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(VECTOR);
  } else if (pathname === '/raw/foxglove_en_all_nopic_2026-01/content/A/Foxglove_(FPS)') {
    // A redirect entry, answered the way a real kiwix does: 302 from /raw/ to
    // the target's /content/ path, root-relative.
    res.writeHead(302, { location: '/content/foxglove_en_all_nopic_2026-01/A/Foxglove_(video_game)' });
    res.end();
  } else if (pathname === '/content/foxglove_en_all_nopic_2026-01/A/Foxglove_(video_game)') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(MINERVA);
  } else if (pathname === '/raw/foxglove_en_all_nopic_2026-01/content/A/Elsewhere') {
    res.writeHead(302, { location: 'https://example.com/not-the-wiki' });
    res.end();
  } else if (pathname === '/raw/foxglove_en_all_nopic_2026-01/content/A/Loop') {
    res.writeHead(302, { location: '/raw/foxglove_en_all_nopic_2026-01/content/A/Loop' });
    res.end();
  } else {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<html>Not found</html>');
  }
}
const fake = http.createServer((req, res) => handle(req, res, seen));

const ready = new Promise<string>((resolve) => {
  fake.listen(0, '127.0.0.1', () => {
    const addr = fake.address() as { port: number };
    resolve(`http://127.0.0.1:${addr.port}/`); // trailing slash on purpose: it must not double up
  });
});
after(() => fake.close());

test('listBooks: reads the catalog over HTTP and caches it', async () => {
  const base = await ready;
  const before = seen.length;
  const books = await listBooks({ url: base }, true);
  assert.equal(books[0].id, 'foxglove_en_all_nopic_2026-01');
  await listBooks({ url: base });
  assert.equal(seen.length, before + 1, 'the second call came from the cache');
  assert.equal(seen[before], '/catalog/v2/entries', 'no doubled slash from the trailing one on the base');
});

test('suggestTitles: asks /suggest with content= and drops the full-text pattern entry', async () => {
  const base = await ready;
  const hits = await suggestTitles({ url: base }, 'foxglove_en_all_nopic_2026-01', 'foxg');
  assert.deepEqual(hits, [
    { title: 'Foxglove (video game)', path: 'Foxglove_(video_game)' },
    { title: 'Foxglove', path: 'Foxglove' },
  ]);
  const last = seen[seen.length - 1];
  assert.match(last, /^\/suggest\?content=foxglove_en_all_nopic_2026-01&term=foxg&count=20$/);
});

test('fetchArticleHtml: a redirect entry is followed to the article it points at', async () => {
  const base = await ready;
  const html = await fetchArticleHtml({ url: base }, 'foxglove_en_all_nopic_2026-01', 'A/Foxglove_(FPS)');
  assert.match(html, /Thistlewood Software/);
  assert.deepEqual(seen.slice(-2), [
    '/raw/foxglove_en_all_nopic_2026-01/content/A/Foxglove_(FPS)',
    '/content/foxglove_en_all_nopic_2026-01/A/Foxglove_(video_game)',
  ]);
});

test('fetchArticleHtml: a redirect off the wiki is refused, and a loop gives up', async () => {
  const base = await ready;
  await assert.rejects(fetchArticleHtml({ url: base }, 'foxglove_en_all_nopic_2026-01', 'A/Elsewhere'), /redirected off itself, to https:\/\/example\.com/);
  await assert.rejects(fetchArticleHtml({ url: base }, 'foxglove_en_all_nopic_2026-01', 'A/Loop'), /redirected 5 times/);
});

test('suggestTitles: a wrong book id is an error with the status in it, not an empty list', async () => {
  const base = await ready;
  await assert.rejects(suggestTitles({ url: base }, 'foxglove_en_all_nopic', 'fox'), /HTTP 400/);
});

test('fetchArticleHtml: /raw/ first, with the path encoded per segment', async () => {
  const base = await ready;
  const html = await fetchArticleHtml({ url: base }, 'foxglove_en_all_nopic_2026-01', 'Foxglove_(video_game)');
  assert.match(html, /Thistlewood Software/);
  assert.equal(seen[seen.length - 1], '/raw/foxglove_en_all_nopic_2026-01/content/Foxglove_(video_game)');
});

test('fetchArticleHtml: falls back to /content/ when /raw/ is missing, keeping slashes in the path', async () => {
  const base = await ready;
  const html = await fetchArticleHtml({ url: base }, 'foxglove_en_all_nopic_2026-01', 'Old/Bramble (video game)');
  assert.match(html, /unreleased 1996 platformer/);
  const tail = seen.slice(-2);
  assert.equal(tail[0], '/raw/foxglove_en_all_nopic_2026-01/content/Old/Bramble%20(video%20game)');
  assert.equal(tail[1], '/content/foxglove_en_all_nopic_2026-01/Old/Bramble%20(video%20game)');
});

test('fetchArticleHtml: an article missing from both is a clear error', async () => {
  const base = await ready;
  await assert.rejects(fetchArticleHtml({ url: base }, 'foxglove_en_all_nopic_2026-01', 'Nope'), /no article at "Nope"/);
});

/* ---------- over TLS, with a certificate nothing trusts ---------- */

/*
 * A real handshake against a real self-signed certificate, made fresh by
 * openssl at test time so no key ever lives in the repo. Without openssl the
 * TLS tests are skipped, and say so, rather than passing vacuously.
 */
function opensslPath(): string | null {
  for (const candidate of ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', '/usr/bin/openssl']) {
    try {
      execFileSync(candidate, ['version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // try the next one
    }
  }
  return null;
}
const OPENSSL = opensslPath();
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsconclave-wiki-tls-'));
let pem: { cert: Buffer; key: Buffer } | null = null;
if (OPENSSL) {
  execFileSync(OPENSSL, [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', path.join(certDir, 'k.pem'), '-out', path.join(certDir, 'c.pem'), '-days', '2',
    '-subj', '/CN=wiki.example', '-addext', 'subjectAltName=DNS:wiki.example,IP:127.0.0.1',
  ], { stdio: 'ignore' });
  pem = { cert: fs.readFileSync(path.join(certDir, 'c.pem')), key: fs.readFileSync(path.join(certDir, 'k.pem')) };
}
const seenTls: string[] = [];
const fakeTls = pem ? https.createServer(pem, (req, res) => handle(req, res, seenTls)) : null;
const readyTls = new Promise<string>((resolve) => {
  if (!fakeTls) return resolve('');
  fakeTls.listen(0, '127.0.0.1', () => resolve(`https://127.0.0.1:${(fakeTls.address() as { port: number }).port}`));
});
after(() => {
  fakeTls?.close();
  fs.rmSync(certDir, { recursive: true, force: true });
});
const fingerprint = () => new X509Certificate(pem!.cert).fingerprint256;
const tlsTest = OPENSSL ? test : test.skip;
if (!OPENSSL) console.log('# wiki TLS tests skipped: openssl not found');

tlsTest('https, untrusted: the failure names the certificate, not the box, and nothing was sent', async () => {
  const url = await readyTls;
  await assert.rejects(listBooks({ url }, true),
    (e: any) => e instanceof WikiCertError && e.kind === 'untrusted' && /does not trust/.test(e.message));
  assert.equal(seenTls.length, 0);
});

tlsTest('probeCertificate: fingerprint, subject, names and self-signed, as the file says', async () => {
  const url = await readyTls;
  const c = await probeCertificate(url);
  assert.equal(c.fingerprint256, fingerprint());
  assert.equal(c.subject, 'wiki.example');
  assert.match(c.altNames, /IP Address:127\.0\.0\.1/);
  assert.equal(c.selfSigned, true);
  assert.equal(seenTls.length, 0, 'a probe makes no request');
});

tlsTest('pinned: the trusted fingerprint lets the catalog, suggest and article calls through', async () => {
  const url = await readyTls;
  const pin = fingerprint();
  const books = await listBooks({ url, pin }, true);
  assert.equal(books[0].id, 'foxglove_en_all_nopic_2026-01');
  const hits = await suggestTitles({ url, pin }, 'foxglove_en_all_nopic_2026-01', 'foxg');
  assert.equal(hits[0].title, 'Foxglove (video game)');
  const html = await fetchArticleHtml({ url, pin }, 'foxglove_en_all_nopic_2026-01', 'Foxglove_(video_game)');
  assert.match(html, /Thistlewood Software/);
  assert.deepEqual(seenTls.slice(-3), [
    '/catalog/v2/entries',
    '/suggest?content=foxglove_en_all_nopic_2026-01&term=foxg&count=20',
    '/raw/foxglove_en_all_nopic_2026-01/content/Foxglove_(video_game)',
  ]);
});

tlsTest('pinned: a redirect entry is followed over a fresh pinned connection', async () => {
  const url = await readyTls;
  const before = seenTls.length;
  const html = await fetchArticleHtml({ url, pin: fingerprint() }, 'foxglove_en_all_nopic_2026-01', 'A/Foxglove_(FPS)');
  assert.match(html, /Thistlewood Software/);
  assert.equal(seenTls.length, before + 2);
});

tlsTest('pinned: a different certificate is refused before any request is sent', async () => {
  const url = await readyTls;
  const before = seenTls.length;
  const pin = 'AA:' + fingerprint().slice(3);
  await assert.rejects(listBooks({ url, pin }, true),
    (e: any) => e instanceof WikiCertError && e.kind === 'changed' && /different certificate/.test(e.message));
  assert.equal(seenTls.length, before);
});

tlsTest('pinned: a 404 on /raw/ still falls back to /content/ over the pinned connection', async () => {
  const url = await readyTls;
  const html = await fetchArticleHtml({ url, pin: fingerprint() }, 'foxglove_en_all_nopic_2026-01', 'Old/Bramble (video game)');
  assert.match(html, /unreleased 1996 platformer/);
});

test('a pin on a plain http address changes nothing', async () => {
  const base = await ready;
  const books = await listBooks({ url: base, pin: 'AA:BB' }, true);
  assert.equal(books.length, 3);
});
