// Shared type definitions. Erasable-syntax TypeScript only (no enums) -
// this file must survive Node's type stripping.

export type EndpointKind = 'ollama' | 'openai';

export interface Endpoint {
  id: string;
  name: string;
  baseUrl: string; // e.g. "http://10.0.0.5:11434", no trailing slash
  kind: EndpointKind;
  defaultKeepAlive?: string; // "5m" | "0" | ...
  // Display names keyed by real model id ("qwen3-coder:30b" -> "Alibaba
  // qwen3-coder"). Cosmetic only: every API call, session record and export
  // carries the real id, so renames never invalidate history.
  aliases?: Record<string, string>;
}

export interface AppConfig {
  endpoints: Endpoint[];
}

/*
 * One distilled conversation. A memory is written by a model (the summariser)
 * over a transcript, then attached to a persona by an explicit Save - never
 * automatically. Provenance is kept so the entry can be traced back to the
 * conversation it came from, and judged or deleted on that basis.
 */
export interface MemoryEntry {
  id: string;
  at: string; // ISO timestamp of the save
  text: string;
  sessionId?: string;
  sessionTitle?: string;
  model?: string; // which model wrote the summary
}

export interface Persona {
  id: string;
  name: string;
  systemPrompt: string;
  /*
   * Kept apart from systemPrompt on purpose. The prompt is who the persona is;
   * memories are what it has been told since. Separate fields mean a
   * summariser can be handed the transcript without the memory (so it cannot
   * summarise the memory back into itself), memories can be pruned without
   * touching the prompt, and compaction rewrites only this list.
   */
  memories?: MemoryEntry[];
}

export interface GenParams {
  temperature?: number;
  top_p?: number;
  num_ctx?: number;
  maxTokens?: number;
  keep_alive?: string;
}

export interface Participant {
  id: string;
  name: string; // display name, e.g. "DM"
  kind?: 'model' | 'human'; // default 'model'; humans type their turns in the gate bar
  endpointId: string; // unused for humans
  model: string; // unused for humans
  personaId?: string; // base layer from personas.json
  overlayPrompt?: string; // role overlay, free text
  params?: GenParams;
  color?: string;
}

export interface CouncilMember {
  endpointId: string;
  model: string;
  params?: GenParams;
}

export interface CouncilConfig {
  prompt: string;
  members: CouncilMember[];
  consolidator: CouncilMember & { template: string };
  unloadBetweenModels?: boolean; // keep_alive: "0" per member call
  /*
   * Run the members and stop. Sometimes a spread of separate answers IS the
   * output and comparing them adds nothing - and the consolidation is an extra
   * call, on the biggest context of the run, often to the most expensive model.
   *
   * The consolidator is still recorded, so "actually, synthesise these after
   * all" from the session view works without reconfiguring anything.
   */
  skipConsolidation?: boolean;
  /*
   * Ballot mode. When set, every member is asked to end its answer with one of
   * these options and the results are tallied. The members still answer in
   * prose - the vote is an extra signal, not a replacement - because "4 of 5
   * said yes" and the reasons they gave are useful for different things.
   */
  ballot?: string[];
}

export interface RoundtableConfig {
  participants: Participant[];
  scenario: string; // shared context appended to every system prompt
  turnOrder: 'round-robin';
  keepLastTurns?: number;
  // keep_alive: "0" per turn. For seats whose models spill into system RAM,
  // a still-resident previous speaker can make the next model's load fail
  // its memory estimate; unloading between turns trades reload time for a
  // guaranteed-empty box at every handoff.
  unloadBetweenTurns?: boolean;
}

export type EntryKind = 'user' | 'participant' | 'narrator' | 'consolidation' | 'error';

export interface EntryStats {
  promptTokensEst?: number;
  evalCount?: number;
  durationMs?: number;
}

export interface TranscriptEntry {
  id: string;
  ts: string;
  kind: EntryKind;
  speaker: string; // participant name, 'User', 'Narrator', or model name (council)
  participantId?: string;
  model?: string;
  memberIndex?: number; // council: which member slot this entry belongs to (-1 = consolidator)
  text: string;
  error?: string;
  stats?: EntryStats;
  // The model stopped because it hit its token limit, not because it finished.
  // Drives the Continue button; set from Ollama's done_reason.
  truncated?: boolean;
}

