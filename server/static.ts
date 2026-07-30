// Static file serving from public/ with a small mime map and traversal protection.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

const PUBLIC_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  // Compare against PUBLIC_DIR + separator, not the bare prefix: a plain
  // startsWith would also accept a sibling directory whose name merely begins
  // with "public", so /../public-backup/secrets would have escaped the root.
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  res.end(data);
}
