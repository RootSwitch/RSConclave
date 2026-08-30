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

/*
 * Bytes in a stated gigabyte.
 *
 * A card sold as "24 GB" holds 24 GiB, and Windows Task Manager - where anyone
 * checks this - says "24.0 GB" while meaning exactly that. So the number typed
 * into Settings is read the way the person typing it means it, and every figure
 * reported back is divided by the same constant. The app and Task Manager then
 * agree, which is the only comparison a user can actually make.
 *
 * This was 1e9, which quietly under-counted a 24 GB card by 1.8 GB and turned
 * the stated safety margin below into a real one of about 16%.
 */
const GIB = 1024 ** 3;

/*
 * Ollama refuses to place a model that would not comfortably fit, so aim below
 * the card rather than at it. This also absorbs what /api/ps cannot see: a
 * desktop compositor or a browser holding VRAM is invisible to the free
 * calculation, and on the machine this feature is aimed at, there is always a
 * desktop.
 *
 * 0.85 rather than 0.9 because fixing GIB above removed an accidental margin
 * that had been doing real work. Chosen to land within a couple of hundred MB
 * of the old EFFECTIVE headroom, so the change is a correction of the units
 * rather than a change of policy.
 */
const SAFETY = 0.85;
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
  /** True when the weights alone do not fit within the safety budget. */
  notFitting: boolean;
  /*
   * Set with notFitting when the probe nevertheless showed the whole model
   * resident (size_vram == size). It fits the card and only overruns the
   * margin, which is a different thing to tell someone than "it runs in system
   * RAM" - that answer sends them shopping for a card they already own.
   */
  fitsWithoutMargin?: boolean;
  /*
   * True when the answer came from the model's size on disk instead of a load,
   * because loading it could only have paged. baseBytes is then that disk size
   * and probes is empty, so a caller must not present it as a measurement.
   */
  skippedLoad?: boolean;
  /*
   * True when the probes showed the model running entirely on the CPU
   * (size_vram 0). A stated VRAM figure describes hardware that is not being
   * used, so no window is recommended from it - the real limit is system RAM,
   * which nothing here can see.
   */
  onCpu?: boolean;
  /*
   * Present when the recommendation was checked by loading at it rather than
   * only extrapolated to. largestResident is the biggest window the card
   * actually took whole; spilledAt is the smallest known to spill, or null if
   * the first guess was already good.
   */
  verified?: { largestResident: number; spilledAt: number | null; extrapolated: number };
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
): Pick<MeasureResult, 'bytesPerToken' | 'baseBytes' | 'uncappedMax' | 'recommended' | 'cappedByTrained' | 'notFitting' | 'fitsWithoutMargin'> {
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
    // Whether the card actually held it is what separates "over the margin"
    // from "spilling", and the probe already answered that.
    const fitsWithoutMargin = lo.total > 0 && lo.vram >= lo.total * 0.999;
    return {
      bytesPerToken, baseBytes, uncappedMax: 0, recommended: null,
      cappedByTrained: false, notFitting: true, fitsWithoutMargin,
    };
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

async function api(
  endpoint: Endpoint, path: string, body?: unknown, timeoutMs = 900_000, signal?: AbortSignal,
): Promise<any> {
  // Two ways to give up: the timeout, and the user pressing Cancel. Combined
  // rather than chosen between, so a cancel lands mid-load instead of waiting
  // out a fifteen-minute budget.
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(`${base(endpoint)}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`);
  return res.json();
}

/**
 * On-disk size of a model, from /api/tags. Weights cannot occupy less memory
 * than they occupy on disk, so this is a lower bound that costs one cheap GET
 * and can be known BEFORE anything is loaded.
 */
async function diskSize(endpoint: Endpoint, model: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const data = await api(endpoint, '/api/tags', undefined, 15_000, signal);
    const want = psName(model);
    for (const m of data?.models ?? []) {
      if (String(m.name) === want) return Number(m.size ?? 0) || null;
    }
  } catch {
    // Not knowing the size is not a reason to refuse to measure.
  }
  return null;
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
async function probe(endpoint: Endpoint, model: string, numCtx: number, signal?: AbortSignal): Promise<Probe> {
  await api(endpoint, '/api/generate', {
    model,
    prompt: 'hi',
    stream: false,
    keep_alive: '2m',
    options: { num_ctx: numCtx, num_predict: 1 },
  }, 900_000, signal);
  const entry = (await api(endpoint, '/api/ps', undefined, 30_000))?.models
    ?.find((m: any) => String(m.name) === psName(model));
  if (!entry) throw new Error(`loaded ${model} at num_ctx ${numCtx} but it was not in /api/ps`);
  return { numCtx, total: Number(entry.size ?? 0), vram: Number(entry.size_vram ?? 0) };
}

/** Did the card take all of it? A hair under 1 to absorb rounding in /api/ps. */
function isResident(p: Probe): boolean {
  return p.total > 0 && p.vram >= p.total * 0.999;
}

/*
 * Confirm the recommendation by loading at it, and walk it down until the card
 * actually takes the whole model.
 *
 * The slope from two small probes is a MODEL of the cost, and on real hardware
 * it over-promises badly. Measured on a 24 GB 7900XTX, qwen3.6:27b reported
 * 100% resident at 32k, 85% at 98k, 73% at 131k and 58% at 176k - while the
 * extrapolation, which only ever saw 2k and 8k, happily recommended 176k. Two
 * reasons: Ollama decides how many layers to offload at load time using its own
 * estimate, and /api/ps "size" understates what that estimate reserves once the
 * context is large. Neither is visible from the low end of the curve.
 *
 * So the answer stops being extrapolated and starts being verified. Binary
 * search between a context known to be resident and the first one known to
 * spill, which costs a handful of loads and is the difference between a number
 * that is true and a number that merely fits the arithmetic.
 */
async function verifyResident(
  endpoint: Endpoint, model: string, target: number, knownGood: number, signal?: AbortSignal,
): Promise<{ probes: Probe[]; largestResident: number; spilledAt: number | null }> {
  const probes: Probe[] = [];
  const first = await probe(endpoint, model, target, signal);
  probes.push(first);
  if (isResident(first)) return { probes, largestResident: target, spilledAt: null };

  let lo = knownGood;        // resident, by construction: it was probed above
  let hi = target;           // spills
  // Four steps narrows a 32k-176k gap to about 9k, which is finer than the 4k
  // rounding that follows. More would cost a model load each for no more
  // precision than the answer is reported to.
  for (let i = 0; i < 4 && hi - lo > STEP; i++) {
    const mid = Math.max(Math.floor((lo + hi) / 2 / STEP) * STEP, lo + STEP);
    if (mid >= hi) break;
    const p = await probe(endpoint, model, mid, signal);
    probes.push(p);
    if (isResident(p)) lo = mid; else hi = mid;
  }
  return { probes, largestResident: lo, spilledAt: hi };
}

export interface MeasureOptions {
  low?: number;
  high?: number;
  /** Size against the whole card, ignoring what is loaded beside it. */
  assumeEmpty?: boolean;
  /** Cancel: aborts the in-flight load and unloads whatever it started. */
  signal?: AbortSignal;
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
  const budgetBytes = Math.max(totalVramGb * GIB - heldByOthersBytes, 0) * SAFETY;
  const vram: VramBudget = {
    totalGb: totalVramGb,
    heldByOthersBytes,
    otherModels: [...resident.keys()],
    budgetBytes,
  };

  /*
   * Refuse to load something that provably cannot fit. Weights occupy at least
   * what they occupy on disk, so a model bigger than the whole budget is
   * hopeless before any of it is read - and loading it anyway is not a slow
   * measurement, it is the machine paging itself into the ground for several
   * minutes to learn something /api/tags already said.
   *
   * The answer returned is the real one (notFitting), just reached without the
   * damage, with the disk figure standing in for the weights it declined to
   * load. Only a clear-cut case is refused: a model that merely looks tight is
   * still measured, because the disk size is a lower bound and the interesting
   * models are the ones near the line.
   */
  // Compared against the WHOLE card, not the safety-reduced budget: this
  // exists to catch the hopeless, not the tight. A model just over the
  // margin still has something worth measuring - and on a 24 GB card, an
  // MoE at 21 GB turned out to load entirely into VRAM.
  const capacityBytes = Math.max(totalVramGb * GIB - heldByOthersBytes, 0);
  const onDisk = await diskSize(endpoint, model, opts.signal);
  if (onDisk && onDisk >= capacityBytes) {
    return {
      model,
      probes: [],
      bytesPerToken: 0,
      baseBytes: onDisk,
      trainedMax: null,
      currentNumCtx: null,
      budgetBytes,
      vram,
      uncappedMax: 0,
      recommended: null,
      cappedByTrained: false,
      notFitting: true,
      skippedLoad: true,
    };
  }

  const probes = [
    await probe(endpoint, model, low, opts.signal),
    await probe(endpoint, model, high, opts.signal),
  ];

  const info = await getModelInfo(endpoint, model);
  const projection = project(probes, budgetBytes, info?.contextLength ?? null);

  /*
   * A model already running on the CPU has nothing to size. The Ally X reports
   * size_vram 0 for qwen3.5:4b because its 780M is not a GPU Ollama will use,
   * and budgeting that against a stated VRAM figure would invent an answer
   * about hardware not in play. Say so instead.
   */
  const onCpu = probes.every((p) => p.total > 0 && p.vram === 0);
  if (onCpu) {
    /*
     * The slope is still real - context costs memory either way, and that is
     * worth reporting. The RECOMMENDATION is not: it was derived from a stated
     * VRAM figure describing a card taking none of the work. Returning it
     * anyway would be the confident-wrong-number failure this whole feature
     * keeps running into. The real ceiling is free system RAM, which nothing
     * reachable over HTTP can see.
     */
    projection.recommended = null;
    projection.cappedByTrained = false;
  }

  let verified: MeasureResult['verified'];
  if (!onCpu && !projection.notFitting && projection.recommended && projection.recommended > high) {
    const v = await verifyResident(endpoint, model, projection.recommended, high, opts.signal);
    probes.push(...v.probes);
    verified = {
      largestResident: v.largestResident,
      spilledAt: v.spilledAt,
      // What the extrapolation had claimed, kept so the report can say the
      // verification changed the answer rather than silently returning a
      // smaller number than the arithmetic implied.
      extrapolated: projection.recommended,
    };
    projection.recommended = v.largestResident;
    if (v.spilledAt !== null) projection.cappedByTrained = false;
  }

  await unload(endpoint, model);

  return {
    model,
    probes,
    trainedMax: info?.contextLength ?? null,
    currentNumCtx: info?.numCtx ?? null,
    budgetBytes,
    vram,
    onCpu,
    verified,
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