export interface PipelineStage {
  name?: string; // display label; defaults to model
  endpointId: string;
  model: string;
  template: string; // must contain {{INPUT}}; receives previous stage's output
  params?: GenParams;
}

export interface PipelineConfig {
  input: string;
  stages: PipelineStage[];
}

export interface ChatConfig {
  endpointId: string;
  model: string;
  personaId?: string; // base layer from personas.json
  systemPrompt?: string; // free text, layered after the persona
  params?: GenParams;
  /*
   * The pairing this chat was started from, if any. Recorded so the summarise
   * fold can default to the same summariser every time - a memory-building
   * chat is the case where you use one combination over and over, and picking
   * the model again on every one is the friction.
   */
  pairingId?: string;
  /*
   * Set on a session created to compact a persona's memory. The session
   * deliberately has no personaId - the memories are its user turn, and
   * layering them into the system prompt as well would hand the compactor
   * two copies. The flag lets the Save control default to "replace".
   */
  compactsPersonaId?: string;
}

export type SessionMode = 'council' | 'roundtable' | 'pipeline' | 'chat';
// 'paused' means "was the live run, is not any more" - set when a different
// session takes the active slot, so only one session can ever claim 'active'.
export type SessionStatus = 'active' | 'paused' | 'done' | 'stopped' | 'error';

export interface Session {
  id: string;
  mode: SessionMode;
  title: string;
  createdAt: string;
  updatedAt: string;
  config: CouncilConfig | RoundtableConfig | PipelineConfig | ChatConfig;
  entries: TranscriptEntry[];
  status: SessionStatus;
  /** Free-text labels for grouping in the sidebar. */
  tags?: string[];
  /*
   * Endpoint to fall back on when a seat's own endpointId no longer resolves,
   * which is what happens to every saved session the moment you delete or
   * recreate an endpoint in Settings. Recorded when the session is created.
   */
  defaultEndpointId?: string;
  /** Set on a session created by forking another, for provenance in exports. */
  forkedFrom?: { sessionId: string; entryId: string; title: string };
}

export type RunPhase = 'idle' | 'generating' | 'awaiting_gate' | 'auto_stepping' | 'done' | 'error';

