// Run engine: owns the single active run, enforces one-generation-at-a-time,
// executes streaming turns, handles gating/auto-step/abort, persists sessions.
//
// One run at a time is a hardware truth (the box holds one model), not a
// per-user quota - so the run carries an OWNER. Only the owner sees its
// content or drives it; everyone else sees a bare "busy" flag. A non-owner
// can displace an idle run (it is persisted after every turn, the owner can
// resume), but never one that is mid-generation.
import type {
  AppConfig,
  ChatConfig,
  CouncilConfig,
  CouncilMember,
  Endpoint,
  Persona,
  PipelineConfig,
  RoundtableConfig,
  RunState,
  Session,
  TranscriptEntry,
} from './types.ts';
import { DEFAULT_PERSONAS } from './types.ts';
import { getModelInfo, streamChat } from './providers.ts';
import * as store from './store.ts';
import * as rt from './roundtable.ts';
import * as council from './council.ts';
import * as pipeline from './pipeline.ts';
import * as chat from './chat.ts';
import { renderTranscriptText } from './text.ts';
import { estimateMessages, OLLAMA_DEFAULT_NUM_CTX } from './tokens.ts';
import { broadcast } from './sse.ts';
import { InputError } from './errors.ts';

interface Active {
  owner: string;
  session: Session;
  abort: AbortController | null;
  autoRemaining: number;
  pauseRequested: boolean;
  phase: RunState['phase'];
  currentSpeaker?: string;
  waitingFirstToken: boolean;
  contextPct?: number;
  contextTokens?: number;
  contextWindow?: number;
  contextLocal?: boolean;
  // What this session's status was before it was reopened, so a re-run can put
  // it back. requireSession stamps 'active' on whatever it loads.
  resumedStatus?: Session['status'];
  lastError?: string;
}

let active: Active | null = null;

function getConfig(): AppConfig {
  return store.load<AppConfig>('config', { endpoints: [] });
}

function getPersonas(username: string): Persona[] {
  // Same fallback as the API route: a seat referencing a default persona
  // must resolve even if the user has never pressed Save on that page.
  return store.loadUser<Persona[]>(username, 'personas', DEFAULT_PERSONAS);
}

/*
 * Resolve a seat's endpoint, with fallbacks.
 *
 * A preset or a stored session holds an endpoint id, and that id stops
 * resolving the moment the endpoint is deleted or recreated in Settings - so
 * every saved council and roundtable pointing at it broke permanently, and
 * before launch() existed the throw took the server down with it. Falling back
 * to the session's recorded default, and then to the only endpoint when there
 * is just one, turns that into a session that keeps working.
 */
function endpointById(id: string, session?: Session): Endpoint {
  const eps = getConfig().endpoints;
  const exact = eps.find((e) => e.id === id);
  if (exact) return exact;
  const viaSession = session?.defaultEndpointId
    ? eps.find((e) => e.id === session.defaultEndpointId)
    : undefined;
  if (viaSession) return viaSession;
  if (eps.length === 1) return eps[0];
  // A configuration problem, not a fault of ours - so it reads as a 4xx when it
  // reaches a request directly rather than through a background run.
  throw new InputError(
    eps.length
      ? `endpoint "${id}" no longer exists - pick a current one in Settings`
      : 'no inference endpoints are configured - add one in Settings',
  );
}

/** First endpoint a config mentions, recorded so the session can fall back to it. */
function firstEndpointOf(config: unknown): string | undefined {
  const c = config as Record<string, any>;
  return (
    c?.endpointId ??
    c?.members?.[0]?.endpointId ??
    c?.participants?.find((p: any) => p?.endpointId)?.endpointId ??
    c?.stages?.[0]?.endpointId ??
    undefined
  );
}

export function getState(username: string): RunState {
  if (!active || active.owner !== username) {
    return {
      sessionId: null,
      phase: 'idle',
      boxBusy: active ? active.phase === 'generating' : undefined,
    };
  }
  const s: RunState = {
    sessionId: active.session.id,
    mode: active.session.mode,
    phase: active.phase,
    currentSpeaker: active.currentSpeaker,
    autoRemaining: active.autoRemaining || undefined,
    waitingFirstToken: active.waitingFirstToken || undefined,
    contextPct: active.contextPct,
    contextTokens: active.contextTokens,
    contextWindow: active.contextWindow,
    contextLocal: active.contextLocal,
    lastError: active.lastError,
  };
  if (active.session.mode === 'roundtable' && (active.phase === 'awaiting_gate' || active.phase === 'auto_stepping')) {
    const cfg = active.session.config as RoundtableConfig;
    const next = rt.nextSpeaker(cfg, active.session.entries);
    s.nextSpeaker = next.name;
    s.nextParticipantId = next.id;
  }
  return s;
}

export function getActiveSession(username: string): Session | null {
  return active && active.owner === username ? active.session : null;
}

function pushState(): void {
  if (active) broadcast('state', getState(active.owner), active.owner);
  // Everyone else only learns whether the box is occupied, never by what.
  broadcast('busy', { busy: !!active && active.phase === 'generating' });
}

/*
 * Write a specific run, not "whatever is active now". stopRun() clears `active`
 * the moment you press Stop, while the aborted turn is still unwinding - so an
 * active-guarded persist silently did nothing at exactly the moment there was
 * something to save. The partial text and the 'cancelled' marker were both
 * lost, leaving an empty bubble on disk that the live browser did not show.
 */
