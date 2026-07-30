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
  throw new Error(
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

function assertIdle(): void {
  if (active && active.phase === 'generating') {
    throw new Error('the box is busy with a generation - try again when it finishes');
  }
}

/** The active run, and it must be yours. */
function assertOwn(username: string): Active {
  if (!active) throw new Error('no active run');
  if (active.owner !== username) throw new Error('the box is running another user\'s session');
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

  // Measure the prompt against the model's real window (explicit num_ctx beats
  // the Modelfile's, which beats Ollama's server default).
  const info = await getModelInfo(ep, opts.member.model);
  const window = params.num_ctx ?? info?.numCtx ?? OLLAMA_DEFAULT_NUM_CTX;
  a.contextTokens = estimateMessages(opts.messages);
  a.contextWindow = window;
  a.contextPct = Math.round((a.contextTokens / window) * 100);
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
    if (result.aborted) entry.error = 'cancelled';
  } catch (err: any) {
    if (a.abort?.signal.aborted) {
      entry.error = 'cancelled';
    } else {
      entry.kind = 'error';
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
  assertIdle();
  releaseActive(username);
  takeover(username);
  if (!config.members?.length) throw new Error('no council members selected');
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
function finishRun(a: Active): void {
  if (active !== a) return;
  a.phase = 'done';
  /*
   * A cancelled run is 'stopped', not 'done'. finishRun sits outside the
   * pause check in runCouncil/runPipeline, so a council the user explicitly
   * cancelled was stamped 'done' and became indistinguishable in the sidebar
   * from one that ran to completion. Chat and roundtable already got this
   * right, via stopRun.
   */
  a.session.status = a.pauseRequested ? 'stopped' : 'done';
  persistOf(a);
  pushState();
}

export function rerunMember(username: string, sessionId: string, memberIndex: number): void {
  assertIdle();
  const a = requireSession(username, sessionId);
  const config = a.session.config as CouncilConfig;
  const m = config.members[memberIndex];
  if (!m) throw new Error(`no member at index ${memberIndex}`);
  launch(async () => {
    await runTurn(a, {
      member: m,
      messages: council.buildMemberHistory(a.session.entries, memberIndex, config.ballot),
      entrySeed: { kind: 'participant', speaker: m.model, model: m.model, memberIndex },
      keepAlive: config.unloadBetweenModels ? '0' : undefined,
    });
    finishRun(a);
  });
}

export function consolidate(username: string, sessionId: string, template?: string, member?: CouncilMember): void {
  assertIdle();
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
    finishRun(a);
  });
}

/** Follow-up round: every member answers a new prompt with their own history as context. */
export function councilFollowup(username: string, sessionId: string, prompt: string): void {
  assertIdle();
  if (!prompt?.trim()) throw new Error('follow-up prompt is empty');
  const a = requireSession(username, sessionId);
  if (a.session.mode !== 'council') throw new Error('not a council session');
  a.phase = 'generating';
  a.session.status = 'active';
  a.pauseRequested = false;
  addEntry({ kind: 'user', speaker: 'User', text: prompt.trim() });
  launch(runCouncil);
}

/** Load one of the user's stored sessions as the active run. */
function requireSession(username: string, sessionId: string): Active {
  if (active && active.owner === username && active.session.id === sessionId) return active;
  if (active && active.phase === 'generating') throw new Error('the box is busy with a generation - try again when it finishes');
  const session = store.loadSession<Session>(username, sessionId);
  if (!session) throw new Error('session not found');
  releaseActive(username);
  takeover(username);
  session.status = 'active';
  active = {
    owner: username,
    session,
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
  assertIdle();
  releaseActive(username);
  takeover(username);
  if (!config.participants?.length || config.participants.length < 2) {
    throw new Error('need at least 2 participants');
  }
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
  assertIdle();
  const a = requireSession(username, sessionId);
  a.phase = a.session.mode === 'roundtable' ? 'awaiting_gate' : 'done';
  persist();
  pushState();
  return a.session;
}

export function step(username: string, nextParticipantId?: string, auto?: number): void {
  const a = assertOwn(username);
  if (a.session.mode !== 'roundtable') throw new Error('not a roundtable session');
  if (a.phase === 'generating') throw new Error('a generation is already running');
  a.pauseRequested = false;
  a.autoRemaining = Math.max(0, auto ?? 0);
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
  if (a.session.mode !== 'roundtable') throw new Error('not a roundtable session');
  if (a.phase === 'generating') throw new Error('wait for the current turn to finish');
  if (!text?.trim()) throw new Error('text is empty');
  const config = a.session.config as RoundtableConfig;
  const p = config.participants.find((x) => x.id === participantId);
  if (!p) throw new Error('unknown participant');
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
  assertIdle();
  const a = requireSession(username, sessionId);
  if (a.session.mode !== 'roundtable') throw new Error('not a roundtable session');
  const transcript = renderTranscriptText(a.session.entries);
  if (!transcript) throw new Error('nothing to consolidate yet');
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
  if (a.phase === 'generating') throw new Error('wait for the current turn to finish');
  addEntry({
    kind: as === 'narrator' ? 'narrator' : 'user',
    speaker: as === 'narrator' ? 'Narrator' : 'User',
    text,
  });
  pushState();
}

export function rerollLast(username: string): void {
  const a = assertOwn(username);
  if (a.session.mode !== 'roundtable') throw new Error('not a roundtable session');
  if (a.phase === 'generating') throw new Error('a generation is already running');
  const entries = a.session.entries;
  let idx = entries.length - 1;
  while (idx >= 0 && entries[idx].kind !== 'participant' && entries[idx].kind !== 'error') idx--;
  if (idx < 0) throw new Error('nothing to reroll');
  // Splice returns everything from idx onward. Broadcasting only removed[0]
  // left any trailing narrator/user injection visible in the browser while it
  // was already gone from disk - reroll after an inject silently diverged.
  const removed = entries.splice(idx);
  persist();
  for (const e of removed) broadcast('remove-entry', { entryId: e.id }, a.owner);
  a.autoRemaining = 0;
  launch(() => roundtableLoop(removed[0].participantId));
}

// ---------------- Chat ----------------

export function startChat(username: string, config: ChatConfig): string {
  assertIdle();
  releaseActive(username);
  takeover(username);
  if (!config.model || !config.endpointId) throw new Error('pick an endpoint and model');
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
  if (a.session.mode !== 'chat') throw new Error('not a chat session');
  if (a.phase === 'generating') throw new Error('a generation is already running');
  if (!text?.trim()) throw new Error('message is empty');
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
  if (a.session.mode !== 'chat') throw new Error('not a chat session');
  if (a.phase === 'generating') throw new Error('a generation is already running');
  const entries = a.session.entries;
  let idx = entries.length - 1;
  while (idx >= 0 && entries[idx].kind === 'user') idx--;
  if (idx < 0) throw new Error('nothing to regenerate');
  const removed = entries.splice(idx);
  persist();
  for (const e of removed) broadcast('remove-entry', { entryId: e.id }, a.owner);
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
  assertIdle();
  releaseActive(username);
  takeover(username);
  pipeline.validatePipeline(config);
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
    if (entry.kind === 'error' || entry.error) break; // downstream stages have no input
  }
  finishRun(a);
}

/** Re-run from a given stage onward (using the existing output of the stage before it). */
export function rerunPipelineFrom(username: string, sessionId: string, stageIndex: number): void {
  assertIdle();
  const a = requireSession(username, sessionId);
  if (a.session.mode !== 'pipeline') throw new Error('not a pipeline session');
  const config = a.session.config as PipelineConfig;
  if (stageIndex < 0 || stageIndex >= config.stages.length) throw new Error('bad stage index');
  a.phase = 'generating';
  a.session.status = 'active';
  a.pauseRequested = false;
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
  assertIdle();
  const source = store.loadSession<Session>(username, sessionId);
  if (!source) throw new Error('session not found');
  const cut = source.entries.findIndex((e) => e.id === entryId);
  if (cut < 0) throw new Error('that entry is not part of this session');

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
  if (a.session.mode !== 'chat') throw new Error('not a chat session');
  if (a.phase === 'generating') throw new Error('a generation is already running');
  const last = a.session.entries.at(-1);
  if (!last || last.kind !== 'participant' || last.error || !last.text.trim()) {
    throw new Error('there is no reply to continue');
  }
  const config = a.session.config as ChatConfig;
  launch(async () => {
    const messages = chat.buildChatMessages(config, a.session.entries, getPersonas(a.owner));
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
  if (!s) throw new Error('session not found');
  s.tags = tags.length ? tags : undefined;
  store.saveSession(username, s);
}

export function cancelGeneration(username: string): void {
  const a = assertOwn(username);
  a.abort?.abort();
}
