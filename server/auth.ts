// Multi-user accounts (scrypt) + opaque session tokens, each owned by a user.
// Adapted from LaunchCanvas's auth module - the crypto is identical, the
// storage is RSConclave's JSON store instead of SQLite so the app stays
// zero-dependency. The store holds only sha256(token); the cookie holds the
// raw token.
import crypto from 'node:crypto';
import { InputError } from './errors.ts';
import * as store from './store.ts';
import { closeUserStreams } from './sse.ts';

const SCRYPT = { N: 16384, r: 8, p: 1 };
const SESSION_TTL_S = 30 * 24 * 3600; // 30 days, sliding
const SESSION_REFRESH_S = 15 * 24 * 3600; // refresh when less than this remains
// Namespaced per app: cookies ignore ports, so RSConclave and the Canvas apps
// on the same host would clobber each other's sessions with a generic name.
const COOKIE_NAME = 'rsconclave_session';

export interface UserRecord {
  username: string;
  password: string; // scrypt$params$salt$hash
  createdAt: string;
}

interface SessionRecord {
  username: string;
  expiresTs: number;
}

// Async scrypt: the synchronous form serialises concurrent logins into one
// event-loop stall. The callback form runs on the threadpool instead.
const scryptAsync = (password: string, salt: Buffer, keylen: number, opts: object): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, 32, SCRYPT);
  return `scrypt$N=${SCRYPT.N},r=${SCRYPT.r},p=${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, params, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const opts: Record<string, number> = {};
    for (const kv of params.split(',')) {
      const [k, v] = kv.split('=');
      opts[k] = parseInt(v, 10);
    }
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, opts);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// --- users (multi-user, no roles: every account is equal) ---

/**
 * Stricter than LaunchCanvas's rule on one point: usernames become directory
 * names under data/users/, so a leading dot is rejected. LaunchCanvas keeps
 * names in SQLite where ".." is merely ugly; here it would be a path.
 */
export function validUsername(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/.test(name);
}

function loadUsers(): UserRecord[] {
  // Critical, not tolerant: a users.json that exists but cannot be parsed must
  // never read as "no accounts yet". See store.loadCritical.
  return store.loadCritical<UserRecord[]>('users', []);
}
function saveUsers(users: UserRecord[]): void {
  store.save('users', users);
}

export function anyUsers(): boolean {
  return loadUsers().length > 0;
}

/*
 * mustBeFirst closes the instance-claim race. /api/setup checked anyUsers()
 * before awaiting the request body and the password hash, and createUser only
 * ever re-checked for a duplicate NAME - so three concurrent setups all
 * succeeded, and an attacker who opened a setup request with a slowly dribbled
 * body could complete it after the real owner had claimed the instance and get
 * a valid session on a claimed box. The check belongs here, inside the same
 * synchronous read-modify-write as the save.
 */
export async function createUser(
  username: string,
  password: string,
  opts?: { mustBeFirst?: boolean },
): Promise<string> {
  const name = String(username || '').trim();
  if (!validUsername(name)) {
    throw new InputError('Username: 2-32 characters, starts with a letter or digit, then letters/digits/dot/dash/underscore.');
  }
  if (loadUsers().some((u) => u.username.toLowerCase() === name.toLowerCase())) {
    throw new InputError('That username already exists.', 409);
  }
  // Hash first, then re-read. Hashing awaits, and the read-modify-write either
  // side of that await is not atomic: two accounts created in the same instant
  // both loaded the pre-existing list and the second save dropped the first.
  const password_ = await hashPassword(password);
  const users = loadUsers();
  if (opts?.mustBeFirst && users.length > 0) {
    throw new InputError('This instance has already been claimed - sign in instead.', 409);
  }
  if (users.some((u) => u.username.toLowerCase() === name.toLowerCase())) {
    throw new InputError('That username already exists.', 409);
  }
  users.push({ username: name, password: password_, createdAt: new Date().toISOString() });
  saveUsers(users);
  return name;
}

export function listUsers(): Array<{ username: string; createdAt: string }> {
  return loadUsers().map(({ username, createdAt }) => ({ username, createdAt }));
}

export function deleteUser(username: string): void {
  const users = loadUsers();
  if (!users.some((u) => u.username === username)) throw new InputError('No such user.', 404);
  if (users.length <= 1) throw new InputError('Cannot delete the last user.');
  saveUsers(users.filter((u) => u.username !== username));
  destroyUserSessions(username, null);
  // Transcripts are kept deliberately - deleting an account should not silently
  // destroy someone's writing - but they are moved aside rather than left in
  // place. Left in place, recreating the same username handed the new person
  // the old one's entire history, which is a different thing from "kept".
  store.archiveUserDir(username);
}

export async function setUserPassword(username: string, password: string): Promise<void> {
  const hash = await hashPassword(password); // await first, then read-modify-write
  const users = loadUsers();
  const u = users.find((x) => x.username === username);
  if (!u) throw new InputError('No such user.', 404);
  u.password = hash;
  saveUsers(users);
}

// Returns the canonical username on success (the row's casing, not the
// attempt's), null on failure. Verifies against a dummy hash when the user
// does not exist so timing does not reveal which usernames are real.
let dummyHashP: Promise<string> | null = null;
const dummyHash = () => (dummyHashP ??= hashPassword('no-such-user-timing-pad'));
/*
 * Warm it at import. Lazily initialised, the FIRST unknown-user login of each
 * process paid two scrypt runs instead of one - a measurable "this username
 * does not exist" right after every restart, which is exactly what the pad
 * exists to hide.
 */
void dummyHash();
export async function checkLogin(username: string, password: string): Promise<string | null> {
  const attempt = String(username || '').trim().toLowerCase();
  const row = loadUsers().find((u) => u.username.toLowerCase() === attempt);
  const ok = await verifyPassword(String(password || ''), row ? row.password : await dummyHash());
  return row && ok ? row.username : null;
}

// Seed from env on first boot so a compose file can pre-set the first
// account. Recovery when every password is lost: delete data/users.json and
// data/authsessions.json - transcripts and settings survive, only accounts go.
export async function seedFromEnv(): Promise<void> {
  if (!anyUsers() && process.env.ADMIN_PASSWORD) {
    if (process.env.ADMIN_PASSWORD.length < 8) {
      console.warn('[auth] ADMIN_PASSWORD is shorter than the 8-character minimum the UI enforces - consider a longer one');
    }
    const name = await createUser('admin', process.env.ADMIN_PASSWORD);
    store.migrateLegacyData(name);
  }
}

// --- sessions (each owned by a user) ---
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function loadSessions(): Record<string, SessionRecord> {
  return store.load<Record<string, SessionRecord>>('authsessions', {});
}
function saveSessions(sessions: Record<string, SessionRecord>): void {
  store.save('authsessions', sessions);
}

export function createSession(username: string): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const sessions = loadSessions();
  const now = Math.floor(Date.now() / 1000);
  // Opportunistic prune keeps the file from accumulating expired rows; there
  // is no cron here to do it on a schedule.
  for (const [k, v] of Object.entries(sessions)) if (v.expiresTs <= now) delete sessions[k];
  sessions[sha256(token)] = { username, expiresTs: now + SESSION_TTL_S };
  saveSessions(sessions);
  return token;
}

/** Returns the owning username (truthy) or null. Sliding expiry. */
export function validateSession(token: string | null): string | null {
  if (!token) return null;
  const sessions = loadSessions();
  const key = sha256(token);
  const row = sessions[key];
  const now = Math.floor(Date.now() / 1000);
  if (!row || row.expiresTs <= now) return null;
  if (row.expiresTs - now < SESSION_REFRESH_S) {
    row.expiresTs = now + SESSION_TTL_S;
    saveSessions(sessions);
  }
  return row.username;
}

export function destroySession(token: string | null): void {
  if (!token) return;
  const sessions = loadSessions();
  const key = sha256(token);
  const row = sessions[key];
  // `delete` returns true for a key that was never there, so every bogus-token
  // logout used to rewrite authsessions.json - unauthenticated write
  // amplification. Only a row that existed is worth a write.
  if (row) {
    delete sessions[key];
    saveSessions(sessions);
  }
  // An SSE stream is authenticated only when it opens, so it would keep
  // streaming after the cookie behind it stopped being valid.
  if (row) closeUserStreams(row.username);
}

// After a password change: that user's every session except the one making
// the change. (Resetting ANOTHER user's password passes exceptToken = null.)
export function destroyUserSessions(username: string, exceptToken: string | null): void {
  const sessions = loadSessions();
  const keep = exceptToken ? sha256(exceptToken) : null;
  let changed = false;
  for (const [k, v] of Object.entries(sessions)) {
    if (v.username === username && k !== keep) {
      delete sessions[k];
      changed = true;
    }
  }
  if (changed) saveSessions(sessions);
  if (changed) closeUserStreams(username);
}

// --- cookies ---
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      // A malformed value (Cookie: x=%) makes decodeURIComponent throw; skip
      // the pair rather than let it take down the request.
      try {
        out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
      } catch {}
    }
  }
  return out;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_S}${secure ? '; Secure' : ''}`;
}
export function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
export function tokenFromRequest(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  return parseCookies(req.headers.cookie as string | undefined)[COOKIE_NAME] || null;
}

