/*
 * Measure the largest num_ctx a model can hold on a given box, and optionally
 * bake it in.
 *
 * This is tools/measure-ctx.sh moved into the app, for the person whose whole
 * setup is Ollama and this app on one Windows machine. That script is POSIX
 * sh, so it needs Git Bash or WSL before it can even start - a fair ask of
 * someone running a headless Ubuntu GPU host, and an absurd one of someone who
 * just wanted to talk to a model on their gaming PC.
 *
 * Nothing here shells out. Every step is HTTP against the endpoint, which is
 * why it can live in the server at all: probe loads through /api/generate,
 * footprints from /api/ps, the trained ceiling from /api/show, and the bake
 * through /api/create.
 *
 * The one thing the script can do that this cannot is read the card directly
 * with nvidia-smi. See vramBasis below for what replaces it.
 */
import type { Endpoint } from './types.ts';
import { getModelInfo } from './providers.ts';

/** Ollama refuses to place a model that would not comfortably fit. */
const SAFETY = 0.9;
/** Any num_ctx is legal; 4k steps waste less headroom than powers of two. */
const STEP = 4096;
const MIN_CTX = 2048;

export interface Probe {
  numCtx: number;
  total: number; // bytes, /api/ps "size"
  vram: number;  // bytes, /api/ps "size_vram"
}

export interface MeasureResult {
  model: string;
  probes: Probe[];
  /** Bytes of VRAM per token of context, for this model on this box. */
  bytesPerToken: number;
  /** Weights plus fixed buffers: the cost before any context. */
  baseBytes: number;
  /** Trained ceiling from /api/show, null when unreadable. */
  trainedMax: number | null;
  /** What num_ctx is set on the model right now, null = Ollama's default. */
  currentNumCtx: number | null;
  budgetBytes: number;
  /** Largest window the budget allows, before the trained cap and rounding. */
  uncappedMax: number;
  /** null when the weights alone exceed the budget - see notFitting. */
  recommended: number | null;
  /** True when the trained ceiling bound the answer rather than VRAM. */
  cappedByTrained: boolean;
  /** True when the weights alone do not fit; the model will run partly in RAM. */
  notFitting: boolean;
  vram: VramBudget;
}

/*
 * Where the budget came from. The shell script reads the card with nvidia-smi,
 * which is impossible from here: the app is frequently not on the box, and
 * even when it is, a browser cannot run it.
 *
 * So the total is stated once per endpoint in Settings, and what is free is
 * derived from /api/ps - the models currently resident, minus the one being
 * measured, since a model must not be budgeted against the space beside
 * itself. This is better than the script in the remote case and worse in one
 * specific way, which the UI has to say out loud: /api/ps sees only what
 * OLLAMA is holding. A desktop compositor, a browser, or a game holding two
 * gigabytes is invisible here, so on a machine someone is actually using, the
 * free figure is an overestimate.
 */
export interface VramBudget {
  totalGb: number;
  /** Bytes held by OTHER models right now, from /api/ps. */
  heldByOthersBytes: number;
  otherModels: string[];
  /** totalGb minus what others hold, times the safety factor. */
  budgetBytes: number;
}

/** /api/ps reports fully qualified names, so "gemma3" comes back "gemma3:latest". */
export function psName(model: string): string {
  return model.includes(':') ? model : `${model}:latest`;
}

/**
 * The arithmetic, separated from the network so it can be tested without a
 * daemon. Two probes give a line: the slope is the per-token cost, and the
 * intercept is everything that does not scale with context.
 */
export function project(
  probes: Probe[],
  budgetBytes: number,
  trainedMax: number | null,
): Pick<MeasureResult, 'bytesPerToken' | 'baseBytes' | 'uncappedMax' | 'recommended' | 'cappedByTrained' | 'notFitting'> {
  const [lo, hi] = probes;
  const span = hi.numCtx - lo.numCtx;
  /*
   * A zero or negative slope is not an error to throw on. Ollama rounds
   * allocations, and on a model whose context is nearly free the two probes
   * can come back identical - which is information, not a failure. Treating
   * it as "context costs nothing" would then recommend an unbounded window,
   * so it clamps to a floor of one byte per token and the trained cap does
   * the real work.
   */
  const rawSlope = span > 0 ? (hi.total - lo.total) / span : 0;
  const bytesPerToken = Math.max(rawSlope, 1);
  const baseBytes = lo.total - bytesPerToken * lo.numCtx;

  if (baseBytes >= budgetBytes) {
    return { bytesPerToken, baseBytes, uncappedMax: 0, recommended: null, cappedByTrained: false, notFitting: true };
  }

  const uncappedMax = (budgetBytes - baseBytes) / bytesPerToken;
  let recommended = Math.max(Math.floor(uncappedMax / STEP) * STEP, MIN_CTX);
  let cappedByTrained = false;
  // VRAM is one ceiling; the training window is the other, and past it the
  // model does not work at that length however much memory is free.
  if (trainedMax && recommended > trainedMax) {
    recommended = Math.max(Math.floor(trainedMax / STEP) * STEP, MIN_CTX);
    if (recommended > trainedMax) recommended = trainedMax;
    cappedByTrained = true;
  }
  return { bytesPerToken, baseBytes, uncappedMax, recommended, cappedByTrained, notFitting: false };
}

