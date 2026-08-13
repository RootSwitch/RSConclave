// Inference clients: model discovery + streaming chat for Ollama and
// OpenAI-compatible (llama.cpp server) endpoints. Zero dependencies.
import type { ChatMessage, Endpoint, GenParams, StreamResult } from './types.ts';

const IDLE_TIMEOUT_MS = 120_000; // abort if no bytes arrive for this long mid-stream
/*
 * Budget for the first byte, which covers loading the model and processing the
 * prompt on the remote box. Generous rather than absent: the run slot is a
 * shared resource, so a box that never answers must not hold it forever.
 */
const FIRST_BYTE_TIMEOUT_MS = 10 * 60 * 1000;

export async function discoverModels(endpoint: Endpoint): Promise<string[]> {
  const base = endpoint.baseUrl.replace(/\/+$/, '');
  try {
    if (endpoint.kind === 'ollama') {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: any = await res.json();
      return (data.models ?? []).map((m: any) => String(m.name)).sort();
    } else {
      const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: any = await res.json();
      return (data.data ?? []).map((m: any) => String(m.id)).sort();
    }
  } catch (err: any) {
    const why = err?.name === 'TimeoutError' ? 'timed out' : (err?.message ?? String(err));
    throw new Error(`Cannot reach ${endpoint.name} (${base}): ${why} - is the box on?`);
  }
}

export interface ModelInfo {
  contextLength: number | null; // trained maximum
  numCtx: number | null; // Modelfile-configured window (null = Ollama server default, usually 4096)
}

/**
 * Parse Ollama's POST /api/show response: trained max lives in
 * model_info["<arch>.context_length"], Modelfile num_ctx in the parameters text.
 */
export function parseModelInfo(data: any): ModelInfo {
  let contextLength: number | null = null;
  for (const [key, value] of Object.entries(data?.model_info ?? {})) {
    if (key.endsWith('.context_length') && typeof value === 'number') {
      contextLength = value;
      break;
    }
  }
  let numCtx: number | null = null;
  const params: string = typeof data?.parameters === 'string' ? data.parameters : '';
  const m = params.match(/(?:^|\n)\s*num_ctx\s+(\d+)/);
  if (m) numCtx = parseInt(m[1], 10);
  return { contextLength, numCtx };
}

/*
 * Cached so the context meter does not pay an /api/show round trip on every
 * turn - but no longer cached FOREVER. A Modelfile is not immutable:
 * measure-ctx.sh --apply bakes a new num_ctx into the model on the box, and a
 * forever-cache kept reporting the pre-bake default until the server was
 * restarted. Deleting and re-adding the endpoint did not help, because the key
 * is the base URL and model name, which a re-add does not change - exactly the
 * recovery a reasonable person tries first. Five minutes keeps the per-turn
 * saving; clearModelInfoCache() covers "I just changed it, ask again".
 */
const MODEL_INFO_TTL_MS = 5 * 60 * 1000;
const modelInfoCache = new Map<string, { info: ModelInfo; at: number }>();

export function clearModelInfoCache(): void {
  modelInfoCache.clear();
}