// --- login rate limiting (in-memory, per source IP) ---
const failures = new Map<string, { count: number; lockedUntil: number }>();
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60 * 1000;

const MAX_TRACKED_IPS = 10_000;

/*
 * Keyed by client IP, so the map is attacker-growable. Expired entries go
 * first; if every entry is still an active lock we drop the oldest anyway,
 * because a sweep that can free nothing is not a bound. Oldest are also the
 * closest to expiring, so it costs an attacker very little time.
 */
function sweepFailures(now: number): void {
  if (failures.size < MAX_TRACKED_IPS) return;
  for (const [k, v] of failures) {
    if (!v.lockedUntil || v.lockedUntil <= now) failures.delete(k);
  }
  if (failures.size >= MAX_TRACKED_IPS) {
    let drop = failures.size - Math.floor(MAX_TRACKED_IPS / 2);
    for (const k of failures.keys()) {
      if (drop-- <= 0) break;
      failures.delete(k);
    }
  }
}

/*
 * Count the attempt BEFORE doing any of the work, and report whether it is
 * allowed.
 *
 * The old split - check `loginAllowed`, then increment only after `await
 * readJsonBody` and the awaited scrypt - limited sequential attackers and
 * nobody else. Sixty concurrent POSTs all passed the check before the first
 * failure was recorded, so sixty passwords were tried for zero 429s and the
 * guess rate scaled with the attacker's socket count. Reproduced by the review.
 *
 * Counting up front is what closes it: Node runs these increments to
 * completion one after another, so the sixth concurrent request sees the count
 * the first five already left behind. A correct password clears the counter
 * (recordLoginSuccess), so a person who signs in successfully is unaffected.
 */
export function noteLoginAttempt(ip: string): boolean {
  const now = Date.now();
  sweepFailures(now);
  const existing = failures.get(ip);
  if (existing?.lockedUntil) {
    if (existing.lockedUntil > now) return false;
    failures.delete(ip);
  }
  const f = failures.get(ip) ?? { count: 0, lockedUntil: 0 };
  f.count++;
  if (f.count >= MAX_FAILURES) {
    f.count = 0;
    f.lockedUntil = now + LOCKOUT_MS;
  }
  failures.set(ip, f);
  return true;
}
export function recordLoginSuccess(ip: string): void {
  failures.delete(ip);
}
