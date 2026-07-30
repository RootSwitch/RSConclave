// Minimal method+path router with JSON body handling.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { InputError } from './errors.ts';

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  query: URLSearchParams,
) => Promise<void> | void;

interface Route {
  method: string;
  segments: string[]; // ':name' segments are params
  handler: Handler;
}

const routes: Route[] = [];

export function route(method: string, pattern: string, handler: Handler): void {
  routes.push({ method, segments: pattern.split('/').filter(Boolean), handler });
}

const MAX_BODY = 10 * 1024 * 1024;

export function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      if (tooLarge) return; // already rejected; drain and discard the rest
      size += c.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0; // stop holding what we read
        // Drain rather than destroy. Destroying here closed the socket before
        // the 413 could be written, so the client saw a dropped connection
        // instead of an error it could report.
        req.resume();
        reject(new HttpError(413, 'body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * An InputError with the status first, kept because every route already reads
 * that way. Anything thrown as either lands on its own status; see errors.ts.
 */
export class HttpError extends InputError {
  constructor(status: number, message: string) {
    super(message, status);
  }
}

/** Try to dispatch; returns false if no route matched. */
export async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const segs = url.pathname.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== req.method || r.segments.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    let badEscape = false;
    for (let i = 0; i < segs.length; i++) {
      const pat = r.segments[i];
      if (pat.startsWith(':')) {
        /*
         * decodeURIComponent throws URIError on a malformed escape, and this
         * runs OUTSIDE the try/catch that wraps the handler below - so
         * "/api/sessions/%zz" threw straight past dispatch, became an unhandled
         * rejection, and the request hung with no response ever written.
         *
         * The answer is written here rather than thrown, because a throw from
         * this position escapes dispatch just as the URIError did and reproduces
         * the same hang. (First version of this fix did exactly that.)
         */
        try {
          params[pat.slice(1)] = decodeURIComponent(segs[i]);
        } catch {
          badEscape = true;
          break;
        }
      } else if (pat !== segs[i]) {
        ok = false;
        break;
      }
    }
    if (badEscape) {
      sendJson(res, 400, { error: 'malformed percent-encoding in the URL' });
      return true;
    }
    if (!ok) continue;
    try {
      await r.handler(req, res, params, url.searchParams);
    } catch (err: any) {
      // InputError covers HttpError too. Anything else really is our fault and
      // stays a 500 - mapping unknown throws to 400 would hide real bugs.
      const status = err instanceof InputError ? err.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: err?.message ?? 'internal error' });
      else res.end();
    }
    return true;
  }
  return false;
}
