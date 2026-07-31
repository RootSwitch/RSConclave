// Integration probe for run control: cancel, stop, and the session-status
// bookkeeping around them. These behaviours all live in engine.ts across an
// await and a fire-and-forget launch, which is exactly the shape unit tests do
// not reach - so this drives the real server over HTTP instead.
//
// It exists because all four checks below once failed:
//   1. Cancel stopped only the current council member; the rest ran anyway and
//      then consolidated. Roundtable and pipeline stopped; council did not.
//   2. Stop mid-generation lost the partial text AND the 'cancelled' marker,
//      because stopRun() cleared the active slot before the aborted turn wrote.
//   3. Consequence of 2: the live browser had text the disk did not.
//   4. Sessions kept status 'active' forever, so several claimed it at once.
//
// Usage (needs the slow mock, which gives you time to interrupt a stream):
//   node dev/mock-ollama.ts &
//   RSCONCLAVE_DATA=/tmp/probe PORT=7802 node server/main.ts &
//   PROBE_DATA=/tmp/probe node dev/probe-runcontrol.mjs
//
// Exits non-zero if any check regresses. Takes about 40 seconds - most of it is
// deliberately waiting to prove the council does NOT keep going.

import fs from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:7802';
// Checks 2 and 3 compare what the API reports against what actually reached
// disk, so the probe needs the data directory the server was started with.
const DATA = process.env.PROBE_DATA;
if (!DATA) {
  console.error('set PROBE_DATA to the same path as the server RSCONCLAVE_DATA');
  process.exit(2);
}
let cookie = '';
let failures = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const t = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${t}`);
  return t ? JSON.parse(t) : null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const onDisk = (user, id) =>
  JSON.parse(fs.readFileSync(`${DATA}/users/${user}/sessions/${id}.json`, 'utf8'));

// Re-runnable: claim the instance if it is fresh, otherwise just sign in.
try {
  await api('POST', '/api/setup', { username: 'prober', password: 'password-1' });
} catch {
  await api('POST', '/api/login', { username: 'prober', password: 'password-1' });
}
const EP = 'mock';
await api('PUT', '/api/config', {
  endpoints: [{ id: EP, name: 'Mock', baseUrl: 'http://127.0.0.1:11435', kind: 'ollama' }],
});

// ---------- EXPERIMENT 1: cancel mid-council ----------
console.log('\n=== 1. Cancel during a 3-member council ===');
const co = await api('POST', '/api/council/start', {
  prompt: 'probe',
  members: [
    { endpointId: EP, model: 'mock-jester:7b' },
    { endpointId: EP, model: 'mock-jester:7b' },
    { endpointId: EP, model: 'mock-jester:7b' },
  ],
  consolidator: { endpointId: EP, model: 'mock-jester:7b', template: '{{RESPONSES}}' },
});
await sleep(2500);                       // member 1 is streaming
console.log('  state before cancel:', (await api('GET', '/api/state')).phase);
await api('POST', '/api/cancel', {});
console.log('  -> cancel sent');
await sleep(1000);
console.log('  state right after :', (await api('GET', '/api/state')).phase);
await sleep(25000);                      // long enough for all members + consolidation
const s1 = await api('GET', `/api/sessions/${co.sessionId}`);
const kinds = s1.entries.map((e) => `${e.kind}${e.error ? '/' + e.error : ''}`);
console.log('  entries after cancel:', kinds.join(', '));
console.log('  members that produced text:',
  s1.entries.filter((e) => e.kind === 'participant' && e.text && !e.error).length, 'of 3');
console.log('  consolidation present :', s1.entries.some((e) => e.kind === 'consolidation'));
check('cancel stops the whole council', !s1.entries.some((e) => e.kind === 'consolidation'));

// ---------- EXPERIMENT 2: stop mid-generation in a roundtable ----------
console.log('\n=== 2. Stop during a roundtable turn ===');
const rt = await api('POST', '/api/roundtable/start', {
  participants: [
    { id: 'a', name: 'Alpha', kind: 'model', endpointId: EP, model: 'mock-jester:7b' },
    { id: 'b', name: 'Beta', kind: 'model', endpointId: EP, model: 'mock-jester:7b' },
  ],
  scenario: 'probe',
  turnOrder: 'round-robin',
});
await api('POST', '/api/roundtable/step', {});
await sleep(3000);                       // mid-stream, some text has arrived
await api('POST', '/api/roundtable/stop', {});
console.log('  -> stop sent mid-generation');
await sleep(3000);                       // let the aborted turn unwind

const disk = onDisk('prober', rt.sessionId);
const last = disk.entries.at(-1);
console.log('  entries on disk      :', disk.entries.length);
console.log('  last entry kind      :', last?.kind);
console.log('  last entry error     :', JSON.stringify(last?.error ?? null));
console.log('  last entry text len  :', (last?.text ?? '').length);
console.log('  session status       :', disk.status);
check('partial text survives Stop', (last?.text ?? '').length > 0);
check("Stop records error 'cancelled' on disk", last?.error === 'cancelled');

// ---------- EXPERIMENT 3: what the browser was told vs what is on disk ----------
console.log('\n=== 3. Does the API agree with the disk? ===');
const viaApi = await api('GET', `/api/sessions/${rt.sessionId}`);
const apiLast = viaApi.entries.at(-1);
console.log('  API last text len    :', (apiLast?.text ?? '').length);
console.log('  disk last text len   :', (last?.text ?? '').length);
check('API and disk agree', (apiLast?.text ?? '').length === (last?.text ?? '').length);

// ---------- EXPERIMENT 4: session status of a displaced session ----------
console.log('\n=== 4. Start a new session while another is idle-active ===');
const ch = await api('POST', '/api/chat/start', { endpointId: EP, model: 'mock-jester:7b' });
const all = await api('GET', '/api/sessions');
console.log('  sessions marked active:',
  all.filter((s) => s.status === 'active').map((s) => `${s.mode}`).join(', ') || '(none)');
check('exactly one session claims active', all.filter((s) => s.status === 'active').length === 1);

// ---------- EXPERIMENT 5: stop mid-run, immediately start another session ----------
// This is exactly the sequence the UI's stop-and-start confirm produces. The
// dying run's tail code must not touch the session that took its place.
console.log('\n=== 5. Stop a council mid-generation, instantly start a chat ===');
const co2 = await api('POST', '/api/council/start', {
  prompt: 'probe two',
  members: [
    { endpointId: EP, model: 'mock-jester:7b' },
    { endpointId: EP, model: 'mock-jester:7b' },
  ],
  consolidator: { endpointId: EP, model: 'mock-jester:7b', template: '{{RESPONSES}}' },
});
await sleep(2500);                       // member 1 is mid-stream
await api('POST', '/api/run/stop', {});
const ch2 = await api('POST', '/api/chat/start', { endpointId: EP, model: 'mock-jester:7b' });
console.log('  -> stopped council', co2.sessionId, 'and started chat', ch2.sessionId, 'in the same instant');
await sleep(5000);                       // the aborted council turn unwinds NOW
const st5 = await api('GET', '/api/state');
const all5 = await api('GET', '/api/sessions');
const chat5 = all5.find((s) => s.id === ch2.sessionId);
const council5 = all5.find((s) => s.id === co2.sessionId);
console.log('  chat phase after unwind   :', st5.phase);
console.log('  chat status after unwind  :', chat5?.status);
console.log('  council status            :', council5?.status);
check('the dying council did not finish the new chat', st5.phase !== 'done' && chat5?.status !== 'done');
check('the stopped council stays stopped', council5?.status === 'stopped');

// ---------- EXPERIMENT 6: a cancelled pipeline is not a finished one ----------
// runPipeline broke out of its stage loop on any entry error without recording
// that the break was a CANCEL, so finishRun stamped 'done' and the sidebar
// showed a run the user stopped as if it had completed. Councils had this fixed
// already; pipelines were missed.
console.log('\n=== 6. Cancel during a pipeline ===');
const pl = await api('POST', '/api/pipeline/start', {
  input: 'probe',
  stages: [
    { name: 'one', endpointId: EP, model: 'mock-jester:7b', template: '{{INPUT}}' },
    { name: 'two', endpointId: EP, model: 'mock-jester:7b', template: '{{INPUT}}' },
  ],
});
await sleep(2500);                       // stage one is streaming
await api('POST', '/api/cancel', {});
console.log('  -> cancel sent mid-stage');
await sleep(4000);                       // let the aborted stage unwind
const all6 = await api('GET', '/api/sessions');
const pipe6 = all6.find((s) => s.id === pl.sessionId);
const disk6 = onDisk('prober', pl.sessionId);
console.log('  pipeline status (api) :', pipe6?.status);
console.log('  pipeline status (disk):', disk6.status);
console.log('  stages produced       :', disk6.entries.filter((e) => e.kind === 'participant').length, 'of 2');
check('a cancelled pipeline is stopped, not done', pipe6?.status === 'stopped');
check('the cancel stopped the remaining stages',
  disk6.entries.filter((e) => e.kind === 'participant' && e.text && !e.error).length < 2);

// ---------- EXPERIMENT 7: a re-run does not rewrite how the session ended ----------
// Re-running one member edits a council that already reached a terminal status.
// finishRun used to stamp 'done' regardless, so re-running a member of a council
// the user had STOPPED silently promoted it to completed.
console.log('\n=== 7. Re-run a member of a stopped council ===');
const co3 = await api('POST', '/api/council/start', {
  prompt: 'probe three',
  members: [
    { endpointId: EP, model: 'mock-jester:7b' },
    { endpointId: EP, model: 'mock-jester:7b' },
  ],
  consolidator: { endpointId: EP, model: 'mock-jester:7b', template: '{{RESPONSES}}' },
});
await sleep(2500);
await api('POST', '/api/cancel', {});
await sleep(4000);
const before7 = (await api('GET', '/api/sessions')).find((s) => s.id === co3.sessionId);
console.log('  status after cancel   :', before7?.status);
/*
 * Displace it first. The bug only appears once the council is no longer the
 * live run: re-running a member then reloads it from disk, and reloading
 * stamps 'active' over the status that said how it ended. Re-running while it
 * is still in memory happens to work for the wrong reason (the pause flag is
 * still set), which is exactly the false pass this line exists to avoid.
 */
await api('POST', '/api/chat/start', { endpointId: EP, model: 'mock-jester:7b' });
await api('POST', '/api/council/rerun-member', { sessionId: co3.sessionId, memberIndex: 0 });
await sleep(8000);                       // let the re-run finish
const after7 = (await api('GET', '/api/sessions')).find((s) => s.id === co3.sessionId);
console.log('  status after re-run   :', after7?.status);
check('the council was stopped to begin with', before7?.status === 'stopped');
check('a re-run does not promote it to done', after7?.status === 'stopped');

console.log('');
console.log(failures ? `${failures} check(s) FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