function persistOf(a: Active): void {
  // A run that already lost the active slot (Stop, then its aborted turn
  // unwinding) still writes through here to save partial output. Anything the
  // user changed ON DISK in that instant must survive: a rename or retag goes
  // straight to the file when the session is not live, and this stale
  // in-memory copy would silently revert it.
  if (active !== a) {
    const disk = store.loadSession<Session>(a.owner, a.session.id);
    if (!disk) {
      /*
       * The file is gone: this run was stopped and then the session deleted
       * before the aborted stream finished tearing down. Writing here recreated
       * the file and the session came back in the sidebar on the next refresh.
       * A run whose session no longer exists has nothing to save.
       */
      return;
    }
    a.session.title = disk.title;
    a.session.tags = disk.tags;
  }
  a.session.updatedAt = new Date().toISOString();
  store.saveSession(a.owner, a.session);
}

function persist(): void {
  if (active) persistOf(active);
}

function addEntry(partial: Omit<TranscriptEntry, 'id' | 'ts'>, a: Active = active!): TranscriptEntry {
  const entry: TranscriptEntry = { id: store.newId(), ts: new Date().toISOString(), ...partial };
  a.session.entries.push(entry);
  persistOf(a);
  broadcast('entry', entry, a.owner);
  return entry;
}

/*
 * Start a run in the background without letting a throw escape.
 *
 * Every run is launched fire-and-forget from a request handler, so anything
 * that escapes becomes an unhandled rejection - which Node turns into process
 * exit by default. That was not theoretical: endpointById() throws for a stale
 * endpoint id, which is exactly what a saved preset holds once you delete that
 * endpoint in Settings. Running the preset returned HTTP 200 with a session id
 * and then killed the server for everyone on it.
 */
function launch(work: () => Promise<void>): void {
  const a = active;
  void work().catch((err: unknown) => {
    const message = (err as Error)?.message ?? String(err);
    if (!a) {
      console.error('[engine] background run failed with no active run:', message);
      return;
    }
    a.lastError = message;
    a.autoRemaining = 0;
    a.abort = null;
    a.waitingFirstToken = false;
    a.phase = a.session.mode === 'roundtable' ? 'awaiting_gate' : 'done';
    persistOf(a);
    broadcast('error-event', { message, recoverable: true }, a.owner);
    if (active === a) pushState();
  });
}

/*
 * Mark the outgoing run as no longer the live one. A session carried status
 * 'active' on disk for as long as it was never explicitly stopped, so starting
 * a second session left the first still claiming to be active - the sidebar
 * would show three sessions all labelled active when only one can be.
 * Roundtables set it back to 'active' when resumed.
 */
function releaseActive(username: string): void {
  if (active && active.owner === username && active.session.status === 'active') {
    active.session.status = 'paused';
    persistOf(active);
  }
}

/*
 * The box holds one model, so one generation at a time - but WHOSE generation
 * decides what the caller can do about it. Both cases threw the same words, so
 * the client's recovery prompt offered "stop it and continue" for a run it had
 * no right to stop, and confirming produced a raw "running another user's
 * session" alert. Distinct messages let the client offer the takeover only when
 * the run is actually the caller's.
 */
function assertIdle(username: string): void {
  if (!active || active.phase !== 'generating') return;
  if (active.owner !== username) {
    throw new InputError('another user is generating on the box right now - try again shortly', 409);
  }
  throw new InputError('the box is busy with a generation - try again when it finishes', 409);
}

/** The active run, and it must be yours. */
function assertOwn(username: string): Active {
  if (!active) throw new InputError('no active run', 409);
  if (active.owner !== username) throw new InputError('the box is running another user\'s session', 409);
  return active;
}

/** Displace another user's idle run (persisted; they can resume it later). */
function takeover(username: string): void {
  if (active && active.owner !== username) {
    const prev = active.owner;
    persist();
    active = null;
    broadcast('state', { sessionId: null, phase: 'idle' }, prev);
  }
}

