// RSConclave server entry point. Run: node server/main.ts   (or node --watch during dev)
import http from 'node:http';
import { requireText, InputError } from './errors.ts';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BIG_BODY, dispatch, readJsonBody, route, sendJson, HttpError, SMALL_BODY } from './router.ts';
import { serveStatic } from './static.ts';
import { handleSse, onConnectSnapshot } from './sse.ts';
import { clearModelInfoCache, discoverModels, getModelInfo } from './providers.ts';
import * as store from './store.ts';
import * as engine from './engine.ts';
import * as rt from './roundtable.ts';
import * as chat from './chat.ts';
import * as auth from './auth.ts';
import { sessionToMarkdown } from './exportMd.ts';
import { searchSessions } from './search.ts';
import type { AppConfig, Persona, Presets, Session } from './types.ts';
import {
  DEFAULT_COMPACT_TEMPLATE,
  DEFAULT_CONSOLIDATOR_TEMPLATE,
  DEFAULT_DISTIL_TEMPLATE,
  DEFAULT_JUDGE_TEMPLATE,
  DEFAULT_PERSONAS,
  DEFAULT_SUMMARIZE_TEMPLATE,
} from './types.ts';

const PORT = Number(process.env.PORT ?? 7777);
// Localhost by default. Set HOST=0.0.0.0 to reach it from other machines.
const HOST = process.env.HOST ?? '127.0.0.1';

// HTTPS is automatic when a cert/key pair exists: either at the paths in
// TLS_CERT/TLS_KEY, or dropped into <data>/certs/ (tools/gen-cert.sh writes a
// self-signed pair there). No cert means plain HTTP. One listener either way -
// there is no second port and no flag to set.
const CERT_PATH = process.env.TLS_CERT ?? path.join(store.DATA_DIR, 'certs', 'server.crt');
const KEY_PATH = process.env.TLS_KEY ?? path.join(store.DATA_DIR, 'certs', 'server.key');
let tlsOptions: { cert: Buffer; key: Buffer } | null = null;
if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
  try {
    tlsOptions = { cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) };
  } catch (err) {
    // Unreadable cert is usually file ownership: the container runs as uid
    // 1000. Stay up on HTTP rather than crashlooping on a bad permission.
    console.error(`TLS cert found but unreadable (${(err as Error).message}) - falling back to HTTP.`);
    console.error('Fix ownership: chown -R 1000:1000 certs');
    tlsOptions = null;
  }
}

const defaultPresets: Presets = {
  consolidatorTemplate: DEFAULT_CONSOLIDATOR_TEMPLATE,
  judgeTemplate: DEFAULT_JUDGE_TEMPLATE,
  summarizeTemplate: DEFAULT_SUMMARIZE_TEMPLATE,
  distilTemplate: DEFAULT_DISTIL_TEMPLATE,
  compactTemplate: DEFAULT_COMPACT_TEMPLATE,
  pairings: [],
  councils: [],
  roundtables: [],
  pipelines: [],
};

