// Fake kiwix-serve for trying the local-wiki lookup without a ZIM.
// Run: node dev/mock-kiwix.ts   (listens on 127.0.0.1:8090)
// Then Settings > Local wiki > http://127.0.0.1:8090 > Save and test.
//
// Answers the three calls the app makes - the OPDS catalog, /suggest and
// /raw/<book>/content/<path> - in the shapes a real server uses, over a
// fictional estate (RFC 2606 names, invented titles). Nothing here is text
// from a real encyclopedia.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const PORT = Number(process.env.MOCK_PORT ?? 8090);
// MOCK_CERT and MOCK_KEY (PEM paths) make it serve https instead, to try the
// certificate-trust flow. A self-signed pair from `openssl req -x509` will do.
const CERT = process.env.MOCK_CERT;
const KEY = process.env.MOCK_KEY;
const BOOK = 'foxglove_en_all_nopic_2026-01';

const CATALOG = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/">
  <entry>
    <id>urn:uuid:11111111-1111-4111-8111-111111111111</id>
    <title>Foxglove Encyclopaedia (text &amp; tables)</title>
    <updated>2026-02-11T00:00:00Z</updated>
    <name>foxglove_en_all_nopic</name>
    <articleCount>6412300</articleCount>
    <dc:issued>2026-01-04T00:00:00Z</dc:issued>
    <link type="text/html" href="/content/${BOOK}"/>
  </entry>
</feed>`;

function minerva(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>.infobox{border:1px solid #a2a9b1}</style></head>
<body class="mediawiki skin-minerva"><div id="mw-mf-viewport"><div id="mw-mf-page-center">
<div class="pre-content heading-holder"><h1 id="section_0">${title}</h1></div>
<div id="content" class="mw-body"><div id="bodyContent" class="content mw-parser-output">${body}</div></div>
<div class="last-modified-bar">Last edited 3 years ago</div></div></div>
<footer id="footer"><p>Content is available under CC BY-SA.</p></footer></body></html>`;
}