/** Stream one model turn into a new transcript entry. Returns the entry. */
async function runTurn(a: Active, opts: {
  member: CouncilMember;
  messages: Parameters<typeof streamChat>[0]['messages'];
  entrySeed: Omit<TranscriptEntry, 'id' | 'ts' | 'text'>;
  keepAlive?: string;
  /*
   * Stream into an entry that already exists instead of creating one. Used by
   * Continue, where the point is to extend the reply the user is looking at
   * rather than leave them stitching two bubbles together by eye.
   */
  appendTo?: TranscriptEntry;
}): Promise<TranscriptEntry> {
  const ep = endpointById(opts.member.endpointId, a.session);
  const params = { ...opts.member.params };
  if (opts.keepAlive !== undefined) params.keep_alive = opts.keepAlive;

  /*
   * Claim the box BEFORE the first await, and this ordering is the whole ball
   * game.
   *
   * Every concurrency guard in this file keys off phase === 'generating'
   * (assertIdle, chatSend, step, chatRegenerate, chatContinue, humanTurn...).
   * This block used to sit AFTER `await getModelInfo`, which is a network POST
   * with a 10s timeout on a model's first use - so for the whole of that window
   * every guard passed and the run had no AbortController. Confirmed against a
   * stub with a slow /api/show: pressing Enter twice in chat produced two user
   * entries, two concurrent /api/chat streams, and two replies, with the second
   * run's controller overwriting the first so Cancel only stopped one of them.
   *
   * Everything from the caller's guard down to here is one synchronous tick, so
   * setting the phase now means the second request - which is a separate tick -
   * is correctly rejected.
   */
  a.abort = new AbortController();
  a.phase = 'generating';
  a.currentSpeaker = opts.entrySeed.speaker;
  a.waitingFirstToken = true;
  a.lastError = undefined;
  pushState();

  /*
   * Measure the prompt against the model's real window (explicit num_ctx beats
   * the Modelfile's, which beats Ollama's server default).
   *
   * The 4096 floor is Ollama's server default and belongs ONLY to Ollama.
   * An openai-compat server (LM Studio, llama.cpp) exposes no /api/show, so
   * its window is simply unknown - and measuring a llama.cpp server running
   * 32k against 4096 reported a normal conversation as overflowing, blaming
   * an Ollama that was not involved. An unknown window is unknown: leave the
   * meter off rather than invent one.
   */
  const info = await getModelInfo(ep, opts.member.model);
  const window = params.num_ctx ?? info?.numCtx ?? (ep.kind === 'ollama' ? OLLAMA_DEFAULT_NUM_CTX : undefined);
  a.contextTokens = estimateMessages(opts.messages);
  a.contextWindow = window;
  a.contextPct = window ? Math.round((a.contextTokens / window) * 100) : undefined;
  a.contextLocal = ep.kind === 'ollama';
  pushState(); // the context meter can only be filled in once the window is known

  /*
   * Cancel pressed while /api/show was still in flight. The controller now
   * exists that early, so the abort actually landed somewhere - honour it
   * instead of going on to start a generation nobody is waiting for.
   */
  if (a.abort.signal.aborted) {
    const stopped = opts.appendTo ?? addEntry({ ...opts.entrySeed, text: '' }, a);
    stopped.error = 'cancelled';
    a.abort = null;
    a.waitingFirstToken = false;
    persistOf(a);
    broadcast('entry', stopped, a.owner);
    return stopped;
  }

  const entry = opts.appendTo ?? addEntry({ ...opts.entrySeed, text: '' }, a);
  const baseText = opts.appendTo ? opts.appendTo.text : '';
  try {
    const result = await streamChat({
      endpoint: ep,
      model: opts.member.model,
      messages: opts.messages,
      params,
      signal: a.abort.signal,
      onFirstToken: () => {
        a.waitingFirstToken = false;
        pushState();
      },
      onDelta: (delta) => broadcast('token', { entryId: entry.id, delta }, a.owner),
    });
    entry.text = baseText + result.text;
    entry.stats = result.stats;
    // Recomputed rather than OR-ed: a continuation that finishes properly must
    // clear the flag, or the Continue button never goes away.
    entry.truncated = result.doneReason === 'length' || undefined;
    // Assigned rather than only set-on-abort: continuing a CANCELLED entry has
    // to be able to clear the marker, or a finished reply would keep claiming it
    // was cut short and stay excluded from context for the rest of the session.
    entry.error = result.aborted ? 'cancelled' : undefined;
  } catch (err: any) {
    if (a.abort?.signal.aborted) {
      entry.error = 'cancelled';
    } else {
      /*
       * A failed CONTINUE must not condemn the reply it was extending. The
       * entry already existed and already held text the user had read, so
       * turning it into an error entry restyled a good answer as a failure.
       * It stays an assistant turn that is INCOMPLETE - exactly where a
       * cancelled continuation leaves it, and pressing Continue again clears
       * the marker either way.
       *
       * A fresh turn is the opposite case: the entry exists only for this
       * attempt, so it IS the error.
       */
      if (!baseText) entry.kind = 'error';
      // Keep whatever streamed before the failure (providers attach it), so the
      // final entry event does not blank out text the user already read.
      if (typeof err?.partialText === 'string' && err.partialText) {
        entry.text = baseText + err.partialText;
      }
      entry.error = err?.message ?? String(err);
      a.lastError = entry.error;
      broadcast('error-event', { message: entry.error, recoverable: true }, a.owner);
    }
  } finally {
    a.abort = null;
    a.waitingFirstToken = false;
  }
  persistOf(a); // this run, even if Stop already cleared the active slot
  broadcast('entry', entry, a.owner); // final version with full text/stats
  return entry;
}

/** Rename the active session and tell the browser, so open views aren't stale. */
function setTitle(title: string): void {
  if (!active) return;
  active.session.title = title;
  persist();
  broadcast('session-title', { sessionId: active.session.id, title }, active.owner);
}

function makeTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > 48 ? t.slice(0, 48) + '…' : t || 'untitled';
}

// ---------------- Council ----------------

