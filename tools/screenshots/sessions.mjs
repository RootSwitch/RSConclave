// Builds the four demo sessions through the real HTTP API, so the screenshots
// show output the engine actually produced and persisted.
//
// Run via tools/screenshots/run.sh, not directly.
const BASE = process.env.BASE ?? 'http://127.0.0.1:7788';
const USER = 'demo';
const PASS = 'demo-password-1';

let cookie = '';

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setC = res.headers.get('set-cookie');
  if (setC) cookie = setC.split(';')[0];
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * The engine serialises runs globally and rejects a new start only while the
 * phase is literally 'generating'. That makes a single non-generating read
 * useless as proof a run has finished: during an auto-stepped roundtable the
 * phase drops back to awaiting_gate between every turn, so a naive poll returns
 * mid-sequence and the next start call fails with "the box is busy".
 * Require several consecutive quiet reads with no auto-steps outstanding.
 */
async function waitIdle(label) {
  let quiet = 0;
  for (let i = 0; i < 600; i++) {
    const s = await api('GET', '/api/state');
    const busy = s.phase === 'generating' || s.phase === 'auto_stepping' || (s.autoRemaining ?? 0) > 0;
    quiet = busy ? 0 : quiet + 1;
    if (quiet >= 4) {
      if (s.lastError) console.log(`  ! ${label}: ${s.lastError}`);
      return s;
    }
    await sleep(250);
  }
  throw new Error(`${label}: never settled`);
}

/** Belt and braces: confirm the transcript holds the turns we asked for. */
async function waitEntries(sessionId, kind, n, label) {
  for (let i = 0; i < 600; i++) {
    const s = await api('GET', `/api/sessions/${sessionId}`);
    if (s.entries.filter((e) => e.kind === kind).length >= n) return s;
    await sleep(250);
  }
  throw new Error(`${label}: never reached ${n} ${kind} entries`);
}

try {
  await api('POST', '/api/setup', { username: USER, password: PASS });
} catch {
  await api('POST', '/api/login', { username: USER, password: PASS });
}

const EP = 'ep-lab';
await api('PUT', '/api/config', {
  endpoints: [{
    id: EP, name: 'Lab box', baseUrl: `http://127.0.0.1:${process.env.MOCK_PORT ?? 11435}`, kind: 'ollama',
    aliases: { 'gpt-oss:120b': 'gpt-oss 120b (MoE)', 'nemotron-cascade-2:12b': 'nemotron cascade 2' },
  }],
});

await api('PUT', '/api/personas', [
  { id: 'p-blinky', name: 'Prosecutor',    systemPrompt: 'You are the lead prosecutor. You pursue relentlessly and never change course once committed. Open each turn by restating the charge.' },
  { id: 'p-pinky',  name: 'Premeditation', systemPrompt: 'You argue that everything was planned in advance. You anticipate where the argument is heading and arrive there first.' },
  { id: 'p-inky',   name: 'Waverer',       systemPrompt: 'You cannot hold a position. Agree with whoever spoke last, then reverse yourself within the same turn.' },
  { id: 'p-clyde',  name: 'Distractible',  systemPrompt: 'You keep losing the thread and wandering toward snacks. You are secretly sympathetic to the defendant.' },
  { id: 'p-pac',    name: 'Defendant',     systemPrompt: 'You are the accused and also your own mediator. Never deny the allegations. Propose settlements that sound generous but cost you nothing.' },
  { id: 'p-duck',   name: 'Rubber Duck',   systemPrompt: 'You are a rubber duck. You may only respond with questions. Never provide the answer, no matter how obvious it is or how much the user begs.' },
]);

// ---- roundtable: PacCourt ----
console.log('roundtable: PacCourt');
const rt = await api('POST', '/api/roundtable/start', {
  participants: [
    { id: 'rt-blinky', name: 'Blinky',  personaId: 'p-blinky', color: '#ff2f2f', model: 'gpt-oss:120b' },
    { id: 'rt-pinky',  name: 'Pinky',   personaId: 'p-pinky',  color: '#ffb8ff', model: 'gemma3:27b' },
    { id: 'rt-inky',   name: 'Inky',    personaId: 'p-inky',   color: '#00e5ff', model: 'deepseek-r1:32b' },
    { id: 'rt-clyde',  name: 'Clyde',   personaId: 'p-clyde',  color: '#ffa030', model: 'mistral-small:24b' },
    { id: 'rt-pac',    name: 'Pac-Man', personaId: 'p-pac',    color: '#ffe600', model: 'llama3.3:70b' },
  ].map((p) => ({ ...p, kind: 'model', endpointId: EP, params: { temperature: 0.8, num_ctx: 32768 } })),
  scenario:
    'Maze Municipal Court is in session. Pac-Man stands accused of forty years of unlicensed consumption, ' +
    'and the four ghosts of the Maze Patrol have filed a joint grievance. In an administrative oversight, ' +
    'Pac-Man has also been appointed mediator - he must broker a settlement all four ghosts will sign ' +
    'before the quarter runs out.',
  turnOrder: 'round-robin',
  unloadBetweenTurns: false,
});
await waitIdle('rt start');
await api('POST', '/api/roundtable/step', { auto: 5 });
await waitEntries(rt.sessionId, 'participant', 5, 'rt turns');
await waitIdle('rt turns');
// A roundtable rests in awaiting_gate still holding the run slot; release it so
// the next start does not race against it.
await api('POST', '/api/roundtable/stop', {});