function base(endpoint: Endpoint): string {
  return endpoint.baseUrl.replace(/\/+$/, '');
}

async function api(endpoint: Endpoint, path: string, body?: unknown, timeoutMs = 900_000): Promise<any> {
  const res = await fetch(`${base(endpoint)}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`);
  return res.json();
}

/** Everything resident right now, as name -> bytes in VRAM. */
async function loaded(endpoint: Endpoint): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const data = await api(endpoint, '/api/ps', undefined, 10_000);
    for (const m of data?.models ?? []) {
      out.set(String(m.name), Number(m.size_vram ?? m.size ?? 0));
    }
  } catch {
    // An unreadable /api/ps means "nothing known to be loaded", which is the
    // same budget an idle box gives. It must not abort the measurement.
  }
  return out;
}

async function unload(endpoint: Endpoint, model: string): Promise<void> {
  try {
    await api(endpoint, '/api/generate', { model, keep_alive: 0 }, 60_000);
  } catch {
    // Already gone, or the daemon declined. Either way the probe below is
    // what actually establishes the footprint.
  }
}

/** Wait for a model to actually leave /api/ps; freeing VRAM is not instant. */
async function waitUnloaded(endpoint: Endpoint, model: string, tries = 20): Promise<void> {
  const want = psName(model);
  for (let i = 0; i < tries; i++) {
    if (!(await loaded(endpoint)).has(want)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Load at one context size and read back the real footprint. */
async function probe(endpoint: Endpoint, model: string, numCtx: number): Promise<Probe> {
  await api(endpoint, '/api/generate', {
    model,
    prompt: 'hi',
    stream: false,
    keep_alive: '2m',
    options: { num_ctx: numCtx, num_predict: 1 },
  });
  const entry = (await api(endpoint, '/api/ps', undefined, 30_000))?.models
    ?.find((m: any) => String(m.name) === psName(model));
  if (!entry) throw new Error(`loaded ${model} at num_ctx ${numCtx} but it was not in /api/ps`);
  return { numCtx, total: Number(entry.size ?? 0), vram: Number(entry.size_vram ?? 0) };
}

export interface MeasureOptions {
  low?: number;
  high?: number;
  /** Size against the whole card, ignoring what is loaded beside it. */
  assumeEmpty?: boolean;
}

/**
 * Load the model twice, take the slope, and report the largest window that
 * stays resident. Leaves the box as it found it: the model is unloaded before
 * measuring so it is not budgeted against itself, and again afterwards so a
 * measurement does not pin the card.
 */
export async function measureContext(
  endpoint: Endpoint,
  model: string,
  totalVramGb: number,
  opts: MeasureOptions = {},
): Promise<MeasureResult> {
  if (endpoint.kind !== 'ollama') throw new Error('context measurement needs an Ollama endpoint');
  if (!(totalVramGb > 0)) throw new Error('set this endpoint\'s VRAM in Settings first');
  const low = opts.low ?? 2048;
  const high = opts.high ?? 8192;
  if (!(high > low)) throw new Error('the high probe must exceed the low probe');

  await unload(endpoint, model);
  await waitUnloaded(endpoint, model);

  const resident = await loaded(endpoint);
  resident.delete(psName(model));
  const heldByOthersBytes = opts.assumeEmpty
    ? 0
    : [...resident.values()].reduce((a, b) => a + b, 0);
  const budgetBytes = Math.max(totalVramGb * 1e9 - heldByOthersBytes, 0) * SAFETY;
  const vram: VramBudget = {
    totalGb: totalVramGb,
    heldByOthersBytes,
    otherModels: [...resident.keys()],
    budgetBytes,
  };

  const probes = [await probe(endpoint, model, low), await probe(endpoint, model, high)];
  await unload(endpoint, model);

  const info = await getModelInfo(endpoint, model);
  const projection = project(probes, budgetBytes, info?.contextLength ?? null);

  return {
    model,
    probes,
    trainedMax: info?.contextLength ?? null,
    currentNumCtx: info?.numCtx ?? null,
    budgetBytes,
    vram,
    ...projection,
  };
}

/**
 * Bake num_ctx into the model, under the same name so every client of the
 * daemon gets it - not just this app.
 *
 * `from` names a model rather than a file, so the daemon resolves it out of
 * its own blobs: a new manifest over the same weights, nothing uploaded and
 * nothing re-quantised. Ollama renamed these request fields, so a daemon that
 * rejects the current shape is retried with the older one.
 */
export async function applyNumCtx(endpoint: Endpoint, model: string, numCtx: number): Promise<void> {
  if (endpoint.kind !== 'ollama') throw new Error('baking num_ctx needs an Ollama endpoint');
  if (!Number.isInteger(numCtx) || numCtx < MIN_CTX) throw new Error(`refusing to bake num_ctx ${numCtx}`);
  const shapes = [
    { model, from: model, parameters: { num_ctx: numCtx }, stream: false },
    { name: model, modelfile: `FROM ${model}\nPARAMETER num_ctx ${numCtx}`, stream: false },
  ];
  let last = '';
  for (const body of shapes) {
    try {
      const out = await api(endpoint, '/api/create', body, 300_000);
      if (out?.status === 'success') return;
      last = JSON.stringify(out);
    } catch (err: any) {
      last = err?.message ?? String(err);
    }
  }
  throw new Error(`create failed on ${endpoint.name}: ${last}`);
}