export function startCouncil(username: string, config: CouncilConfig): string {
  assertIdle(username);
  // Validate BEFORE displacing anything. takeover() clears another user's
  // parked run, so a request that then threw on its own bad config destroyed
  // someone else's session and accomplished nothing.
  if (!config?.members?.length) throw new InputError('no council members selected');
  if (!config.consolidator?.model) throw new InputError('no consolidator selected');
  if (typeof config.prompt !== 'string' || !config.prompt.trim()) throw new InputError('prompt is empty');
  releaseActive(username);
  takeover(username);
  const session: Session = {
    id: store.newId(),
    mode: 'council',
    title: 'Council: ' + makeTitle(config.prompt),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config,
    entries: [],
    status: 'active',
    defaultEndpointId: firstEndpointOf(config),
  };
  active = {
    owner: username,
    session,
    abort: null,
    autoRemaining: 0,
    pauseRequested: false,
    phase: 'generating',
    waitingFirstToken: false,
  };
  addEntry({ kind: 'user', speaker: 'User', text: config.prompt });
  launch(runCouncil);
  return session.id;
}

async function runCouncil(): Promise<void> {
  const a = active!;
  const config = a.session.config as CouncilConfig;
  for (let i = 0; i < config.members.length; i++) {
    if (active !== a || a.pauseRequested) break;
    const m = config.members[i];
    const entry = await runTurn(a, {
      member: m,
      messages: council.buildMemberHistory(a.session.entries, i, config.ballot),
      entrySeed: { kind: 'participant', speaker: m.model, model: m.model, memberIndex: i },
      keepAlive: config.unloadBetweenModels ? '0' : undefined,
    });
    // Cancel means stop the council; a member ERROR does not, because skipping
    // a dead endpoint and letting the rest answer is the whole point of a
    // council. Roundtable and pipeline already stopped on cancel - this one
    // carried on through every remaining member and then consolidated, which
    // is the opposite of what pressing Cancel looks like it should do.
    if (entry.error === 'cancelled') {
      a.pauseRequested = true;
      break;
    }
  }
  if (active === a && !a.pauseRequested) await runConsolidation(a);
  finishRun(a);
}

async function runConsolidation(a: Active, template?: string): Promise<void> {
  const config = a.session.config as CouncilConfig;
  const prompt = council.buildConsolidatorPrompt(
    config,
    a.session.entries,
    template,
    council.joinedPrompts(a.session.entries),
  );
  await runTurn(a, {
    member: config.consolidator,
    messages: [{ role: 'user', content: prompt }],
    entrySeed: {
      kind: 'consolidation',
      speaker: config.consolidator.model,
      model: config.consolidator.model,
      memberIndex: -1,
    },
  });
}

/*
 * Complete a specific run - and only if it is still the live one.
 *
 * This used to read the GLOBAL active, and every caller reaches it across an
 * await: stop a council mid-stream and start a chat before the aborted turn
 * finishes unwinding, and the council's finishRun() marked the brand-new chat
 * as done. Reproduced deterministically (stopRun + startChat in one tick),
 * then fixed by addressing the run and refusing when it has been displaced -
 * a displaced run's final status was already written by whoever displaced it.
 */
/*
 * `keepStatus` is for the re-run paths - re-running one council member, or
 * redoing the consolidation. Those edit a session that already reached its
 * terminal status, and the run they represent is not the session's run: a
 * re-run on a council the user had STOPPED used to quietly promote it to
 * 'done', and cancelling that re-run used to demote a completed council to
 * 'stopped'. Neither event says anything about how the council itself ended.
 */
function finishRun(a: Active, keepStatus = false): void {
  if (active !== a) return;
  a.phase = 'done';
  /*
   * A cancelled run is 'stopped', not 'done'. finishRun sits outside the
   * pause check in runCouncil/runPipeline, so a council the user explicitly
   * cancelled was stamped 'done' and became indistinguishable in the sidebar
   * from one that ran to completion. Chat and roundtable already got this
   * right, via stopRun.
   */
  if (!keepStatus) {
    a.session.status = a.pauseRequested ? 'stopped' : 'done';
  } else {
    // Reopening a session stamps it 'active', so "leave the status alone" is
    // not enough on its own - the value to leave alone is already gone by the
    // time a re-run finishes. Put back what it was.
    const prior = a.resumedStatus ?? a.session.status;
    a.session.status = prior === 'active' ? 'done' : prior;
  }
  persistOf(a);
  pushState();
}

export function rerunMember(username: string, sessionId: string, memberIndex: number): void {
  assertIdle(username);
  const a = requireSession(username, sessionId);
  const config = a.session.config as CouncilConfig;
  const m = config.members[memberIndex];
  if (!m) throw new InputError(`no member at index ${memberIndex}`, 404);
  launch(async () => {
    await runTurn(a, {
      member: m,
      messages: council.buildMemberHistory(a.session.entries, memberIndex, config.ballot),
      entrySeed: { kind: 'participant', speaker: m.model, model: m.model, memberIndex },
      keepAlive: config.unloadBetweenModels ? '0' : undefined,
    });
    finishRun(a, true);
  });
}

export function consolidate(username: string, sessionId: string, template?: string, member?: CouncilMember): void {
  assertIdle(username);
  const a = requireSession(username, sessionId);
  const config = a.session.config as CouncilConfig;
  if (template) config.consolidator.template = template;
  // Switching engine sticks. A council whose consolidator blew its context is
  // re-run on a bigger model, and the export and any later re-run agree with
  // what actually produced the synthesis.
  if (member?.endpointId && member.model) {
    config.consolidator.endpointId = member.endpointId;
    config.consolidator.model = member.model;
    config.consolidator.params = member.params;
  }
  launch(async () => {
    await runConsolidation(a, template);
    finishRun(a, true);
  });
}