/** Context info for a model (Ollama only; cached). Returns null when unavailable. */
export async function getModelInfo(endpoint: Endpoint, model: string): Promise<ModelInfo | null> {
  if (endpoint.kind !== 'ollama') return null;
  const base = endpoint.baseUrl.replace(/\/+$/, '');
  const key = `${base}|${model}`;
  const cached = modelInfoCache.get(key);
  if (cached && Date.now() - cached.at < MODEL_INFO_TTL_MS) return cached.info;
  try {
    const res = await fetch(`${base}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const info = parseModelInfo(await res.json());
    modelInfoCache.set(key, { info, at: Date.now() });
    return info;
  } catch {
    return null;
  }
}

export interface StreamChatArgs {
  endpoint: Endpoint;
  model: string;
  messages: ChatMessage[];
  params?: GenParams;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onFirstToken?: () => void;
}

export async function streamChat(args: StreamChatArgs): Promise<StreamResult> {
  return args.endpoint.kind === 'ollama' ? streamOllama(args) : streamOpenAi(args);
}

/**
 * Reads a byte stream and yields complete text lines, handling chunk
 * boundaries that split lines (or multi-byte chars) arbitrarily.
 */
export async function* readLines(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let gotFirstByte = false;
  try {
    while (true) {
      /*
       * The FIRST read gets its own, much longer budget.
       *
       * Racing every read against the same 120s idle timer included the first
       * one - and a server that sends response headers before it starts
       * generating (llama.cpp's SSE does, and so does our own mock) spends the
       * model load and the prompt processing inside that first read. Loading a
       * 30B from cold disk past 120 seconds is ordinary, so the run aborted with
       * "no data for 120s" while the UI was still truthfully saying "loading
       * model". The README promised exactly that would not happen.
       *
       * Not unbounded, though: a wedged box would otherwise hold the only run
       * slot until someone noticed and pressed Cancel.
       */
      const budget = gotFirstByte ? IDLE_TIMEOUT_MS : FIRST_BYTE_TIMEOUT_MS;
      const idle = new Promise<never>((_, reject) => {
        idleTimer = setTimeout(
          () => reject(new Error(
            gotFirstByte
              ? `no data for ${IDLE_TIMEOUT_MS / 1000}s - giving up`
              : `no first token after ${FIRST_BYTE_TIMEOUT_MS / 60000} minutes - giving up`,
          )),
          budget,
        );
      });
      const { done, value } = await Promise.race([reader.read(), idle]);
      clearTimeout(idleTimer);
      if (done) break;
      if (signal.aborted) break;
      gotFirstByte = true;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        yield buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
      }
    }
    /*
     * Flush the decoder. Every decode() above passes {stream: true}, which holds
     * back the bytes of a character split across chunks - so a stream that ended
     * mid-character left those bytes inside the decoder and they were simply
     * lost. The flush can also complete a final line, hence the loop.
     */
    buf += decoder.decode();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
    }
    // The last line has no newline to strip a CR from, so do it here too.
    if (buf.trim()) yield buf.replace(/\r$/, '');
  } finally {
    clearTimeout(idleTimer);
    reader.releaseLock();
    try {
      await body.cancel();
    } catch {}
  }
}

function buildOptions(params?: GenParams): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (params?.temperature !== undefined) o.temperature = params.temperature;
  if (params?.top_p !== undefined) o.top_p = params.top_p;
  if (params?.num_ctx !== undefined) o.num_ctx = params.num_ctx;
  if (params?.maxTokens !== undefined) o.num_predict = params.maxTokens;
  return o;
}

/**
 * Reasoning models arrive in two stream shapes: older templates put
 * "<think>...</think>" inline in content; modern Ollama (and DeepSeek-style
 * openai-compat servers) put reasoning in a SEPARATE field per chunk. This
 * normalizer folds the separate field back into the inline convention, so
 * everything downstream - live streaming, the collapse UI, context
 * stripping, exports - handles both shapes with one code path.
 *
 * Without it the separate-field shape was worse than silent: reasoning
 * deltas were dropped, and since onFirstToken only fired on content, the UI
 * said "loading model on remote box" for the entire reasoning phase.
 */
export function makeThinkNormalizer(push: (delta: string) => void): {
  thinking: (delta: string) => void;
  content: (delta: string) => void;
  finish: () => void;
} {
  let inThinking = false;
  return {
    thinking(delta: string) {
      if (!delta) return;
      if (!inThinking) {
        push('<think>');
        inThinking = true;
      }
      push(delta);
    },
    content(delta: string) {
      if (!delta) return;
      if (inThinking) {
        push('</think>\n');
        inThinking = false;
      }
      push(delta);
    },
    // A cancelled or thinking-only response must still close the tag, or the
    // collapse UI falls back to raw text.
    finish() {
      if (inThinking) {
        push('</think>');
        inThinking = false;
      }
    },
  };
}

async function streamOllama(args: StreamChatArgs): Promise<StreamResult> {
  const base = args.endpoint.baseUrl.replace(/\/+$/, '');
  const body: Record<string, unknown> = {
    model: args.model,
    messages: args.messages,
    stream: true,
    options: buildOptions(args.params),
  };
  const keepAlive = args.params?.keep_alive ?? args.endpoint.defaultKeepAlive;
  if (keepAlive !== undefined) body.keep_alive = keepAlive;

  const started = Date.now();
  const res = await doPost(`${base}/api/chat`, body, args);
  let text = '';
  let first = true;
  let evalCount: number | undefined;
  let doneReason: string | undefined;
  let aborted = false;
  const push = (delta: string) => {
    if (first) {
      first = false;
      args.onFirstToken?.(); // reasoning counts as the model being alive
    }
    text += delta;
    args.onDelta(delta);
  };
  const norm = makeThinkNormalizer(push);
  try {
    for await (const line of readLines(res.body!, args.signal)) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      if (obj.error) throw new Error(String(obj.error));
      norm.thinking(obj.message?.thinking ?? '');
      norm.content(obj.message?.content ?? '');
      if (obj.done) {
        evalCount = obj.eval_count;
        // 'length' means it stopped because num_predict ran out, not because it
        // had finished - which is the difference the Continue button needs.
        doneReason = typeof obj.done_reason === 'string' ? obj.done_reason : undefined;
        break;
      }
    }
  } catch (err: any) {
    if (args.signal.aborted) aborted = true;
    else {
      // Carry the partial text out with the error. Throwing bare discarded
      // everything already streamed, so an idle timeout or a mid-stream
      // {"error":...} replaced the text the user was watching with an empty
      // error bubble. A user-initiated Stop kept its partial; a failure did not.
      norm.finish();
      throw Object.assign(err, { partialText: text });
    }
  }
  norm.finish();
  if (args.signal.aborted) aborted = true;
  return { text, stats: { evalCount, durationMs: Date.now() - started }, aborted, doneReason };
}

async function streamOpenAi(args: StreamChatArgs): Promise<StreamResult> {
  const base = args.endpoint.baseUrl.replace(/\/+$/, '');
  const body: Record<string, unknown> = {
    model: args.model,
    messages: args.messages,
    stream: true,
  };
  if (args.params?.temperature !== undefined) body.temperature = args.params.temperature;
  if (args.params?.top_p !== undefined) body.top_p = args.params.top_p;
  if (args.params?.maxTokens !== undefined) body.max_tokens = args.params.maxTokens;

  const started = Date.now();
  const res = await doPost(`${base}/v1/chat/completions`, body, args);
  let text = '';
  let first = true;
  let aborted = false;
  let openAiTruncated = false;
  const push = (delta: string) => {
    if (first) {
      first = false;
      args.onFirstToken?.();
    }
    text += delta;
    args.onDelta(delta);
  };
  const norm = makeThinkNormalizer(push);
  try {
    for await (const line of readLines(res.body!, args.signal)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') break;
      if (!payload) continue;
      const obj = JSON.parse(payload);
      if (obj.error) throw new Error(String(obj.error?.message ?? obj.error));
      const finish = obj.choices?.[0]?.finish_reason;
      if (finish === 'length') openAiTruncated = true;
      const d = obj.choices?.[0]?.delta ?? {};
      // reasoning_content is the DeepSeek-style field; some servers say reasoning
      norm.thinking(d.reasoning_content ?? d.reasoning ?? '');
      norm.content(d.content ?? '');
    }
  } catch (err: any) {
    if (args.signal.aborted) aborted = true;
    else {
      norm.finish();
      throw Object.assign(err, { partialText: text }); // see streamOllama
    }
  }
  norm.finish();
  if (args.signal.aborted) aborted = true;
  return {
    text, stats: { durationMs: Date.now() - started }, aborted,
    doneReason: openAiTruncated ? 'length' : undefined,
  };
}

async function doPost(url: string, body: unknown, args: StreamChatArgs): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: args.signal,
    });
  } catch (err: any) {
    if (args.signal.aborted) throw err;
    throw new Error(`Cannot reach ${args.endpoint.name} (${url}): ${err?.message ?? err}`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {}
    throw new Error(`${args.endpoint.name} returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  if (!res.body) throw new Error('response had no body');
  return res;
}
