// JSON persistence with atomic writes. Global state (endpoints, accounts)
// lives at data/ root; everything a person actually types - sessions,
// personas, presets - lives under data/users/<username>/ so histories never
// mix. Usernames are validated by auth.ts before they ever reach a path here,
// and belt-and-braces re-checked below.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = process.env.RSCONCLAVE_DATA ?? path.join(ROOT, 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');

fs.mkdirSync(USERS_DIR, { recursive: true });

/*
 * Write via a temp file and rename, with an fsync in between.
 *
 * Without the fsync the rename can land before the data does, so a power loss
 * leaves a present-but-empty file - which is precisely the state that used to
 * re-open first-run setup to the whole network and then overwrite the account
 * list. The temp name carries the pid and a counter because a fixed ".tmp"
 * means two processes sharing a data directory (a stray `npm start` beside the
 * container, or overlapping `node --watch` reloads) interleave onto the same
 * path and can rename each other's half-written file into place.
 */
let tmpCounter = 0;
function atomicWrite(file: string, obj: unknown): void {
  const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(obj, null, 2), 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows fails EPERM/EBUSY when anything (AV, a sync client, a backup
    // agent) holds the destination open. Retrying briefly beats losing the
    // write; a stale temp file is cleaned up either way.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') {
      try { fs.unlinkSync(tmp); } catch {}
      throw err;
    }
    let renamed = false;
    for (let i = 0; i < 20 && !renamed; i++) {
      try {
        fs.renameSync(tmp, file);
        renamed = true;
      } catch {
        // Busy-wait deliberately: this is a synchronous API used from request
        // handlers, so there is nowhere to await. 20 x ~5ms is the whole budget.
        const until = Date.now() + 5;
        while (Date.now() < until) { /* spin */ }
      }
    }
    if (!renamed) {
      try { fs.unlinkSync(tmp); } catch {}
      throw err;
    }
  }
}

// --- global scope: config.json, users.json, authsessions.json ---

export function load<T>(name: string, fallback: T): T {
  const file = path.join(DATA_DIR, name + '.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/*
 * load() for a file whose absence and whose corruption mean different things.
 *
 * The tolerant load() above swallows everything - corrupt JSON, EACCES, EBUSY,
 * a zero-length file - and hands back the fallback. For users.json that turned
 * a truncated file into "this instance has no accounts": /api/session reported
 * needsSetup, an unauthenticated stranger could claim it, and the save then
 * rewrote users.json with only their account. Confirmed end to end, and it does
 * not need an attacker - power loss and a backup client holding the file both
 * produce it, and the owner is locked out of their own transcripts.
 *
 * Missing is fine and returns the fallback. Present-but-unreadable throws, so
 * callers fail closed rather than concluding the file was empty.
 */
export function loadCritical<T>(name: string, fallback: T): T {
  const file = path.join(DATA_DIR, name + '.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw new Error(`cannot read ${name}.json (${(err as Error).message}) - refusing to treat it as empty`);
  }
  if (!raw.trim()) {
    throw new Error(`${name}.json exists but is empty - refusing to treat it as empty. ` +
      'Restore it from a backup, or delete it deliberately to start over.');
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${name}.json is not valid JSON (${(err as Error).message}) - refusing to treat it as empty`);
  }
}

export function save(name: string, obj: unknown): void {
  atomicWrite(path.join(DATA_DIR, name + '.json'), obj);
}

// --- per-user scope ---

function userDir(username: string): string {
  // auth.validUsername already forbids this shape; refuse rather than trust.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/.test(username)) throw new Error('bad username');
  const dir = path.join(USERS_DIR, username);
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  return dir;
}

export function loadUser<T>(username: string, name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(userDir(username), name + '.json'), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function saveUser(username: string, name: string, obj: unknown): void {
  atomicWrite(path.join(userDir(username), name + '.json'), obj);
}

// --- per-user sessions ---

function sessionFile(username: string, id: string): string {
  // ids are generated by us (newId), but never trust them in a path
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('bad session id');
  return path.join(userDir(username), 'sessions', id + '.json');
}

export function saveSession(username: string, session: { id: string }): void {
  atomicWrite(sessionFile(username, session.id), session);
}

export function loadSession<T>(username: string, id: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(username, id), 'utf8')) as T;
  } catch {
    return null;
  }
}

export function deleteSession(username: string, id: string): void {
  try {
    fs.unlinkSync(sessionFile(username, id));
  } catch {}
}

export function listSessions<T>(username: string): T[] {
  const out: T[] = [];
  const dir = path.join(userDir(username), 'sessions');
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as T);
    } catch {}
  }
  return out;
}

/**
 * Adopt pre-auth data into the first account. Before multi-user, personas,
 * presets and sessions lived at the data/ root; whoever claims the instance
 * on the setup page owns everything that was already in it. Move, not copy,
 * so the unscoped originals cannot linger as a second unprotected copy.
 */
export function migrateLegacyData(username: string): void {
  const dir = userDir(username);
  for (const name of ['personas.json', 'presets.json']) {
    const from = path.join(DATA_DIR, name);
    const to = path.join(dir, name);
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
  }
  const legacySessions = path.join(DATA_DIR, 'sessions');
  if (fs.existsSync(legacySessions)) {
    for (const f of fs.readdirSync(legacySessions)) {
      const to = path.join(dir, 'sessions', f);
      if (!fs.existsSync(to)) fs.renameSync(path.join(legacySessions, f), to);
    }
    try {
      fs.rmdirSync(legacySessions); // only removes if empty, which is the point
    } catch {}
  }
}

/**
 * Move a deleted account's data out of the way, keeping it but making it
 * unreachable. Deleting an account is not meant to destroy transcripts, but
 * leaving them at data/users/<name> meant recreating that username silently
 * adopted them - so the next person to be called "dave" inherited the previous
 * dave's history. Renamed with a timestamp; delete by hand when you mean it.
 */
export function archiveUserDir(username: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/.test(username)) throw new Error('bad username');
  const from = path.join(USERS_DIR, username);
  if (!fs.existsSync(from)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.renameSync(from, path.join(USERS_DIR, `${username}.deleted-${stamp}`));
  } catch (err) {
    console.error(`[store] could not archive data for ${username}: ${(err as Error).message}`);
  }
}

export function newId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${t}-${r}`;
}
