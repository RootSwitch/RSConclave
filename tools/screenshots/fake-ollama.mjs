// An Ollama-compatible server that returns scenario-appropriate text, used only
// to generate the README screenshots.
//
// This is NOT dev/mock-ollama.ts. That one is a test fixture: three models, one
// generic paragraph, deliberately minimal. This one exists because a screenshot
// has to be readable - four panels of identical lorem prose demonstrate nothing,
// and the model names in a picker are part of what the image communicates.
//
// Everything here is scripted. No inference happens, and none is needed: the
// point is to exercise the real engine, the real persistence and the real UI so
// the captures are genuine app output rather than mocked-up markup.
//
// Run via tools/screenshots/run.sh, not directly.
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 11435);

// MOCK_ONLY="a,b" serves only those models. Lets one script play two different
// boxes - the static demo runs two instances so its Settings page can show a
// lab box and a mini box with honestly different model lists.
const ONLY = (process.env.MOCK_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// Real trained context lengths, and a Modelfile num_ctx for each, so the model
// pickers and the context meter show plausible pills instead of round numbers.
const MODELS = {
  'qwen3-coder:30b':        { ctx: 262144, modelfileCtx: 28672 },
  'gpt-oss:120b':           { ctx: 131072, modelfileCtx: 131072 },
  'gemma3:27b':             { ctx: 131072, modelfileCtx: 32768 },
  'deepseek-r1:32b':        { ctx: 131072, modelfileCtx: 24576 },
  'mistral-small:24b':      { ctx: 131072, modelfileCtx: 32768 },
  'llama3.3:70b':           { ctx: 131072, modelfileCtx: 16384 },
  'nemotron-cascade-2:12b': { ctx: 262144, modelfileCtx: 262144 },
};

const SERVED = Object.fromEntries(
  Object.entries(MODELS).filter(([name]) => !ONLY.length || ONLY.includes(name)),
);

// Roundtable seats, keyed by participant name. Each line is written to show the
// persona doing something a generic reply could not: Inky reverses himself
// mid-turn, Clyde loses the thread, Pac-Man concedes everything and concedes
// nothing.
const ROUNDTABLE = {
  Blinky:
    `Let the record show the charge: four decades of unlicensed consumption. No permit. No remorse. ` +
    `I have pursued this defendant through two hundred and fifty-six levels and I have never once turned around. ` +
    `I am not going to start today.`,
  Pinky:
    `Premeditation, plainly. He does not wander the maze - he *routes* it. ` +
    `Every corner he took was chosen four intersections earlier. I know this because I was ` +
    `already standing at that corner when he arrived, and he did not look surprised.`,
  Inky:
    `Blinky is right, this is open and shut. Although - and I want to be careful here - is it really ` +
    `consumption if we respawn at the top of the maze four seconds later? No. No, I withdraw that. ` +
    `Actually I withdraw the withdrawal. Where is everyone on this?`,
  Clyde:
    `Sorry, what are we - oh, the trial. Right, the trial. Look, has anyone considered that the cherries ` +
    `were just *sitting there*? I would have eaten them. I am not saying he is innocent. I am saying I ` +
    `would like a cherry and I think that is relevant.`,
  'Pac-Man':
    `Friends. Colleagues. I concede every allegation, gladly and without qualification. So here is my offer: ` +
    `I will pause one full second at every corner from now on, giving the patrol a sporting chance, in exchange ` +
    `for blanket immunity on all prior levels. You gain dignity. I gain a clean record. Nobody has to give up a cherry.`,
};

// Council members, keyed by model. Four genuinely different lines of reasoning,
// because the consolidation below has to have something real to reconcile.
const COUNCIL = {
  'gpt-oss:120b':
    `Structurally, yes. Bread outside, filling within - the definition does not care about the hinge, and it ` +
    `does not care about your feelings. A hot dog is a sandwich with one fold instead of two slices.

Yes`,
  'gemma3:27b':
    `No. A sandwich is defined by assembly, and nobody assembles a hot dog - it is *loaded*. The bun is a ` +
    `vessel, not two pieces of bread pretending otherwise.

No`,
  'deepseek-r1:32b':
    `Category error. "Sandwich" is a folk taxonomy, not a formal one. Asking this is like asking whether a ` +
    `tomato is a vegetable: both answers are correct in their own register, and neither is interesting.

Category error`,
  'mistral-small:24b':
    `Yes - and the discomfort people feel saying so out loud is the entire reason this question has survived ` +
    `forty years. If it clearly were not a sandwich, nobody would need to ask.

Yes`,
};

const CONSOLIDATION =
  `Three of four rule for inclusion, but on incompatible grounds: **form** (gpt-oss), **honesty** ` +
  `(mistral-small), and **taxonomy** (deepseek-r1, which declines the question while answering it). ` +
  `Only gemma3 dissents, and it argues from *assembly* rather than from the object - a claim about ` +
  `process, not about the thing on the plate.\n\n` +
  `That distinction is the whole disagreement. Every model reaching "yes" reasoned about structure; ` +
  `the one reaching "no" reasoned about preparation. They are not contradicting each other so much as ` +
  `answering two different questions.\n\n` +
  `**Ruling:** a hot dog is a sandwich in form and a hot dog in practice, and practice is what people ` +
  `actually mean when they ask. Carve that.`;

const PIPELINE = {
  translate:
    `Underlying content, stripped of heat: a force-push to main late on Friday broke the deploy, it is ` +
    `still broken, and the author has not acknowledged it. The sender has raised this twice without a ` +
    `response. The actual grievance is the silence, not the force-push.`,
  diplomat:
    `Hi all - Friday's 4:58pm force-push to main took the deploy down, and it is still down. I have ` +
    `flagged it twice, so I would rather raise it directly than let it sit over the weekend. No blame ` +
    `intended: I would just like whoever pushed to help me get main back to a known-good commit. ` +
    `Happy to pair on it right now if that is easier.`,
  compress:
    `main has been down since Friday's 4:58pm force-push. Third time asking - can whoever pushed help me ` +
    `restore it? Happy to pair.`,
};

const DUCK =
  `What is the condition that makes it stop?\n\n` +
  `And when you trace one call by hand - just one - does that condition ever actually become true, ` +
  `or does it only get closer?\n\n` +
  `What value are you passing down on each call? Is anything changing it?\n\n` +
  `You said you had no idea why. Do you still?`;

function pickReply(body) {
  const msgs = body.messages ?? [];
  const sys = msgs.find((m) => m.role === 'system')?.content ?? '';
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
  const model = body.model ?? '';

  // roundtable.ts opens its framing preamble with the speaker's name.
  const seat = sys.match(/^You are (.+?) in a multi-party/);
  if (seat && ROUNDTABLE[seat[1]]) return ROUNDTABLE[seat[1]];

  if (/rubber duck/i.test(sys)) return DUCK;

  // The consolidator is the one call that receives the assembled transcript.
  if (/RESPONSE FROM/.test(lastUser)) return CONSOLIDATION;

  // Pipeline stages are identified by their template's instruction line ONLY.
  // Matching the whole message misfires: every stage after the first has the
  // previous stage's output pasted in as {{INPUT}}, so a keyword search over
  // the full text makes stages 2 and 3 both match stage 1 and return its reply.
  const head = lastUser.split('\n')[0];
  if (/strip the heat/i.test(head)) return PIPELINE.translate;
  if (/rewrite this/i.test(head)) return PIPELINE.diplomat;
  if (/one line/i.test(head)) return PIPELINE.compress;

  if (COUNCIL[model]) return COUNCIL[model];
  return `(${model} has nothing to add.)`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const read = async () => {
    const c = [];
    for await (const x of req) c.push(x);
    return JSON.parse(Buffer.concat(c).toString('utf8') || '{}');
  };

  if (req.method === 'GET' && url.pathname === '/api/tags') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: Object.keys(SERVED).map((name) => ({ name, size: 2e10 })) }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/show') {
    const { model } = await read();
    const m = MODELS[model] ?? { ctx: 8192, modelfileCtx: null };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      parameters: m.modelfileCtx ? `num_ctx ${m.modelfileCtx}\nstop "<|end|>"` : 'stop "<|end|>"',
      model_info: { 'general.architecture': 'llama', 'llama.context_length': m.ctx },
    }));
    return;
  }

  // Two models resident with believable VRAM, so the sidebar's "on the box"
  // readout has something in it.
  if (req.method === 'GET' && url.pathname === '/api/ps') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [
      { name: 'qwen3-coder:30b', size: 2.04e10, size_vram: 2.04e10 },
      { name: 'gemma3:27b', size: 1.71e10, size_vram: 1.71e10 },
    ] }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    const body = await read();
    const model = body.model ?? 'unknown';
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    let aborted = false;
    req.on('close', () => (aborted = true));

    await sleep(150); // brief pause so the "loading" state is exercised at all
    const words = pickReply(body).split(' ');
    let n = 0;
    for (const w of words) {
      if (aborted) return;
      res.write(JSON.stringify({ model, message: { role: 'assistant', content: w + ' ' }, done: false }) + '\n');
      n++;
      await sleep(6);
    }
    res.write(JSON.stringify({
      model, message: { role: 'assistant', content: '' }, done: true,
      eval_count: n, prompt_eval_count: 320, total_duration: n * 34e6,
    }) + '\n');
    res.end();
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => console.log(`fake-ollama on :${PORT}`));