/** Follow-up round: every member answers a new prompt with their own history as context. */
export function councilFollowup(username: string, sessionId: string, prompt: string): void {
  assertIdle(username);
  if (!prompt?.trim()) throw new InputError('follow-up prompt is empty');
  const a = requireSession(username, sessionId);
  if (a.session.mode !== 'council') throw new InputError('not a council session');
  a.phase = 'generating';
  a.session.status = 'active';
  a.pauseRequested = false;
  addEntry({ kind: 'user', speaker: 'User', text: prompt.trim() });
  launch(runCouncil);
}

/** Load one of the user's stored sessions as the active run. */
function requireSession(username: string, sessionId: string): Active {
  if (active && active.owner === username && active.session.id === sessionId) return active;
  if (active && active.phase === 'generating') throw new InputError('the box is busy with a generation - try again when it finishes', 409);
  const session = store.loadSession<Session>(username, sessionId);
  if (!session) throw new InputError('session not found', 404);
  releaseActive(username);
  takeover(username);
  const resumedStatus = session.status;
  session.status = 'active';
  active = {
    owner: username,
    session,
    resumedStatus,
    abort: null,
    autoRemaining: 0,
    pauseRequested: false,
    phase: session.mode === 'roundtable' ? 'awaiting_gate' : 'generating',
    waitingFirstToken: false,
  };
  return active;
}

// ---------------- Roundtable ----------------

export function startRoundtable(username: string, config: RoundtableConfig): string {
  assertIdle(username);
  // Validated before takeover - see startCouncil.
  if (!config?.participants?.length || config.participants.length < 2) {
    throw new InputError('need at least 2 participants');
  }
  releaseActive(username);
  takeover(username);
  const session: Session = {
    id: store.newId(),
    mode: 'roundtable',
    title: 'Roundtable: ' + makeTitle(config.scenario || config.participants.map((p) => p.name).join(', ')),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config,
    entries: [],
    status: 'active',
    defaultEndpointId: firstEndpointOf(config),
  };
  active = {
    owner: username,
    session,
    abort: null,
    autoRemaining: 0,
    pauseRequested: false,
    phase: 'awaiting_gate',
    waitingFirstToken: false,
  };
  persist();
  pushState();
  return session.id;
}

export function resumeSession(username: string, sessionId: string): Session {
  assertIdle(username);
  const a = requireSession(username, sessionId);
  a.phase = a.session.mode === 'roundtable' ? 'awaiting_gate' : 'done';
  persist();
  pushState();
  return a.session;
}

export function step(username: string, nextParticipantId?: string, auto?: number): void {
  const a = assertOwn(username);
  if (a.session.mode !== 'roundtable') throw new InputError('not a roundtable session');
  if (a.phase === 'generating') throw new InputError('a generation is already running', 409);
  a.pauseRequested = false;
  // Capped: an uncapped count let one request hold the box indefinitely
  // (`{auto: 1e9}`), and no plausible roundtable needs more than this in one go.
  a.autoRemaining = Math.min(200, Math.max(0, auto ?? 0));
  launch(() => roundtableLoop(nextParticipantId));
}

async function roundtableLoop(firstParticipantId?: string): Promise<void> {
  const a = active!;
  const config = a.session.config as RoundtableConfig;
  let forcedId = firstParticipantId;
  do {
    const p = forcedId
      ? config.participants.find((x) => x.id === forcedId)
      : rt.nextSpeaker(config, a.session.entries);
    forcedId = undefined;
    if (!p) {
      a.lastError = 'unknown participant';
      break;
    }
    if (p.kind === 'human') {
      // it's the human's turn - stop and wait for them to type in the gate bar
      a.autoRemaining = 0;
      break;
    }
    const messages = rt.buildMessages(p, config, a.session.entries, getPersonas(a.owner));
    const entry = await runTurn(a, {
      member: { endpointId: p.endpointId, model: p.model, params: p.params },
      messages,
      entrySeed: { kind: 'participant', speaker: p.name, participantId: p.id, model: p.model },
      keepAlive: config.unloadBetweenTurns ? '0' : undefined,
    });
    if (entry.kind !== 'error' && !entry.error) {
      entry.text = rt.stripSelfPrefix(p.name, entry.text);
      persist();
      broadcast('entry', entry, a.owner);
    } else {
      a.autoRemaining = 0; // errors and cancels stop auto-stepping
      break;
    }
    if (a.autoRemaining > 0) a.autoRemaining--;
  } while (active === a && a.autoRemaining > 0 && !a.pauseRequested);
  // Only touch state that is still ours: after a Stop, `a` is orphaned and the
  // slot may already belong to a different session.
  if (active === a) {
    a.phase = a.session.status === 'active' ? 'awaiting_gate' : 'done';
    pushState();
  }
}

/** A human participant speaks their turn. */
export function humanTurn(username: string, participantId: string, text: string): void {
  const a = assertOwn(username);
  if (a.session.mode !== 'roundtable') throw new InputError('not a roundtable session');
  if (a.phase === 'generating') throw new InputError('wait for the current turn to finish', 409);
  if (!text?.trim()) throw new InputError('text is empty');
  const config = a.session.config as RoundtableConfig;
  const p = config.participants.find((x) => x.id === participantId);
  if (!p) throw new InputError('unknown participant', 404);
  addEntry({ kind: 'participant', speaker: p.name, participantId: p.id, text: text.trim() });
  pushState();
}