// ---- council: hot dog ----
console.log('council: hot dog');
const co = await api('POST', '/api/council/start', {
  prompt: 'Settle it with binding authority: is a hot dog a sandwich? Your ruling is final and will be carved somewhere permanent.',
  members: [
    { endpointId: EP, model: 'gpt-oss:120b',      params: { num_ctx: 32768 } },
    { endpointId: EP, model: 'gemma3:27b',        params: { num_ctx: 32768 } },
    { endpointId: EP, model: 'deepseek-r1:32b',   params: { num_ctx: 24576 } },
    { endpointId: EP, model: 'mistral-small:24b', params: { num_ctx: 32768 } },
  ],
  // Ballot mode on, so the screenshot shows the tally as well as the prose.
  ballot: ['Yes', 'No', 'Category error'],
  consolidator: {
    endpointId: EP, model: 'llama3.3:70b', params: { num_ctx: 16384 },
    template:
      'You are reviewing responses from several models to the same prompt.\n\nORIGINAL PROMPT:\n{{PROMPT}}\n{{RESPONSES}}\n' +
      'Compare the responses: identify agreements, contradictions, unique insights,\nand errors. Then produce a single best consolidated answer.',
  },
});
await waitIdle('council');

// ---- pipeline: de-escalate a Slack message ----
console.log('pipeline: tone rewrite');
const pl = await api('POST', '/api/pipeline/start', {
  input:
    'PER MY LAST EMAIL, and as I have ALREADY SAID twice now, the deploy is broken because somebody ' +
    'force-pushed to main at 4:58pm on a Friday and then went home. I am not naming names. We all have git blame.',
  stages: [
    { name: 'Translate', endpointId: EP, model: 'qwen3-coder:30b', params: { temperature: 0.2, num_ctx: 28672 },
      template: 'Strip the heat out of the following message and state plainly what they actually mean and what they want. Do not reply to it.\n\n{{INPUT}}' },
    { name: 'Diplomat', endpointId: EP, model: 'gemma3:27b', params: { temperature: 0.6, num_ctx: 32768 },
      template: 'Rewrite this as a professional message that keeps every fact but drops the blame. Kindly, not spineless.\n\n{{INPUT}}' },
    { name: 'Compress', endpointId: EP, model: 'mistral-small:24b', params: { temperature: 0.3, num_ctx: 32768 },
      template: 'Cut this to one line a busy person will actually read. Single sentence if you can.\n\n{{INPUT}}' },
  ],
});
await waitIdle('pipeline');

// ---- chat: rubber duck ----
console.log('chat: rubber duck');
const ch = await api('POST', '/api/chat/start', {
  endpointId: EP, model: 'qwen3-coder:30b', personaId: 'p-duck',
  params: { temperature: 0.7, num_ctx: 28672 },
});
await waitIdle('chat start');
await api('POST', '/api/chat/send', {
  text: 'My recursive tree-walk keeps blowing the stack on about 4000 nodes and I cannot see why. Just tell me what is wrong.',
});
await waitIdle('chat send');

// Auto-titles are the leading characters of the prompt, which truncate badly in
// a header and in the sidebar. The sidebar matters more than it looks: in the
// hero shot it is the only place the other three modes appear.
await api('PATCH', `/api/sessions/${rt.sessionId}`, { title: 'PacCourt: The People vs. Pac-Man', tags: ['courtroom', 'demo'] });
await api('PATCH', `/api/sessions/${co.sessionId}`, { title: 'Council: is a hot dog a sandwich?', tags: ['rulings', 'demo'] });
await api('PATCH', `/api/sessions/${pl.sessionId}`, { title: 'Pipeline: de-escalate a Slack message', tags: ['work', 'demo'] });
await api('PATCH', `/api/sessions/${ch.sessionId}`, { title: 'Chat: rubber-duck debugging', tags: ['work', 'demo'] });

// Resume the roundtable last so it is the live session when captured: that
// replaces the "session stopped" notice with the actual gate bar, and puts it
// at the top of the sidebar marked active with the others reading as history.
await api('POST', `/api/sessions/${rt.sessionId}/resume`, {});
await waitIdle('resume');

console.log('sessions built');