const ARTICLES: Record<string, { title: string; html: string }> = {
  'Foxglove_(video_game)': {
    title: 'Foxglove (video game)',
    html: minerva('Foxglove (video game)', `
<section class="mf-section-0">
<div class="hatnote">For the plant, see <a href="Foxglove">Foxglove</a>.</div>
<table class="infobox ib-video-game"><caption class="infobox-title">Foxglove</caption><tbody>
<tr><th scope="row">Developer(s)</th><td>Thistlewood Software</td></tr>
<tr><th scope="row">Publisher(s)</th><td>Marlow Interactive</td></tr>
<tr><th scope="row">Platform(s)</th><td><div class="plainlist"><ul><li>MS-DOS</li><li>Amiga</li></ul></div></td></tr>
<tr><th scope="row">Release</th><td>12 March 1994<br>Amiga: 1995</td></tr>
<tr><th scope="row">Genre(s)</th><td>First-person shooter</td></tr>
</tbody></table>
<p><b>Foxglove</b> is a 1994 first-person shooter developed by Thistlewood Software and published by
Marlow Interactive.<sup class="reference"><a href="#cite_note-1">[1]</a></sup> It was the studio's first release
and sold about 200,000&nbsp;copies in its first year.</p>
</section>
<section class="mf-section-1"><h2 class="section-heading"><span class="mw-headline">Gameplay</span></h2>
<p>The player explores twelve levels across three episodes, collecting keys to open doors and finding secret areas
behind false walls. Six weapons are available, from a spanner to a rocket launcher.</p></section>
<section class="mf-section-2"><h2 class="section-heading"><span class="mw-headline">Development</span></h2>
<p>Development began in 1992 on a custom engine. The team of four worked from a rented office in Thistlewood.</p>
<h3><span class="mw-headline">Engine</span></h3>
<p>The engine drew sectors rather than rooms, which allowed sloped floors two years before its rivals.</p></section>
<section class="mf-section-3"><h2 class="section-heading"><span class="mw-headline">Reception</span></h2>
<table class="wikitable"><tr><th>Publication</th><th>Score</th></tr><tr><td>Marlow Gazette</td><td>9/10</td></tr>
<tr><td>Bramble Monthly</td><td>82%</td></tr></table>
<p>Critics praised the level design and the speed of the engine.</p></section>
<section class="mf-section-4"><h2 class="section-heading"><span class="mw-headline">See also</span></h2>
<ul><li><a href="Foxglove_II">Foxglove II</a></li></ul></section>
<section class="mf-section-5"><h2 class="section-heading"><span class="mw-headline">References</span></h2>
<div class="reflist"><ol class="references"><li id="cite_note-1">Marlow Gazette, March 1994.</li></ol></div></section>
<div class="navbox"><table><tr><td>Thistlewood Software games</td></tr></table></div>`),
  },
  'Foxglove_II': {
    title: 'Foxglove II',
    html: minerva('Foxglove II', `
<section class="mf-section-0"><p><b>Foxglove II</b> is the 1996 sequel to <a href="Foxglove_(video_game)">Foxglove</a>,
adding network play for up to eight players.</p></section>
<section class="mf-section-1"><h2 class="section-heading"><span class="mw-headline">Legacy</span></h2>
<p>Its network code was licensed to three other studios.</p></section>`),
  },
  'Thistlewood_Software': {
    title: 'Thistlewood Software',
    html: minerva('Thistlewood Software', `
<section class="mf-section-0"><p><b>Thistlewood Software</b> was a video game developer active from 1992 to 2001,
best known for <a href="Foxglove_(video_game)">Foxglove</a>.</p></section>
<section class="mf-section-1"><h2 class="section-heading"><span class="mw-headline">Games</span></h2>
<ul><li>Foxglove (1994)</li><li>Foxglove II (1996)</li><li>Bramble (cancelled)</li></ul></section>`),
  },
  'Foxglove': {
    title: 'Foxglove',
    html: minerva('Foxglove', `
<section class="mf-section-0"><div class="hatnote">For the video game, see <a href="Foxglove_(video_game)">Foxglove (video game)</a>.</div>
<p><b>Foxglove</b> is a flowering plant. This article is about the plant.</p></section>`),
  },
};

const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  console.log(`${req.method} ${req.url}`);

  if (pathname === '/catalog/v2/entries') {
    res.writeHead(200, { 'content-type': 'application/atom+xml' });
    res.end(CATALOG);
    return;
  }
  if (pathname === '/suggest') {
    if (url.searchParams.get('content') !== BOOK) {
      res.writeHead(400, { 'content-type': 'text/html' });
      res.end('<html><body>No such book</body></html>');
      return;
    }
    const term = (url.searchParams.get('term') ?? '').toLowerCase();
    const count = Number(url.searchParams.get('count') ?? 10);
    const hits = Object.entries(ARTICLES)
      .filter(([, a]) => a.title.toLowerCase().includes(term))
      .slice(0, count)
      .map(([path, a]) => ({ value: a.title, label: a.title.replace(new RegExp(term, 'i'), (m) => `<b>${m}</b>`), kind: 'path', path }));
    hits.push({ value: `${term} `, label: `containing '${term}'...`, kind: 'pattern', path: '' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(hits));
    return;
  }
  const raw = new RegExp(`^/raw/${BOOK}/content/(.+)$`).exec(pathname);
  const article = raw ? ARTICLES[raw[1]] : undefined;
  if (article) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(article.html);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/html' });
  res.end('<html><body>Not found</body></html>');
};

const server = CERT && KEY
  ? https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, handler)
  : http.createServer(handler);
server.listen(PORT, '127.0.0.1', () => {
  const scheme = CERT && KEY ? 'https' : 'http';
  console.log(`mock kiwix-serve on ${scheme}://127.0.0.1:${PORT} - one book, ${Object.keys(ARTICLES).length} articles`);
});
