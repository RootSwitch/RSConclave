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

export interface Persona {
  id: string;
  name: string;
  systemPrompt: string;
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
 * itself against a rule and cannot check itself against a mood. Skeptic and
 * Advocate are a deliberate pair: assigning opposing stances is what makes a
 * roundtable argue instead of politely converging on the first answer.
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
