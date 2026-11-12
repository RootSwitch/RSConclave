// HTTP for model calls that can wait a long time before the server answers.
// Zero dependencies: node:http, wrapped in a standard Response.
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

export interface LongRequestInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * fetch() without fetch's hidden five-minute deadline.
 *
 * Node's fetch gives up on any request whose response headers take longer than
 * five minutes (undici's headersTimeout, 300 s, which only the undici package
 * can change). Ollama sends no headers on /api/chat or /api/generate until the
 * model is loaded AND the whole prompt has been read - measured on 0.40.16:
 * headers and the first token arrived together, 14.7 s into a 2,368-token
 * prompt. So the wait for headers is the load plus the prompt, and a 66K-token
 * digest on a model that spills into system RAM reads for 7 to 25 minutes.
 * Every such turn died at exactly five minutes as "fetch failed", whatever
 * budget the caller had set, and a council of large models failed on every seat.
 *
 * node:http has no deadline of its own, so the caller's signal is the only one.
 * It sends no Accept-Encoding, so the reply arrives uncompressed and needs no
 * decoding - which fetch would otherwise have done. The result is a standard
 * Response: status, ok, text(), json() and a web ReadableStream body, so
 * callers read it exactly as they read fetch's. Cancelling that body, or
 * aborting the signal mid-stream, destroys the socket, which is how Ollama
 * learns to stop generating.
 */
export function longRequest(url: string, init: LongRequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const headers: Record<string, string | number> = { ...init.headers };
    if (init.body !== undefined) headers['content-length'] = Buffer.byteLength(init.body);
    const req = (target.protocol === 'https:' ? https : http).request(
      target,
      { method: init.method ?? 'GET', headers, signal: init.signal },
      (res) => {
        try {
          const out = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            for (const v of Array.isArray(value) ? value : [value]) out.append(name, v);
          }
          const status = res.statusCode ?? 0;
          // A Response refuses a body on these statuses.
          const empty = status === 204 || status === 205 || status === 304;
          if (empty) res.resume();
          resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
            status, statusText: res.statusMessage, headers: out,
          }));
        } catch (err) {
          res.destroy();
          reject(err);
        }
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
}

/**
 * The words in a network error that say what actually went wrong.
 *
 * fetch reports every failure as "fetch failed" and puts the reason on .cause,
 * so a five-minute header timeout on a box that was answering fine reached the
 * user as "Cannot reach <endpoint> ...: fetch failed". And a connection refused on a
 * host with several addresses is an AggregateError whose own message is empty;
 * the useful text is on its .errors.
 */
export function errorText(err: unknown): string {
  const e = err as { message?: string; code?: string; errors?: unknown[]; cause?: unknown } | null | undefined;
  const own = e?.message
    || (Array.isArray(e?.errors) && e.errors.length ? e.errors.map(errorText).join('; ') : '')
    || e?.code
    || String(err);
  return e?.cause !== undefined && e.cause !== err ? `${own} (${errorText(e.cause)})` : own;
}
