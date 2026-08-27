// Skip vs Cancel in a council, pressed at the two moments that take different
// code paths through runTurn - and they really are different paths, which is
// how Skip shipped working in one and broken in the other:
//
//   loading    the fetch is still pending; abort makes it reject, and the
//              catch in runTurn labels the entry
//   streaming  tokens are flowing; streamOllama catches the abort itself and
//              returns cleanly, so the non-throw path labels the entry
//
// The original probe for this lived outside the repo and died with a session,
// and the regression it would have caught went unnoticed until a real council
// hit it. This one is part of the tree. Run it against the mock:
//
//   npm run mock                                                # terminal 1
//   PORT=7811 RSCONCLAVE_DATA=$(mktemp -d) node server/main.ts  # terminal 2
//   BASE=http://127.0.0.1:7811 node dev/probe-skip.mjs          # terminal 3
//
// or against a real box, which is worth doing when touching abort handling -
// the mock's timing is honest but its network is not:
//
//   MOCK=http://10.52.1.1:11434 MODELS=small-a,small-b,small-a node dev/probe-skip.mjs
const B = process.env.BASE ?? 'http://127.0.0.1:7811';
const EP = process.env.MOCK ?? 'http://127.0.0.1:11435';
const MODELS = (process.env.MODELS ?? 'mock-jester:7b,mock-scribe:13b,mock-jester:7b').split(',');
const JAR = [];
const api = async (m, p, b) => {
  const r = await fetch(B + p, {
    method: m,
    headers: { 'content-type': 'application/json', ...(JAR.length ? { cookie: JAR[0] } : {}) },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  const sc = r.headers.get('set-cookie');
  if (sc) JAR[0] = sc.split(';')[0];
  const t = await r.text();
  if (!r.ok) throw new Error(`${m} ${p} -> ${r.status} ${t.slice(0, 140)}`);
  return t ? JSON.parse(t) : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (l, ok, x) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}`); if (!ok) { fails++; if (x) console.log('        ' + String(x).slice(0, 200)); } };

try { await api('POST', '/api/setup', { username: 'prober', password: 'password-1' }); }
catch { await api('POST', '/api/login', { username: 'prober', password: 'password-1' }); }
await api('PUT', '/api/config', { endpoints: [{ id: 'e1', name: 'Box', baseUrl: EP, kind: 'ollama' }] });
const members = MODELS.map((m) => ({ endpointId: 'e1', model: m.trim() }));
const consolidator = { ...members[0], template: '{{RESPONSES}}' };

async function skipDuring(when) {
  // when: 'streaming' = member 1 has produced tokens; 'loading' = member 1 is
  // the current speaker but no tokens yet (model load / model-info window).
  const { sessionId } = await api('POST', '/api/council/start', { prompt: 'skip test: write a numbered list of 80 short facts about networking, one line each', members, consolidator });
  let skipped = false;
  for (let i = 0; i < 600 && !skipped; i++) {
    const st = await api('GET', '/api/state');
    const s = await api('GET', `/api/sessions/${sessionId}`);
    const after = s.entries.filter((e) => e.kind === 'participant');
    const m0done = after[0]?.stats?.durationMs !== undefined;
    const cur = s.entries.at(-1);
    if (st.phase !== 'generating' && i > 4 && !m0done) break;
    if (when === 'streaming') {
      // entry.text is only written when the turn COMPLETES (tokens go out over
      // SSE), so "has text" never matches mid-stream. Streaming member 1 =
      // its entry exists without stats and the first token has arrived.
      if (m0done && cur?.kind === 'participant' && cur.memberIndex === 1
          && cur.stats === undefined && st.waitingFirstToken !== true) {
        await sleep(1500); // well inside the stream, not the first instant
        await api('POST', '/api/council/skip', {}); skipped = true;
      }
    } else { // loading
      if (m0done && st.currentSpeaker && st.waitingFirstToken) {
        await api('POST', '/api/council/skip', {}); skipped = true;
      }
    }
    await sleep(when === 'streaming' ? 120 : 60);
  }
  // wait for the whole council to settle
  for (let i = 0; i < 900; i++) {
    const st = await api('GET', '/api/state');
    if (st.phase !== 'generating' && st.phase !== 'auto_stepping') {
      const s = await api('GET', `/api/sessions/${sessionId}`);
      if (s.status !== 'active') break;
      if (st.phase === 'done' || st.phase === 'awaiting_gate' || st.phase === 'idle') break;
    }
    await sleep(300);
  }
  await sleep(800);
  const s = await api('GET', `/api/sessions/${sessionId}`);
  return { skipped, s };
}

for (const when of ['streaming', 'loading']) {
  console.log(`\n=== skip while member 2 is ${when} ===`);
  const { skipped, s } = await skipDuring(when);
  const kinds = s.entries.map((e) => `${e.kind}${e.memberIndex !== undefined ? e.memberIndex : ''}${e.error ? '/' + e.error : ''}`).join(', ');
  console.log('  entries:', kinds, '| status:', s.status);
  check(`the probe caught the ${when} window`, skipped);
  if (!skipped) continue;
  const m1 = s.entries.filter((e) => e.memberIndex === 1).at(-1);
  const m2 = s.entries.filter((e) => e.memberIndex === 2).at(-1);
  check("the skipped member reads 'skipped'", m1?.error === 'skipped', JSON.stringify({ error: m1?.error, text: m1?.text?.slice(0, 60) }));
  check('the council carried on to member 3', !!m2 && !m2.error && (m2.text ?? '').length > 0, JSON.stringify({ error: m2?.error, len: m2?.text?.length }));
  check('consolidation still happened', s.entries.some((e) => e.kind === 'consolidation'));
  check("the session did not end 'stopped'", s.status !== 'stopped', s.status);
}
console.log('\n=== cancel mid-stream still stops the whole council ===');
{
  const { sessionId } = await api('POST', '/api/council/start', { prompt: 'cancel test: write a numbered list of 80 short facts about networking, one line each', members, consolidator });
  let cancelled = false;
  for (let i = 0; i < 600 && !cancelled; i++) {
    const st = await api('GET', '/api/state');
    const s = await api('GET', `/api/sessions/${sessionId}`);
    const cur = s.entries.at(-1);
    if (cur?.kind === 'participant' && cur.stats === undefined && st.waitingFirstToken !== true) {
      await sleep(800);
      await api('POST', '/api/cancel', {});
      cancelled = true;
    }
    await sleep(120);
  }
  for (let i = 0; i < 100; i++) {
    const st = await api('GET', '/api/state');
    if (st.phase !== 'generating') break;
    await sleep(300);
  }
  await sleep(800);
  const s = await api('GET', `/api/sessions/${sessionId}`);
  check('cancel was pressed mid-stream', cancelled);
  check("the cancelled member reads 'cancelled'", s.entries.some((e) => e.error === 'cancelled'));
  check("cancel still stops the run: status 'stopped'", s.status === 'stopped', s.status);
  check('and nothing consolidated', !s.entries.some((e) => e.kind === 'consolidation'));
}

console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
