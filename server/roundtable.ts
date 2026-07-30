// Roundtable mode: turn order and the multi-party → 2-role message mapping.
import type {
  ChatMessage,
  Participant,
  Persona,
  RoundtableConfig,
  TranscriptEntry,
} from './types.ts';
import { estimateMessages } from './tokens.ts';
import { stripThink } from './text.ts';

/** Round-robin: next participant after the one who spoke last (or the first). */
export function nextSpeaker(config: RoundtableConfig, entries: TranscriptEntry[]): Participant {
  const parts = config.participants;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === 'participant' && e.participantId) {
      const idx = parts.findIndex((p) => p.id === e.participantId);
      if (idx >= 0) return parts[(idx + 1) % parts.length];
    }
  }
  return parts[0];
}

/** Layered system prompt: framing preamble + persona base + overlay + scenario. */
export function buildSystemPrompt(
  p: Participant,
  config: RoundtableConfig,
  personas: Persona[],
): string {
  const others = config.participants.filter((x) => x.id !== p.id).map((x) => x.name);
  const layers: string[] = [];
  layers.push(
    `You are ${p.name} in a multi-party roundtable conversation.` +
      (others.length ? ` Other participants: ${others.join(', ')}.` : '') +
      ` Messages from others appear as "[Name]: text".` +
      ` Respond ONLY as ${p.name}. Do not write dialogue for other participants.` +
      ` Do not prefix your reply with your own name.`,
  );
  const persona = p.personaId ? personas.find((x) => x.id === p.personaId) : undefined;
  if (persona?.systemPrompt.trim()) layers.push(persona.systemPrompt.trim());
  if (p.overlayPrompt?.trim()) layers.push(p.overlayPrompt.trim());
  if (config.scenario.trim()) layers.push(`SCENARIO:\n${config.scenario.trim()}`);
  return layers.join('\n\n');
}

/**
 * Map the shared transcript into the 2-role chat format for participant P:
 * P's own messages → assistant (raw); everyone else → user, prefixed "[Speaker]: ".
 * Consecutive same-role messages are merged so roles strictly alternate.
 */
export function buildMessages(
  p: Participant,
  config: RoundtableConfig,
  entries: TranscriptEntry[],
  personas: Persona[],
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt(p, config, personas) }];

  // Consolidation/judge entries are meta-commentary, not conversation turns.
  let usable = entries.filter(
    (e) => e.kind !== 'error' && e.kind !== 'consolidation' && stripThink(e.text) !== '',
  );

  // Truncation: keep-last-N window (system prompt always kept).
  let truncated = false;
  if (config.keepLastTurns && config.keepLastTurns > 0 && usable.length > config.keepLastTurns) {
    usable = usable.slice(usable.length - config.keepLastTurns);
    truncated = true;
  }

  const body: ChatMessage[] = [];
  for (const e of usable) {
    if (e.kind === 'participant' && e.participantId === p.id) {
      pushMerged(body, 'assistant', stripThink(e.text));
    } else {
      const name = e.kind === 'narrator' ? 'Narrator' : e.kind === 'user' ? 'User' : e.speaker;
      pushMerged(body, 'user', `[${name}]: ${stripThink(e.text)}`);
    }
  }
  if (truncated) {
    const note = '[Moderator]: (earlier conversation truncated)';
    if (body.length && body[0].role === 'user') body[0].content = note + '\n\n' + body[0].content;
    else body.unshift({ role: 'user', content: note });
  }

  // The model must be responding to a user turn.
  if (!body.length || body[body.length - 1].role !== 'user') {
    body.push({ role: 'user', content: '[Moderator]: Continue.' });
  }

  messages.push(...body);
  return messages;
}

function pushMerged(list: ChatMessage[], role: 'user' | 'assistant', text: string): void {
  const last = list[list.length - 1];
  if (last && last.role === role) last.content += '\n\n' + text;
  else list.push({ role, content: text });
}

/** Strip a self-prefixed "Name:" / "[Name]:" the model may add despite instructions. */
export function stripSelfPrefix(name: string, text: string): string {
  // Match the CORE of the name with brackets optional around it. For a seat
  // literally named "[Bot]" the old pattern already stripped "[Bot]:" (the
  // optional \[? matched empty) - what slipped through was the model writing
  // the de-bracketed "Bot:". So the name's own brackets come off first, and
  // the optional ones around the pattern cover both spellings.
  const core = name.replace(/^\[+|\]+$/g, '') || name;
  const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`^\\s*\\[?${escaped}\\]?\\s*:\\s*`, 'i'), '');
}

export function estimateContext(messages: ChatMessage[]): number {
  return estimateMessages(messages);
}