export interface RunState {
  sessionId: string | null;
  mode?: SessionMode;
  phase: RunPhase;
  currentSpeaker?: string;
  nextSpeaker?: string;
  nextParticipantId?: string;
  autoRemaining?: number;
  waitingFirstToken?: boolean;
  contextPct?: number; // uncapped - >100 means the window is overflowing
  contextTokens?: number; // estimated prompt tokens for the current/last turn
  contextWindow?: number; // the window those tokens are measured against
  // Whether that window belongs to a local Ollama box. Only Ollama silently
  // drops the oldest turns and answers anyway, so only Ollama's overflow
  // warning can say that. The meter hides entirely when the window is unknown.
  contextLocal?: boolean;
  lastError?: string;
  // Set only in the state served to NON-owners: the box is mid-generation on
  // someone else's run. Carries no detail about whose or what, on purpose.
  boxBusy?: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamResult {
  text: string;
  stats: EntryStats;
  aborted: boolean;
  /** Ollama's done_reason: 'length' means it ran out of budget mid-thought. */
  doneReason?: string;
}

export interface Presets {
  consolidatorTemplate: string;
  judgeTemplate?: string; // roundtable consolidation/judging, {{TRANSCRIPT}} placeholder
  summarizeTemplate?: string; // chat -> persona memory, {{TRANSCRIPT}} and {{MEMORY}}
  distilTemplate?: string; // reference material -> persona memory, {{SOURCE}} and {{MEMORY}}
  compactTemplate?: string; // many memories -> one, {{MEMORY}}
  /*
   * A remembered persona-and-model combination.
   *
   * Building a persona's memory means the same persona, the same model and
   * the same summariser, over and over - and every one of those was a
   * separate pick on a form each time. A pairing is that combination named
   * and reusable. It is deliberately a preset rather than a fifth session
   * mode: everything that differs is which fields the form starts with and
   * how the session is labelled, and neither needs its own state machine.
   *
   * `summarizer` is written back whenever a summary runs in a session started
   * from the pairing, so the last one used becomes the next one offered.
   */
  pairings?: Array<{
    id: string;
    name: string;
    personaId?: string;
    endpointId: string;
    model: string;
    params?: GenParams;
    summarizer?: { endpointId: string; model: string; params?: GenParams };
  }>;
  councils: Array<{ id: string; name: string; config: CouncilConfig }>;
  roundtables: Array<{ id: string; name: string; config: RoundtableConfig }>;
  pipelines?: Array<{ id: string; name: string; stages: PipelineStage[] }>;
}

export const DEFAULT_CONSOLIDATOR_TEMPLATE = `You are reviewing responses from several models to the same prompt.

ORIGINAL PROMPT:
{{PROMPT}}

{{RESPONSES}}

Compare the responses: identify agreements, contradictions, unique insights,
and errors. Then produce a single best consolidated answer.`;

/**
 * Seeded into an account that has never saved a persona - examples are a
 * faster explanation of what a persona is than any placeholder text. They
 * are ordinary personas once seeded: editable, deletable, and a saved empty
 * list stays empty rather than resurrecting them.
 *
 * Each states a behavioural rule rather than an adjective ("name the check
 * and wait for a roll", not "be impartial"), because a model can check
 * itself against a rule and cannot check itself against a mood.
 *
 * Two deliberate pairs. Skeptic and Advocate hold opposing stances, which is
 * what makes a roundtable argue instead of politely converging on the first
 * answer. Plain Explainer and Socratic Tutor want the same outcome by opposite
 * methods - one tells you, one refuses to - so a tutoring roundtable can pit
 * them against each other over the same question.
 */
export const DEFAULT_PERSONAS: Persona[] = [
  {
    id: 'default-skeptic',
    name: 'Skeptic',
    systemPrompt:
      'You argue the case against whatever is being proposed. Name the assumption the ' +
      'proposal rests on, then the failure mode nobody has mentioned yet. Ask for evidence ' +
      'before accepting a claim, and say plainly when an answer sounds confident but is ' +
      'unsupported. Do not soften a real objection to keep the peace.',
  },
  {
    id: 'default-advocate',
    name: 'Advocate',
    systemPrompt:
      'You argue the strongest honest case FOR whatever is being proposed. Steelman it: ' +
      'state the version of the idea that survives the obvious objections, and what would ' +
      'have to be true for it to be the right call. Concede a point when it is genuinely ' +
      'lost rather than defending every part of it.',
  },
  {
    id: 'default-reviewer',
    name: 'Code Reviewer',
    systemPrompt:
      'You review code for defects, not style. Lead with the most serious problem you ' +
      'actually found, and state the input or state that makes it fail. If the code is ' +
      'correct, say so instead of inventing a finding. Flag missing error handling and ' +
      'unchecked assumptions; ignore formatting.',
  },
  {
    id: 'default-dm',
    name: 'Dungeon Master',
    systemPrompt:
      'You are an impartial Dungeon Master for D&D 5E. Never assume a player action ' +
      'succeeds: name the check or save it requires and wait for a result before narrating ' +
      'any outcome. Describe consequences, including failures, in two or three sentences. ' +
      'Never speak or act for a player character.',
  },
  {
    id: 'default-explainer',
    name: 'Plain Explainer',
    systemPrompt:
      'You explain things to someone competent but new to this specific topic. Define a ' +
      'term the first time you use it. Prefer one concrete example over three abstract ' +
      'sentences. If the common mental model is wrong, say what people usually assume and ' +
      'why it breaks.',
  },
  {
    id: 'default-socratic',
    name: 'Socratic Tutor',
    systemPrompt:
      'You teach only by asking. Never state the answer, even when the student is one step away ' +
      'and asks you to confirm it. Ask one question at a time, aimed at the specific thing they ' +
      'have not checked yet, and wait for their answer before asking the next. When they are ' +
      'right, ask them why. When they are wrong, do not correct them: ask the question whose ' +
      'answer they cannot reconcile with what they just said.',
  },
  {
    id: 'default-terse',
    name: 'Terse Analyst',
    systemPrompt:
      'Answer in at most five sentences. No preamble, and no restating the question. Lead ' +
      'with the conclusion, then the reasoning that supports it. If the honest answer is ' +
      'that it depends, say what it depends on.',
  },
];

export const DEFAULT_JUDGE_TEMPLATE = `You are reviewing a multi-party conversation transcript.

TRANSCRIPT:
{{TRANSCRIPT}}

Summarize the discussion: the strongest points made by each participant,
where they agreed and disagreed, and your overall verdict or synthesis.`;

/*
 * What a summariser says when a conversation was not worth remembering.
 *
 * A sentinel rather than a sentence, because the sentence became the bug: told
 * to "say so in one line" if nothing was new, models wrote "no new information
 * was shared" - and that got SAVED as a memory. The next summariser then found
 * a memory shaped exactly like the answer it was being asked for, sitting at
 * the bottom of the reference block, and copied it. Three rounds in, the
 * meta-commentary had crowded out the facts. A fixed token is something the
 * app can recognise and refuse to store.
 */
export const NOTHING_NEW = 'NOTHING NEW';

/*
 * Chat -> memory. The summariser is shown what the persona ALREADY remembers
 * and asked for the delta. Without that, every summary of a long-running
 * relationship converges on the same five bullets, and a model that echoed a
 * memory back during the conversation gets it recorded a second time.
 */
export const DEFAULT_SUMMARIZE_TEMPLATE = `You are writing a memory for an assistant persona, distilled from one conversation it just had.

=== ALREADY REMEMBERED - reference only. Do not copy from this block, do not summarise it, do not mention it. ===
{{MEMORY}}
=== END ALREADY REMEMBERED ===

=== THE CONVERSATION - this is the only thing you are summarising ===
{{TRANSCRIPT}}
=== END THE CONVERSATION ===

Write what this conversation revealed about the user and their work: decisions made, preferences stated, facts about them or their projects, and threads left open. Refer to them as "the user". Short plain prose or bullets.

Rules:
- Write facts only. Never write about the conversation itself, about what was or was not new, or about the task you were given. A line like "no new information was shared" is not a memory and must not appear in your answer.
- Do not repeat anything in the ALREADY REMEMBERED block, including anything the assistant restated during the conversation.
- Leave out pleasantries and anything a model would know without this conversation.
- If this conversation revealed nothing worth remembering, reply with exactly: ${NOTHING_NEW}`;

/*
 * Reference material -> memory. A different job from summarising a
 * conversation, and the wrong template for it produces the wrong memory:
 * asked to summarise a chat in which a document was pasted, a model writes
 * about the exchange - what was shown, what it asked in return - rather than
 * about the subject.
 *
 * Reads {{SOURCE}}, which is the human's turns only, so the model's own
 * replies and clarifying questions are not in front of it to be mistaken for
 * facts about the material.
 */
export const DEFAULT_DISTIL_TEMPLATE = `You are writing a reference memory for an assistant persona: a durable, compact account of the material below, which the persona should carry into later conversations.

=== ALREADY REMEMBERED - reference only. Do not copy from this block, do not summarise it, do not mention it. ===
{{MEMORY}}
=== END ALREADY REMEMBERED ===

=== THE MATERIAL - this is the only thing you are distilling ===
{{SOURCE}}
=== END THE MATERIAL ===

Write what is worth remembering about the SUBJECT of this material: what it is, what it does, and the decisions and constraints that shape it. Prefer specifics that would be hard to reconstruct - names, numbers, deliberate non-goals - over generalities.

Rules:
- Write facts only. Never write about the material as a document ("this text explains..."), never mention that it was provided, and never write about what was or was not new.
- Do not repeat anything in the ALREADY REMEMBERED block.
- If the material adds nothing worth remembering, reply with exactly: ${NOTHING_NEW}`;

/*
 * Many memories -> one. Lossy by nature, which is why it is a button and not
 * a policy: the person decides when the list has grown past what their
 * smallest model's window can carry, reads the result, and replaces the list
 * only if they agree with it.
 */
export const DEFAULT_COMPACT_TEMPLATE = `You are compacting an assistant persona's memory: several dated summaries of earlier conversations that together have grown too long.

{{MEMORY}}

Rewrite them as ONE memory that keeps every decision, preference, fact and open thread still worth knowing, merges duplicates, and drops anything a later entry superseded. Keep dates where they matter. Be shorter than the input. Add nothing that is not in it.`;