/** The authenticated username, resolved once per request by the top handler. */
function userOf(req: IncomingMessage): string {
  const u = (req as any)._rsUser;
  if (!u) throw new HttpError(401, 'not signed in');
  return u;
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

// --- auth (public routes; gating for everything else lives in the top handler) ---

// Bare liveness for the container healthcheck: answers before login, says
// nothing but "the process serves requests". Pointing the healthcheck at an
// authenticated endpoint would restart a working container forever.
route('GET', '/api/health', (_req, res) => {
  sendJson(res, 200, { ok: true });
});

route('GET', '/api/session', (req, res) => {
  const user = auth.validateSession(auth.tokenFromRequest(req));
  sendJson(res, 200, { authenticated: !!user, user: user || null, needsSetup: !auth.anyUsers() });
});

route('POST', '/api/setup', async (req, res) => {
  if (auth.anyUsers()) throw new HttpError(409, 'already configured');
  const body = await readJsonBody(req, SMALL_BODY);
  if (!body.password || String(body.password).length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters.');
  }
  // mustBeFirst: the anyUsers() check above happens before two awaits, so it
  // cannot be the thing that decides. See createUser.
  const name = await auth.createUser(String(body.username || 'admin'), String(body.password), { mustBeFirst: true });
  // Whoever claims the instance owns whatever was in it before accounts
  // existed - sessions, personas, presets all move under this user.
  store.migrateLegacyData(name);
  res.setHeader('set-cookie', auth.sessionCookie(auth.createSession(name), tlsOptions !== null));
  sendJson(res, 200, { user: name });
});

route('POST', '/api/login', async (req, res) => {
  const ip = clientIp(req);
  // Counted before the body read and the scrypt, so concurrent attempts cannot
  // outrun the limit - see noteLoginAttempt.
  if (!auth.noteLoginAttempt(ip)) throw new HttpError(429, 'Too many attempts - wait a minute.');
  const body = await readJsonBody(req, SMALL_BODY);
  const name = await auth.checkLogin(body.username, body.password);
  if (!name) {
    throw new HttpError(401, 'Wrong username or password.');
  }
  auth.recordLoginSuccess(ip);
  res.setHeader('set-cookie', auth.sessionCookie(auth.createSession(name), tlsOptions !== null));
  sendJson(res, 200, { user: name });
});

route('POST', '/api/logout', (req, res) => {
  auth.destroySession(auth.tokenFromRequest(req));
  res.setHeader('set-cookie', auth.clearCookie());
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/password', async (req, res) => {
  const me = userOf(req);
  const body = await readJsonBody(req, SMALL_BODY); // credentials, and it runs scrypt
  if (!(await auth.checkLogin(me, String(body.current ?? '')))) {
    throw new HttpError(401, 'Current password is wrong.');
  }
  if (!body.next || String(body.next).length < 8) {
    throw new HttpError(400, 'New password must be at least 8 characters.');
  }
  await auth.setUserPassword(me, String(body.next));
  auth.destroyUserSessions(me, auth.tokenFromRequest(req));
  sendJson(res, 200, { ok: true });
});

// --- users (no roles: any signed-in account manages accounts; the guard
// rails are "no deleting the last user" and "no deleting yourself") ---
route('GET', '/api/users', (req, res) => {
  userOf(req);
  sendJson(res, 200, auth.listUsers());
});
route('POST', '/api/users', async (req, res) => {
  userOf(req);
  const body = await readJsonBody(req, SMALL_BODY); // credentials, and it runs scrypt
  if (!body.password || String(body.password).length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters.');
  }
  const name = await auth.createUser(String(body.username ?? ''), String(body.password));
  sendJson(res, 200, { user: name });
});
route('DELETE', '/api/users/:name', (req, res, params) => {
  const me = userOf(req);
  if (params.name === me) throw new HttpError(400, 'You cannot delete your own account.');
  // Order matters: end their run BEFORE archiving their data. A live run holds
  // the session in memory and its next persist would recreate the directory
  // that was just archived, so a recreated username would inherit the
  // transcripts. It also frees the box, which nobody else could do - stop and
  // cancel both require being the run's owner, and that account is gone.
  engine.evictUser(params.name);
  auth.deleteUser(params.name);
  sendJson(res, 200, { ok: true });
});

// --- config (endpoints are shared infrastructure: one box, one registry) ---
route('GET', '/api/config', (req, res) => {
  userOf(req);
  sendJson(res, 200, store.load<AppConfig>('config', { endpoints: [] }));
});
/*
 * Endpoints are shared, and any signed-in account can rewrite them: there are
 * no roles here by design. Worth being clear-eyed about what that means on a
 * shared instance - whoever edits this list chooses where everyone else's
 * prompts get sent. That is a trust assumption, not a bug, but it is the reason
 * the README says "a household or a few friends" rather than "untrusted users".
 *
 * The validation below is not a security boundary either. It exists so a
 * malformed save cannot wedge the app for everyone, and so the URL that the
 * server will later fetch is at least a URL.
 */
route('PUT', '/api/config', async (req, res) => {
  userOf(req);
  const body = await readJsonBody(req);
  if (!Array.isArray(body.endpoints)) throw new HttpError(400, 'endpoints must be an array');
  if (body.endpoints.length > 50) throw new HttpError(400, 'too many endpoints');
  const endpoints = body.endpoints.map((raw: any, i: number) => {
    const id = String(raw?.id ?? '').trim();
    const name = String(raw?.name ?? '').trim();
    const baseUrl = String(raw?.baseUrl ?? '').trim();
    // Only the two EndpointKind values. The UI labels the second one
    // "openai-compat" but sends 'openai'; anything unrecognised falls back to
    // ollama rather than being stored as an off-type string.
    const kind = raw?.kind === 'openai' ? 'openai' : 'ollama';
    if (!id || !name || !baseUrl) throw new HttpError(400, `endpoint ${i + 1} needs id, name and baseUrl`);
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new HttpError(400, `endpoint "${name}" has a malformed base URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new HttpError(400, `endpoint "${name}" must be http or https`);
    }
    const out: Record<string, unknown> = { id, name, baseUrl, kind };
    if (raw?.defaultKeepAlive !== undefined) out.defaultKeepAlive = String(raw.defaultKeepAlive);
    if (raw?.aliases && typeof raw.aliases === 'object') {
      const aliases: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.aliases as Record<string, unknown>)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        aliases[String(k).slice(0, 200)] = String(v).slice(0, 200);
      }
      out.aliases = aliases;
    }
    return out;
  });
  store.save('config', { endpoints });
  /*
   * Saving endpoints is the move people make right after changing something
   * about a model - including re-adding an endpoint specifically to force a
   * re-read. Make that instinct correct instead of a five-minute wait.
   */
  clearModelInfoCache();
  sendJson(res, 200, { ok: true });
});

// --- personas / presets (per-user: these are someone's writing) ---
route('GET', '/api/personas', (req, res) => {
  // Fallback, not a seed-on-create: an account that has never saved gets the
  // examples, and one that saved an empty list stays empty.
  sendJson(res, 200, store.loadUser<Persona[]>(userOf(req), 'personas', DEFAULT_PERSONAS));
});
route('PUT', '/api/personas', async (req, res) => {
  const me = userOf(req);
  const body = await readJsonBody(req);
  if (!Array.isArray(body)) throw new HttpError(400, 'expected an array of personas');
  /*
   * Memories are the one part of a persona the editor did not type, so a
   * client that does not know about them must not be able to wipe them by
   * saving the fields it does know. A persona sent WITHOUT a memories key
   * keeps the memories it has; one sent with memories: [] is cleared. The
   * distinction is absent versus empty, and it is the whole contract.
   */
  const current = store.loadUser<Persona[]>(me, 'personas', DEFAULT_PERSONAS);
  const merged = body.map((p: any) => {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string') throw new HttpError(400, 'each persona needs an id');
    if (p.memories === undefined) {
      const was = current.find((c) => c.id === p.id);
      return was?.memories?.length ? { ...p, memories: was.memories } : p;
    }
    if (!Array.isArray(p.memories)) throw new HttpError(400, 'memories must be an array');
    return p;
  });
  store.saveUser(me, 'personas', merged);
  sendJson(res, 200, { ok: true });
});
/*
 * Memory is written by a model and attached by a person, in that order and
 * never the other way round. The entry named here must be a consolidation -
 * see engine.saveMemory.
 */
route('POST', '/api/personas/:id/memories', async (req, res, params) => {
  const { sessionId, entryId, replace, force } = await readJsonBody(req);
  const persona = engine.saveMemory(
    userOf(req),
    params.id,
    requireText(sessionId, 'sessionId'),
    requireText(entryId, 'entryId'),
    Boolean(replace),
    Boolean(force),
  );
  sendJson(res, 200, persona);
});
// Rewrite the whole memory list as one entry. Returns the session it runs in;
// the result is reviewed there and saved with replace, or not at all.
route('POST', '/api/personas/:id/compact', async (req, res, params) => {
  const { endpointId, model, template, params: gen } = await readJsonBody(req);
  if (!endpointId || !model) throw new HttpError(400, 'endpointId and model required');
  const sessionId = engine.compactMemory(
    userOf(req),
    params.id,
    { endpointId, model, params: gen },
    String(template ?? DEFAULT_COMPACT_TEMPLATE),
  );
  sendJson(res, 200, { sessionId });
});

route('GET', '/api/presets', (req, res) => {
  // Defaults underneath the saved file, not only in its absence: an account
  // that saved presets before a template existed would otherwise get no
  // template at all for it, and the client's fallback is a bare placeholder.
  sendJson(res, 200, { ...defaultPresets, ...store.loadUser<Presets>(userOf(req), 'presets', defaultPresets) });
});
route('PUT', '/api/presets', async (req, res) => {
  const me = userOf(req);
  const body = await readJsonBody(req);
  // Personas already validated their shape; presets did not, so PUT null was
  // stored happily and then broke that account's preset UI on every load.
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'expected an object of preset lists');
  }
  store.saveUser(me, 'presets', body);
  sendJson(res, 200, { ok: true });
});

// --- what's loaded on the box(es) ---
route('GET', '/api/ps', async (req, res) => {
  userOf(req);
  const config = store.load<AppConfig>('config', { endpoints: [] });
  const out: Array<{ id: string; name: string; models?: Array<{ name: string; vramGb: number }>; error?: string }> = [];
  for (const ep of config.endpoints) {
    if (ep.kind !== 'ollama') continue;
    try {
      const r = await fetch(`${ep.baseUrl.replace(/\/+$/, '')}/api/ps`, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data: any = await r.json();
      out.push({
        id: ep.id,
        name: ep.name,
        models: (data.models ?? []).map((m: any) => ({
          name: String(m.name),
          vramGb: Math.round(((m.size_vram ?? m.size ?? 0) / 1e9) * 10) / 10,
        })),
      });
    } catch {
      out.push({ id: ep.id, name: ep.name, error: 'unreachable' });
    }
  }
  sendJson(res, 200, { endpoints: out });
});

// --- per-model context info (trained max + configured num_ctx), batch per endpoint ---
route('GET', '/api/model-info', async (req, res, _params, query) => {
  userOf(req);
  const id = query.get('endpointId');
  const config = store.load<AppConfig>('config', { endpoints: [] });
  const ep = config.endpoints.find((e) => e.id === id);
  if (!ep) throw new HttpError(404, 'unknown endpoint');
  if (ep.kind !== 'ollama') {
    sendJson(res, 200, { info: {} }); // openai-compat exposes no context metadata
    return;
  }
  let models: string[] = [];
  try {
    models = await discoverModels(ep);
  } catch (err: any) {
    sendJson(res, 502, { error: err?.message ?? String(err) });
    return;
  }
  const entries = await Promise.all(
    models.map(async (m) => [m, await getModelInfo(ep, m)] as const),
  );
  const info: Record<string, unknown> = {};
  for (const [m, i] of entries) if (i) info[m] = i;
  sendJson(res, 200, { info });
});

// --- model discovery ---
route('GET', '/api/models', async (req, res, _params, query) => {
  userOf(req);
  const id = query.get('endpointId');
  const config = store.load<AppConfig>('config', { endpoints: [] });
  const ep = config.endpoints.find((e) => e.id === id);
  if (!ep) throw new HttpError(404, 'unknown endpoint');
  try {
    sendJson(res, 200, { models: await discoverModels(ep) });
  } catch (err: any) {
    sendJson(res, 502, { error: err?.message ?? String(err) });
  }
});

// --- search (the caller's own sessions only, like everything else) ---
route('GET', '/api/search', (req, res, _params, query) => {
  const q = String(query.get('q') ?? '').slice(0, 200);
  sendJson(res, 200, { results: searchSessions(store.listSessions<Session>(userOf(req)), q) });
});

// --- sessions (always the caller's own; there is no cross-user read) ---
route('GET', '/api/sessions', (req, res) => {
  const me = userOf(req);
  /*
   * At most one session can be live, and the engine is the only thing that
   * knows which. 'active' is written to disk and only cleared when another
   * session displaces it, so a process that exits mid-run leaves that claim
   * behind forever - after a restart the sidebar showed a session as active
   * with nothing running at all. Correct it in the projection rather than on
   * disk: the stored status is what lets a roundtable resume where it was.
   */
  const liveId = engine.getActiveSession(me)?.id;
  const sessions = store
    .listSessions<Session>(me)
    // tags are part of the projection because the sidebar both shows and filters
    // on them; the list is the only call it makes.
    .map((s) => ({
      id: s.id, title: s.title, mode: s.mode,
      createdAt: s.createdAt, updatedAt: s.updatedAt, tags: s.tags,
      status: s.status === 'active' && s.id !== liveId ? 'paused' : s.status,
      /*
       * Which persona, if this session wears one, so the sidebar can mark a
       * conversation that feeds a long-term memory. Those deserve more care
       * than an ordinary chat - what happens in them outlives them - and the
       * list was the one place that gave no hint before you opened it.
       */
      personaId: (s.config as { personaId?: string })?.personaId,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  sendJson(res, 200, sessions);
});
route('GET', '/api/sessions/:id', (req, res, params) => {
  const me = userOf(req);
  const activeSession = engine.getActiveSession(me);
  const s = activeSession?.id === params.id ? activeSession : store.loadSession<Session>(me, params.id);
  if (!s) throw new HttpError(404, 'session not found');
  sendJson(res, 200, s);
});
/*
 * Delete many at once. Testing an app like this produces dozens of throwaway
 * sessions an afternoon, and clearing them one confirm at a time is its own
 * chore.
 *
 * POST rather than DELETE because it carries a body, and a whole route rather
 * than a loop of single deletes so a hundred sessions is one request. The live
 * run is SKIPPED rather than failing the batch: "clear everything" should not
 * refuse wholesale because one session happens to be running.
 */
route('POST', '/api/sessions/delete', async (req, res) => {
  const me = userOf(req);
  const { ids } = await readJsonBody(req, SMALL_BODY);
  if (!Array.isArray(ids)) throw new HttpError(400, 'ids must be an array');
  if (ids.length > 1000) throw new HttpError(400, 'too many sessions in one request');
  let deleted = 0;
  let skipped = 0;
  for (const raw of ids) {
    const id = String(raw);
    // Only a session mid-generation is skipped; holding the idle active slot
    // is not a reason to survive a bulk delete.
    if (!engine.releaseForDelete(me, id)) { skipped++; continue; }
    store.deleteSession(me, id);
    deleted++;
  }
  sendJson(res, 200, { deleted, skipped });
});
route('DELETE', '/api/sessions/:id', (req, res, params) => {
  const me = userOf(req);
  if (!engine.releaseForDelete(me, params.id)) {
    throw new HttpError(409, 'that session is generating right now - stop it first');
  }
  store.deleteSession(me, params.id);
  sendJson(res, 200, { ok: true });
});
route('GET', '/api/sessions/:id/export.md', (req, res, params) => {
  const me = userOf(req);
  const s = store.loadSession<Session>(me, params.id);
  if (!s) throw new HttpError(404, 'session not found');
  // Personas ride along so a chat export can carry its full system prompt,
  // memory layer included - the transcript alone shows a model that knows
  // things with no trace of how it knew them.
  const md = sessionToMarkdown(s, store.loadUser<Persona[]>(me, 'personas', DEFAULT_PERSONAS));
  res.writeHead(200, {
    'content-type': 'text/markdown; charset=utf-8',
    'content-disposition': `attachment; filename="${s.id}.md"`,
  });
  res.end(md);
});
route('POST', '/api/sessions/:id/fork', async (req, res, params) => {
  const { entryId } = await readJsonBody(req);
  if (!entryId) throw new HttpError(400, 'entryId required');
  const s = engine.forkSession(userOf(req), params.id, String(entryId));
  sendJson(res, 200, { sessionId: s.id });
});

/*
 * Import a session someone exported (or hand-wrote). This is the one route that
 * turns arbitrary uploaded JSON into a stored session, so nothing is trusted:
 * a fresh id is minted rather than honoured, every field is coerced, the
 * transcript is bounded, and the status is forced to 'paused' so an import can
 * never claim to be a live run. The config is carried through as-is because it
 * is mode-specific, but a seat pointing at an endpoint this instance has never
 * heard of resolves through the same fallback as any stale session.
 */
route('POST', '/api/sessions/import', async (req, res) => {
  const me = userOf(req);
  // The one route whose payload is legitimately a large document.
  const raw = await readJsonBody(req, BIG_BODY);
  const modes = ['council', 'roundtable', 'pipeline', 'chat'];
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'expected a session object');
  if (!modes.includes(raw.mode)) throw new HttpError(400, 'unrecognised session mode');
  if (!raw.config || typeof raw.config !== 'object') throw new HttpError(400, 'session has no config');
  if (!Array.isArray(raw.entries)) throw new HttpError(400, 'session has no entries array');
  if (raw.entries.length > 5000) throw new HttpError(400, 'session has too many entries');

  const kinds = ['user', 'participant', 'narrator', 'consolidation', 'error'];
  const now = new Date().toISOString();
  const session: Session = {
    id: store.newId(),
    mode: raw.mode,
    title: (String(raw.title ?? '').trim() || 'Imported session').slice(0, 200),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: now,
    config: raw.config,
    status: 'paused',
    tags: Array.isArray(raw.tags)
      ? raw.tags.slice(0, 12).map((t: unknown) => String(t).trim().slice(0, 24)).filter(Boolean)
      : undefined,
    entries: raw.entries.map((e: any) => ({
      id: store.newId(),
      ts: typeof e?.ts === 'string' ? e.ts : now,
      kind: kinds.includes(e?.kind) ? e.kind : 'participant',
      speaker: String(e?.speaker ?? 'unknown').slice(0, 120),
      participantId: e?.participantId ? String(e.participantId).slice(0, 120) : undefined,
      model: e?.model ? String(e.model).slice(0, 200) : undefined,
      memberIndex: Number.isInteger(e?.memberIndex) ? e.memberIndex : undefined,
      text: String(e?.text ?? ''),
      error: e?.error ? String(e.error).slice(0, 500) : undefined,
    })),
  };
  store.saveSession(me, session);
  sendJson(res, 200, { sessionId: session.id, title: session.title, entries: session.entries.length });
});

route('POST', '/api/sessions/:id/resume', (req, res, params) => {
  const s = engine.resumeSession(userOf(req), params.id);
  sendJson(res, 200, { sessionId: s.id });
});
/** Rename and/or re-tag. Both optional, but sending neither is a no-op worth rejecting. */
route('PATCH', '/api/sessions/:id', async (req, res, params) => {
  const me = userOf(req);
  const { title, tags } = await readJsonBody(req);

  if (Array.isArray(tags)) {
    // Deduplicated case-insensitively but stored with the casing you typed;
    // bounded because these render on every row of the session list.
    const seen = new Set<string>();
    const clean: string[] = [];
    for (const raw of tags.slice(0, 12)) {
      const t = String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
      if (!t || seen.has(t.toLowerCase())) continue;
      seen.add(t.toLowerCase());
      clean.push(t);
    }
    engine.setTags(me, params.id, clean);
    if (title === undefined) {
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  // Coerce before trimming: a non-string title made .trim() throw, which came
  // back as a 500 instead of a 400. Capped because nothing downstream bounds it
  // and the sidebar renders it on every session list.
  const clean = String(title ?? '').trim().slice(0, 200);
  if (!clean) throw new HttpError(400, 'title required');
  const activeSession = engine.getActiveSession(me);
  if (activeSession?.id === params.id) {
    activeSession.title = clean;
    store.saveSession(me, activeSession);
  } else {
    const s = store.loadSession<Session>(me, params.id);
    if (!s) throw new HttpError(404, 'session not found');
    s.title = clean;
    store.saveSession(me, s);
  }
  sendJson(res, 200, { ok: true });
});

/**
 * A non-negative integer from request input. Number('abc') is NaN, which then
 * compared false against every bound and reached the engine as a stage index.
 */
function requireIndex(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InputError(`${label} must be a non-negative whole number`);
  return n;
}

// --- council ---
route('POST', '/api/council/start', async (req, res) => {
  const config = await readJsonBody(req);
  sendJson(res, 200, { sessionId: engine.startCouncil(userOf(req), config) });
});
route('POST', '/api/council/rerun-member', async (req, res) => {
  const { sessionId, memberIndex } = await readJsonBody(req);
  engine.rerunMember(userOf(req), sessionId, requireIndex(memberIndex, 'memberIndex'));
  sendJson(res, 200, { ok: true });
});
route('POST', '/api/council/consolidate', async (req, res) => {
  const { sessionId, template, endpointId, model, params } = await readJsonBody(req);
  const member = endpointId && model ? { endpointId, model, params } : undefined;
  engine.consolidate(userOf(req), sessionId, template, member);
  sendJson(res, 200, { ok: true });
});
route('POST', '/api/council/followup', async (req, res) => {
  const { sessionId, prompt } = await readJsonBody(req);
  engine.councilFollowup(userOf(req), sessionId, requireText(prompt, 'follow-up prompt'));
  sendJson(res, 200, { ok: true });
});

// --- roundtable ---
route('POST', '/api/roundtable/start', async (req, res) => {
  const config = await readJsonBody(req);
  sendJson(res, 200, { sessionId: engine.startRoundtable(userOf(req), config) });
});
/*
 * What each seat will actually be told, for the setup form to show.
 *
 * Deliberately computed by the SAME function the engine calls rather than
 * mirrored in the frontend: a disclosure that drifts from reality is worse
 * than no disclosure at all, because it is believed. The cost is one round
 * trip when someone opens the panel.
 *
 * Read-only - it runs no model, starts no run, and writes nothing.
 */
route('POST', '/api/roundtable/system-prompts', async (req, res) => {
  const config = await readJsonBody(req);
  const personas = store.loadUser<Persona[]>(userOf(req), 'personas', DEFAULT_PERSONAS);
  const participants = Array.isArray(config?.participants) ? config.participants : [];
  sendJson(res, 200, {
    prompts: participants
      // A human seat is a person typing; nothing is sent on their behalf.
      .filter((p: any) => p?.kind !== 'human')
      .map((p: any) => ({
        id: p.id,
        name: p.name,
        prompt: rt.buildSystemPrompt(p, config, personas),
      })),
  });
});
route('POST', '/api/roundtable/step', async (req, res) => {
  const { nextParticipantId, auto } = await readJsonBody(req);
  engine.step(userOf(req), nextParticipantId, auto ? Number(auto) : 0);
  sendJson(res, 200, { ok: true });
});
route('POST', '/api/roundtable/inject', async (req, res) => {
  const { text, as } = await readJsonBody(req);
  // requireText, not `text?.trim()`: optional chaining passes a JSON number
  // straight through to .trim and the TypeError surfaced as a 500.
  engine.inject(userOf(req), requireText(text, 'text'), as === 'user' ? 'user' : 'narrator');
  sendJson(res, 200, { ok: true });
});
route('POST', '/api/roundtable/human-turn', async (req, res) => {
  const { participantId, text } = await readJsonBody(req);
  engine.humanTurn(userOf(req), String(participantId ?? ''), requireText(text, 'text'));
  sendJson(res, 200, { ok: true });
});
route('POST', '/api/roundtable/consolidate', async (req, res) => {
  const { sessionId, endpointId, model, template, params } = await readJsonBody(req);
  if (!endpointId || !model) throw new HttpError(400, 'endpointId and model required');
  engine.consolidateTranscript(userOf(req), sessionId, { endpointId, model, params }, String(template ?? '{{TRANSCRIPT}}'));
  sendJson(res, 200, { ok: true });
});
route('POST', '/api/roundtable/reroll', (req, res) => {
  // `restored` carries a human seat's text back so the client can refill the
  // speak box rather than let the reroll destroy it.
  sendJson(res, 200, { ok: true, ...engine.rerollLast(userOf(req)) });
});
route('POST', '/api/roundtable/pause', (req, res) => {
  engine.pause(userOf(req));
  sendJson(res, 200, { ok: true });
});
route('POST', '/api/roundtable/stop', (req, res) => {
  engine.stopRun(userOf(req));
  sendJson(res, 200, { ok: true });
});

// --- chat ---
route('POST', '/api/chat/start', async (req, res) => {
  const config = await readJsonBody(req);
  sendJson(res, 200, { sessionId: engine.startChat(userOf(req), config) });
});
route('POST', '/api/chat/send', async (req, res) => {
  const { text } = await readJsonBody(req);
  engine.chatSend(userOf(req), requireText(text, 'message'));
  sendJson(res, 200, { ok: true });
});
route('POST', '/api/chat/continue', (req, res) => {
  engine.chatContinue(userOf(req));
  sendJson(res, 200, { ok: true });
});
route('POST', '/api/chat/regenerate', (req, res) => {
  engine.chatRegenerate(userOf(req));
  sendJson(res, 200, { ok: true });
});
// The roundtable judge, pointed at a chat. Its consolidation entry is what
// "Remember" turns into a persona memory.
route('POST', '/api/chat/summarize', async (req, res) => {
  const { sessionId, endpointId, model, template, params } = await readJsonBody(req);
  if (!endpointId || !model) throw new HttpError(400, 'endpointId and model required');
  engine.consolidateTranscript(userOf(req), sessionId, { endpointId, model, params }, String(template ?? DEFAULT_SUMMARIZE_TEMPLATE));
  sendJson(res, 200, { ok: true });
});
/*
 * The exact system prompt a chat config produces, for the brief to show.
 * Computed by the same function the engine calls, for the reason the
 * roundtable disclosure gives: a persona's memory is now a layer the client
 * does not build, and a disclosure that drifts from reality is believed.
 * Read-only.
 */
route('POST', '/api/chat/system-prompt', async (req, res) => {
  const config = await readJsonBody(req);
  const personas = store.loadUser<Persona[]>(userOf(req), 'personas', DEFAULT_PERSONAS);
  sendJson(res, 200, { prompt: chat.buildSystemPrompt(config ?? {}, personas) });
});

// --- pipeline ---
route('POST', '/api/pipeline/start', async (req, res) => {
  const config = await readJsonBody(req);
  sendJson(res, 200, { sessionId: engine.startPipeline(userOf(req), config) });
});
route('POST', '/api/pipeline/rerun', async (req, res) => {
  const { sessionId, stageIndex } = await readJsonBody(req);
  engine.rerunPipelineFrom(userOf(req), sessionId, requireIndex(stageIndex, 'stageIndex'));
  sendJson(res, 200, { ok: true });
});

// --- run control ---
/*
 * Stop whatever is running, whatever mode it is. engine.stopRun has always been
 * mode-agnostic but was only reachable at /api/roundtable/stop, so the UI had no
 * way to clear a stuck council or pipeline before starting something else - you
 * got "the box is busy" and no route out of it.
 */
route('POST', '/api/run/stop', (req, res) => {
  engine.stopRun(userOf(req));
  sendJson(res, 200, { ok: true });
});
route('POST', '/api/cancel', (req, res) => {
  engine.cancelGeneration(userOf(req));
  sendJson(res, 200, { ok: true });
});
// Abandon the member being generated and move to the next one. Council only -
// see engine.skipMember for why the other modes have nothing to skip to.
route('POST', '/api/council/skip', (req, res) => {
  engine.skipMember(userOf(req));
  sendJson(res, 200, { ok: true });
});
route('GET', '/api/state', (req, res) => {
  sendJson(res, 200, engine.getState(userOf(req)));
});

onConnectSnapshot((username) => ({
  state: engine.getState(username),
  session: engine.getActiveSession(username),
  user: username,
}));

/**
 * Is this request initiated by some other site?
 *
 * Auth cookies are SameSite=Lax, but this predates them and stays as a second
 * layer: a page you merely *visit* could POST here with enctype="text/plain"
 * (a CORS-"simple" request, no preflight). The attacker cannot read the
 * response (we emit no CORS headers), but could start runs or stop yours.
 */
function isCrossSite(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    try {
      if (new URL(origin).host !== req.headers.host) return true;
    } catch {
      return true;
    }
  }
  return false;
}

// Routes that answer without a session. Static files are also public: the
// login overlay is part of the SPA, and the HTML/CSS/JS contain nothing
// user-specific - every byte of user data is behind /api/* or /events.
const PUBLIC_API = new Set(['/api/health', '/api/session', '/api/login', '/api/setup', '/api/logout']);

const handler = async (req: IncomingMessage, res: ServerResponse) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;

  // Cheap headers that cost nothing here: no MIME sniffing (the mime map is
  // small and explicit), no referrer leaking a LAN hostname outward, no framing.
  // A Content-Security-Policy would be the real win for a page that renders
  // model output, but index.html still has one inline <script> - the pre-paint
  // theme applier - so a strict policy needs that moved to a file first.
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');

  if (isCrossSite(req)) {
    sendJson(res, 403, { error: 'cross-site requests are not accepted' });
    return;
  }

  if (path === '/events') {
    const user = auth.validateSession(auth.tokenFromRequest(req));
    if (!user) {
      sendJson(res, 401, { error: 'not signed in' });
      return;
    }
    return handleSse(req, res, user);
  }

  if (path.startsWith('/api/')) {
    // Requiring JSON on body-carrying methods forces a preflight we never answer.
    const m = req.method ?? 'GET';
    if ((m === 'POST' || m === 'PUT' || m === 'PATCH') &&
        !String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      sendJson(res, 415, { error: 'expected content-type: application/json' });
      return;
    }
    if (!PUBLIC_API.has(path)) {
      const token = auth.tokenFromRequest(req);
      const user = auth.validateSession(token);
      if (!user) {
        sendJson(res, 401, { error: 'not signed in' });
        return;
      }
      (req as any)._rsUser = user;
      /*
       * Re-issue the cookie on every authenticated request. The server slides a
       * session's expiry as it is used, but Max-Age was fixed at login - so
       * someone who used the app daily was still bounced to the login page on
       * day 30 while their session row was perfectly valid. Routes that set
       * their own cookie (login, logout) run after this and overwrite it.
       */
      if (token) res.setHeader('set-cookie', auth.sessionCookie(token, tlsOptions !== null));
    }
    if (await dispatch(req, res)) return;
    sendJson(res, 404, { error: 'no such endpoint' });
    return;
  }
  serveStatic(req, res);
};

/*
 * Backstop, not a strategy. Node's default for an unhandled rejection is to
 * exit, which on a shared box means one person's stale endpoint id ends
 * everyone else's session too. engine.launch() is where background runs are
 * supposed to catch their own failures; this exists so that the next thing
 * anyone forgets to wrap degrades to a log line instead of an outage.
 *
 * uncaughtException is deliberately NOT trapped: by then the process may hold
 * half-applied state, and staying up on a corrupt heap is worse than restarting.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection (staying up):', reason);
});

const server = tlsOptions ? https.createServer(tlsOptions, handler) : http.createServer(handler);

// Seed before listening so a request can never observe the unclaimed-setup
// state that ADMIN_PASSWORD exists to prevent.
auth.seedFromEnv().then(() => {
  server.listen(PORT, HOST, () => {
    const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
    const scheme = tlsOptions ? 'https' : 'http';
    console.log(`RSConclave running at ${scheme}://${shown}:${PORT}` +
      (tlsOptions ? ` (cert: ${CERT_PATH})` : ''));
    if (!auth.anyUsers()) {
      console.log('');
      console.log('  No accounts yet: the first visitor claims this instance on the setup');
      console.log('  page. Set ADMIN_PASSWORD in the environment to pre-claim it instead,');
      console.log('  especially when bound beyond localhost.');
      console.log('');
    }
  });
});