/** Run a judge/consolidator model over the roundtable transcript. */
export function consolidateRoundtable(
  username: string,
  sessionId: string,
  member: CouncilMember,
  template: string,
): void {
  assertIdle(username);
  const a = requireSession(username, sessionId);
  if (a.session.mode !== 'roundtable') throw new InputError('not a roundtable session');
  const transcript = renderTranscriptText(a.session.entries);
  if (!transcript) throw new InputError('nothing to consolidate yet');
  const prompt = template.includes('{{TRANSCRIPT}}')
    // Function replacement - a transcript is the most $-laden text in the app.
    ? template.replaceAll('{{TRANSCRIPT}}', () => transcript)
    : `${template.trim()}\n\nTRANSCRIPT:\n${transcript}`;
  launch(async () => {
    await runTurn(a, {
      member,
      messages: [{ role: 'user', content: prompt }],
      entrySeed: { kind: 'consolidation', speaker: member.model, model: member.model },
    });
    if (active === a) {
      a.phase = 'awaiting_gate'; // conversation can continue after judging
      pushState();
    }
  });
}

export function inject(username: string, text: string, as: 'narrator' | 'user'): void {
  const a = assertOwn(username);
  if (a.phase === 'generating') throw new InputError('wait for the current turn to finish', 409);
  addEntry({
    kind: as === 'narrator' ? 'narrator' : 'user',
    speaker: as === 'narrator' ? 'Narrator' : 'User',
    text,
  });
  pushState();
}

/**
 * Drop the last turn and take it again.
 *
 * Returns the human's text when the turn being rerolled was typed rather than
 * generated, so the caller can put it back in the speak box.
 */
export function rerollLast(username: string): { restored?: { participantId: string; name: string; text: string } } {
  const a = assertOwn(username);
  if (a.session.mode !== 'roundtable') throw new InputError('not a roundtable session');
  if (a.phase === 'generating') throw new InputError('a generation is already running', 409);
  const entries = a.session.entries;
  let idx = entries.length - 1;
  while (idx >= 0 && entries[idx].kind !== 'participant' && entries[idx].kind !== 'error') idx--;
  if (idx < 0) throw new InputError('nothing to reroll');
  const target = entries[idx];
  const seat = (a.session.config as RoundtableConfig).participants
    ?.find((p) => p.id === target.participantId);
  // Splice returns everything from idx onward. Broadcasting only removed[0]
  // left any trailing narrator/user injection visible in the browser while it
  // was already gone from disk - reroll after an inject silently diverged.
  const removed = entries.splice(idx);
  persist();
  for (const e of removed) broadcast('remove-entry', { entryId: e.id, sessionId: a.session.id }, a.owner);
  a.autoRemaining = 0;
  /*
   * A human seat has nothing to re-generate: roundtableLoop stops as soon as the
   * next speaker is a person. So pressing Reroll after typing your own turn
   * deleted what you wrote and then did nothing whatsoever. Hand the text back
   * instead, and leave the gate on that seat so it lands where it came from.
   */
  if (seat?.kind === 'human') {
    a.phase = 'awaiting_gate';
    pushState();
    return { restored: { participantId: seat.id, name: seat.name, text: target.text } };
  }
  launch(() => roundtableLoop(removed[0].participantId));
  return {};
}

// ---------------- Chat ----------------

