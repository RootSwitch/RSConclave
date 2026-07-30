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
  { mode: 'chat',       theme: 'amber',     file: 'chat.png' },
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

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

// Log in from page context and let the server set the cookie exactly as it would
// for a real browser. Simpler than forging one with Network.setCookie, and it
// exercises the actual login path.
await send('Page.navigate', { url: APP });
await sleep(1500);
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
  await sleep(2200);

  const found = await evaluate(clickSession(shot.mode));
  if (found !== 'ok') throw new Error(`${shot.mode}: ${found}`);
  await sleep(1200);

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
