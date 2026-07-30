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

/*
 * Body caps.
 *
 * One 10 MB cap for everything meant the two PUBLIC routes - login and setup -
 * would each buffer 10 MB from an unauthenticated client before looking at it,
 * and then hand the result to scrypt. A couple of hundred concurrent requests
 * was gigabytes held plus a saturated libuv threadpool, with every other fs and
 * crypto job queued behind the scrypt runs. Credentials are a few hundred bytes;
 * the cap should say so.
 */
const MAX_BODY = 1024 * 1024;
/** Public, unauthenticated routes: enough for a username and a password. */
export const SMALL_BODY = 4 * 1024;
/** Session import, the one route that legitimately carries a large document. */
export const BIG_BODY = 10 * 1024 * 1024;

export function readJsonBody(req: IncomingMessage, max = MAX_BODY): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;

    // Refuse on the declared length before reading a byte, when it is declared.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) {
      req.resume();
      reject(new HttpError(413, 'body too large'));
      return;
    }

    req.on('data', (c: Buffer) => {
      size += c.length;
      if (tooLarge) {
        /*
         * Already rejected. Draining lets the 413 reach the client (destroying
         * the socket here closed it first, so the client only saw a dropped
         * connection), but an unbounded drain means a chunked body can keep
         * streaming forever after the response. Give it a grace window, then
         * hang up. A fixed window rather than a multiple of the cap: the public
         * cap is 4 KB, and a client that is a little over deserves to read its
         * 413 rather than see the socket vanish.
         */
        if (size > max + 64 * 1024) req.destroy();
        return;
      }
      if (size > max) {
        tooLarge = true;
        chunks.length = 0; // stop holding what we read
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