export function startChat(username: string, config: ChatConfig): string {
  assertIdle(username);
  if (!config?.model || !config.endpointId) throw new InputError('pick an endpoint and model');
  releaseActive(username);
  takeover(username);
  const session: Session = {
    id: store.newId(),
    mode: 'chat',
    title: `Chat: ${config.model}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config,
    entries: [],
    status: 'active',
    defaultEndpointId: firstEndpointOf(config),
  };
  active = {
    owner: username,
    session,
    abort: null,
    autoRemaining: 0,
    pauseRequested: false,
    phase: 'awaiting_gate',
    waitingFirstToken: false,
  };
  persist();
  pushState();
  return session.id;
}

/** Append the user's message and immediately generate a reply. */
export function chatSend(username: string, text: string): void {
  const a = assertOwn(username);
  if (a.session.mode !== 'chat') throw new InputError('not a chat session');
  if (a.phase === 'generating') throw new InputError('a generation is already running', 409);
  if (!text?.trim()) throw new InputError('message is empty');
  addEntry({ kind: 'user', speaker: 'You', text: text.trim() });
  // first message names the session, so the sidebar is readable
  if (a.session.entries.filter((e) => e.kind === 'user').length === 1) {
    setTitle('Chat: ' + makeTitle(text));
  }
  launch(runChatTurn);
}

/** Drop the last reply and generate a fresh one for the same message. */
export function chatRegenerate(username: string): void {
  const a = assertOwn(username);
  if (a.session.mode !== 'chat') throw new InputError('not a chat session');
  if (a.phase === 'generating') throw new InputError('a generation is already running', 409);
  const entries = a.session.entries;
  const last = entries.at(-1);
  if (!last) throw new InputError('nothing to regenerate');
  /*
   * The transcript ends with a message that never got a reply. That happens when
   * the turn failed before its entry existed - endpointById throws inside
   * runTurn ahead of addEntry, which is exactly what a saved session holds once
   * its endpoint is deleted in Settings. There is nothing to throw away here, so
   * answer the question.
   *
   * The old walk-back went PAST the unanswered message to the previous reply and
   * spliced from there, which destroyed what the person had just typed and
   * re-answered the question before it. With a single user entry it found
   * nothing at all and threw "nothing to regenerate", leaving retyping - into a
   * doubled user turn - as the only way forward.
   */
  if (last.kind === 'user') {
    launch(runChatTurn);
    return;
  }
  const removed = entries.splice(entries.length - 1);
  persist();
  for (const e of removed) broadcast('remove-entry', { entryId: e.id, sessionId: a.session.id }, a.owner);
  launch(runChatTurn);
}

async function runChatTurn(): Promise<void> {
  const a = active!;
  const config = a.session.config as ChatConfig;
  const messages = chat.buildChatMessages(config, a.session.entries, getPersonas(a.owner));
  await runTurn(a, {
    member: { endpointId: config.endpointId, model: config.model, params: config.params },
    messages,
    entrySeed: { kind: 'participant', speaker: config.model, model: config.model },
  });
  if (active === a) {
    a.phase = 'awaiting_gate';
    pushState();
  }
}

// ---------------- Pipeline ----------------

export function startPipeline(username: string, config: PipelineConfig): string {
  assertIdle(username);
  pipeline.validatePipeline(config); // before takeover - see startCouncil
  releaseActive(username);
  takeover(username);
  const session: Session = {
    id: store.newId(),
    mode: 'pipeline',
    title: 'Pipeline: ' + makeTitle(config.input),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config,
    entries: [],
    status: 'active',
    defaultEndpointId: firstEndpointOf(config),
  };
  active = {
    owner: username,
    session,
    abort: null,
    autoRemaining: 0,
    pauseRequested: false,
    phase: 'generating',
    waitingFirstToken: false,
  };
  addEntry({ kind: 'user', speaker: 'User', text: config.input });
  launch(() => runPipeline(0));
  return session.id;
}

async function runPipeline(fromStage: number): Promise<void> {
  const a = active!;
  const config = a.session.config as PipelineConfig;
  for (let i = fromStage; i < config.stages.length; i++) {
    if (active !== a || a.pauseRequested) break;
    const stage = config.stages[i];
    let input: string;
    try {
      input = pipeline.resolveStageInput(a.session.entries, i);
    } catch (err: any) {
      a.lastError = err?.message ?? String(err);
      break;
    }
    const entry = await runTurn(a, {
      member: { endpointId: stage.endpointId, model: stage.model, params: stage.params },
      messages: [{ role: 'user', content: pipeline.renderStagePrompt(stage.template, input) }],
      entrySeed: {
        kind: 'participant',
        speaker: stage.name?.trim() || stage.model,
        model: stage.model,
        memberIndex: i,
      },
    });
    /*
     * Downstream stages have no input either way, so both cases break - but
     * they are not the same event. finishRun stamps 'done' unless a pause was
     * requested, so a pipeline the user explicitly cancelled sat in the
     * sidebar looking exactly like one that ran to completion. runCouncil
     * makes the same distinction for the same reason.
     */
    if (entry.error === 'cancelled') {
      a.pauseRequested = true;
      break;
    }
    if (entry.kind === 'error' || entry.error) break;
  }
  finishRun(a);
}

/** Re-run from a given stage onward (using the existing output of the stage before it). */
export function rerunPipelineFrom(username: string, sessionId: string, stageIndex: number): void {
  assertIdle(username);
  const a = requireSession(username, sessionId);
  if (a.session.mode !== 'pipeline') throw new InputError('not a pipeline session');
  const config = a.session.config as PipelineConfig;
  if (stageIndex < 0 || stageIndex >= config.stages.length) throw new InputError('bad stage index');
  /*
   * Discard this stage's output and everything downstream of it - which is what
   * the button has always claimed to do.
   *
   * The server only appended, so a re-run left TWO cards for every stage from
   * here on with nothing marking which was current. Both kept working "Re-run
   * from here" buttons, exports carried both outputs, and no "queued"
   * placeholders appeared during the re-run because the stale entries already
   * satisfied the view's done-stages check. Nothing downstream is worth keeping
   * anyway: it was derived from output that is being replaced.
   */
  const kept = pipeline.entriesBeforeStage(a.session.entries, stageIndex);
  const dropped = a.session.entries.filter((e) => !kept.includes(e));
  a.session.entries = kept;
  persistOf(a);
  for (const e of dropped) broadcast('remove-entry', { entryId: e.id, sessionId: a.session.id }, a.owner);
  a.phase = 'generating';
  a.session.status = 'active';
  a.pauseRequested = false;
  a.lastError = undefined; // the failure being re-run is no longer current
  pushState();
  launch(() => runPipeline(stageIndex));
}

export function pause(username: string): void {
  const a = assertOwn(username);
  a.pauseRequested = true;
  a.autoRemaining = 0;
  pushState();
}

export function stopRun(username: string): void {
  const a = assertOwn(username);
  a.pauseRequested = true;
  a.autoRemaining = 0;
  a.abort?.abort();
  a.session.status = 'stopped';
  a.phase = 'done';
  persist();
  pushState();
  active = null;
  broadcast('state', { sessionId: null, phase: 'idle' }, username);
  broadcast('busy', { busy: false });
}

/**
 * Copy a session up to and including one entry, and make the copy the live run.
 *
 * The transcript is the state, so "what if it had gone differently from here"
 * needs a branch rather than a destructive reroll. Everything after the cut is
 * dropped from the copy and the original is untouched, so both readings survive.
 */
export function forkSession(username: string, sessionId: string, entryId: string): Session {
  assertIdle(username);
  const source = store.loadSession<Session>(username, sessionId);
  if (!source) throw new InputError('session not found', 404);
  const cut = source.entries.findIndex((e) => e.id === entryId);
  if (cut < 0) throw new InputError('that entry is not part of this session', 404);

  const copy = structuredClone(source) as Session;
  copy.id = store.newId();
  copy.title = source.title.startsWith('Fork: ') ? source.title : `Fork: ${source.title}`;
  copy.createdAt = new Date().toISOString();
  copy.updatedAt = copy.createdAt;
  copy.entries = copy.entries.slice(0, cut + 1);
  /*
   * Fresh entry ids. structuredClone copies them verbatim, and the SSE
   * remove-entry handler filters the open session's entries by id alone - so
   * rerolling in the fork removed the shared entries from the ORIGINAL
   * session's view in another tab.
   */
  copy.entries = copy.entries.map((e) => ({ ...e, id: store.newId() }));
  copy.status = 'paused';
  copy.forkedFrom = { sessionId: source.id, entryId, title: source.title };
  store.saveSession(username, copy);
  // Hand it back as the live run: forking is something you do in order to keep
  // going, so making it active saves a Resume click.
  return resumeSession(username, copy.id);
}

/**
 * Extend the last reply instead of starting a new one.
 *
 * A model that stops on its token budget leaves a sentence half-finished, and
 * the useful repair is more of the same bubble - not a second bubble the reader
 * has to mentally staple on. The nudge below is sent for this call only and is
 * never stored, so the transcript stays a clean alternation of turns.
 */
export function chatContinue(username: string): void {
  const a = assertOwn(username);
  if (a.session.mode !== 'chat') throw new InputError('not a chat session');
  if (a.phase === 'generating') throw new InputError('a generation is already running', 409);
  const last = a.session.entries.at(-1);
  // A cancelled partial is continuable - that is the point of keeping it. Any
  // other error is not: there is nothing coherent to continue from.
  if (!last || last.kind !== 'participant' || (last.error && last.error !== 'cancelled') || !last.text.trim()) {
    throw new InputError('there is no reply to continue');
  }
  const config = a.session.config as ChatConfig;
  launch(async () => {
    /*
     * Build context with the cancelled marker cleared on the entry being
     * continued. Everywhere else a cancelled partial is deliberately withheld
     * from the model, but here the whole request is "carry on from this text",
     * so the model has to see it. Cloned rather than mutated: if the
     * continuation is itself cancelled the stored entry must stay marked.
     */
    const forContext = last.error
      ? a.session.entries.map((e) => (e === last ? { ...e, error: undefined } : e))
      : a.session.entries;
    const messages = chat.buildChatMessages(config, forContext, getPersonas(a.owner));
    messages.push({
      role: 'user',
      content:
        'Continue from exactly where you stopped, in the same voice. Do not repeat ' +
        'anything you have already written and do not start over.',
    });
    await runTurn(a, {
      member: { endpointId: config.endpointId, model: config.model, params: config.params },
      messages,
      entrySeed: { kind: 'participant', speaker: config.model, model: config.model },
      appendTo: last,
    });
    if (active === a) {
      a.phase = 'awaiting_gate';
      pushState();
    }
  });
}

/** Replace a session's tags. */
export function setTags(username: string, sessionId: string, tags: string[]): void {
  const a = active && active.owner === username && active.session.id === sessionId ? active : null;
  if (a) {
    a.session.tags = tags.length ? tags : undefined;
    persistOf(a);
    return;
  }
  const s = store.loadSession<Session>(username, sessionId);
  if (!s) throw new InputError('session not found', 404);
  s.tags = tags.length ? tags : undefined;
  store.saveSession(username, s);
}

/**
 * Force a run to end because its owner is being deleted.
 *
 * Two problems needed this. The live run still held the session in memory, so
 * the next persist recreated the data directory that deleteUser had just
 * archived - handing a recreated username the previous person's transcripts,
 * the exact leak archiving exists to prevent. And stop/cancel/pause all go
 * through assertOwn, so a deleted user's in-flight generation could not be
 * stopped by anyone and the box stayed occupied until the stream ended on its
 * own - forever, against a stalled endpoint.
 *
 * Unlike stopRun this takes no owner check, because the caller has already
 * decided the account is going away.
 */
export function evictUser(username: string): void {
  if (!active || active.owner !== username) return;
  active.pauseRequested = true;
  active.autoRemaining = 0;
  active.abort?.abort();
  active = null;
  broadcast('state', { sessionId: null, phase: 'idle' }, username);
  broadcast('busy', { busy: false });
}

export function cancelGeneration(username: string): void {
  const a = assertOwn(username);
  a.abort?.abort();
}
