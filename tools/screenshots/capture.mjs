// Drives an already-running headless Chrome over the DevTools protocol to log
// in, set a theme, open a session and capture it.
//
// Why CDP rather than a screenshot utility: the captures need to be full
// resolution, written straight to disk, and taken after the app has settled into
// a specific state (right session open, setup folds closed, transcript scrolled).
// That is four things a generic screenshotter cannot do.
//
// Run via tools/screenshots/run.sh, not directly.
import fs from 'node:fs';
import path from 'node:path';

const CDP = `http://127.0.0.1:${process.env.CDP_PORT ?? 9222}`;
const APP = process.env.BASE ?? 'http://127.0.0.1:7788';
const OUT = process.env.OUT ?? 'docs/img';
const USER = 'demo';
const PASS = 'demo-password-1';
const W = Number(process.env.SHOT_WIDTH ?? 1280);
const H = Number(process.env.SHOT_HEIGHT ?? 800);

// One palette per mode, drawn from four different theme groups (Night, Paper,
// Cool, Screen) so the set shows the range rather than four shades of one idea.
const SHOTS = [
  // The roundtable's payoff is its last speaker plus the gate bar underneath,
  // and both sit below the fold at this viewport.
  { mode: 'roundtable', theme: 'synthwave', file: 'roundtable.png', scroll: 'bottom' },
  { mode: 'council',    theme: 'parchment', file: 'council.png' },
  { mode: 'pipeline',   theme: 'blueprint', file: 'pipeline.png' },
  /*
   * Resumed first, because only one session can be the active run and the
   * roundtable above is holding it. Without this the chat shot showed "not the
   * active session - use Resume to continue it" where the compose box belongs,
   * so the one mode whose whole point is a message box did not show one. Safe
   * here specifically because the roundtable was already captured.
   */
  { mode: 'chat',       theme: 'amber',     file: 'chat.png', resume: true },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error(`no page target at ${CDP} - is chrome running with --remote-debugging-port?`);

function connect(url) {
  const ws = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  };
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params = {}) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  return { ws, ready, send };
}

const { ws, ready, send } = connect(page.webSocketDebuggerUrl);
await ready;

async function evaluate(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result?.value;
}

/*
 * Poll an expression until it is truthy.
 *
 * The fixed sleeps this replaces were fine three times out of four and then the
 * fourth shot failed with an empty sidebar - the list simply had not rendered
 * yet. A rig that regenerates the README images is worth nothing if refreshing
 * them is a coin toss, so the waits are now conditions rather than guesses.
 */
async function waitFor(expression, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(expression);
    if (last) return last;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

// Log in from page context and let the server set the cookie exactly as it would
// for a real browser. Simpler than forging one with Network.setCookie, and it
// exercises the actual login path.
await send('Page.navigate', { url: APP });
await waitFor(`!!document.getElementById('session-list')`, 'the app shell');
const status = await evaluate(
  `fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},` +
  `body:JSON.stringify({username:${JSON.stringify(USER)},password:${JSON.stringify(PASS)}})}).then(r=>r.status)`, true);
if (status !== 200) throw new Error(`login failed: ${status}`);

// Sessions have no URL route, so they are picked out of the sidebar by their
// mode label and clicked. List items carry an onclick property, so .click() runs it.
const clickSession = (mode) => `(() => {
  const items = [...document.querySelectorAll('#session-list li')];
  const hit = items.find(li => (li.querySelector('.sess-meta')?.textContent ?? '').startsWith(${JSON.stringify(mode)}));
  if (!hit) return 'NOT FOUND, saw: ' + items.map(li => li.querySelector('.sess-meta')?.textContent).join(' | ');
  hit.click();
  return 'ok';
})()`;

fs.mkdirSync(OUT, { recursive: true });

for (const shot of SHOTS) {
  await evaluate(`localStorage.setItem('rsconclave.theme', ${JSON.stringify(shot.theme)})`);
  await send('Page.reload');
  // The sidebar is fetched after load, so its contents are the signal that the
  // page is ready to be driven - not the elapsed time since reload.
  await waitFor(`document.querySelectorAll('#session-list li').length >= ${SHOTS.length}`,
    `${shot.mode}: the session list to populate`);

  const found = await evaluate(clickSession(shot.mode));
  if (found !== 'ok') throw new Error(`${shot.mode}: ${found}`);
  // Opening a session is another round trip; wait for its view to be on screen.
  await waitFor(`(() => {
    const v = document.getElementById('view-${shot.mode}');
    return !!v && v.offsetParent !== null && v.textContent.trim().length > 0;
  })()`, `${shot.mode}: its view to render`);
  await sleep(600); // let streaming-free renders settle (fonts, folds, badges)

  if (shot.resume) {
    const clicked = await evaluate(`(() => {
      const b = [...document.querySelectorAll('#view-${shot.mode} button')].find(x => x.textContent.trim() === 'Resume');
      if (!b) return 'no Resume button';
      b.click();
      return 'ok';
    })()`);
    if (clicked !== 'ok') throw new Error(`${shot.mode}: ${clicked}`);
    await waitFor(`!!document.querySelector('#view-${shot.mode} textarea')`,
      `${shot.mode}: the compose box after Resume`);
  }

  // Close any open setup band so the transcript is what the eye lands on.
  await evaluate(`document.querySelectorAll('details[open].setup-fold').forEach(d => d.open = false); 1`);
  await sleep(400);

  if (shot.scroll === 'bottom') {
    await evaluate(`(() => {
      const sc = document.querySelector('#view-${shot.mode} .transcript-scroll') ||
                 document.querySelector('.transcript-scroll');
      if (sc) sc.scrollTop = sc.scrollHeight;
      return 1;
    })()`);
    await sleep(500);
  }

  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(OUT, shot.file);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`  ${file}  ${shot.theme}  ${Math.round(fs.statSync(file).size / 1024)} KB`);
}

ws.close();

// Ask the browser to exit rather than leaving run.sh to kill it. Chrome spawns
// helper processes that do not reliably die with the parent, and a clean
// Browser.close takes them all with it.
try {
  const version = await (await fetch(`${CDP}/json/version`)).json();
  if (version.webSocketDebuggerUrl) {
    const b = connect(version.webSocketDebuggerUrl);
    await b.ready;
    b.send('Browser.close').catch(() => {}); // never answers: the browser is gone
    await sleep(500);
  }
} catch { /* run.sh kills the pid as a fallback */ }
