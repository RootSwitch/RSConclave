// Plain 1:1 chat. The simplest mode: no speaker labels, no turn order -
// just the transcript mapped straight onto user/assistant roles.
import type { ChatConfig, ChatMessage, Persona, TranscriptEntry } from './types.ts';
import { isFinishedTurn, stripThink } from './text.ts';

export function buildSystemPrompt(config: ChatConfig, personas: Persona[]): string {
  const layers: string[] = [];
  const persona = config.personaId ? personas.find((p) => p.id === config.personaId) : undefined;
  if (persona?.systemPrompt.trim()) layers.push(persona.systemPrompt.trim());
  if (config.systemPrompt?.trim()) layers.push(config.systemPrompt.trim());
  return layers.join('\n\n');
}

export function buildChatMessages(
  config: ChatConfig,
  entries: TranscriptEntry[],
  personas: Persona[],
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const system = buildSystemPrompt(config, personas);
  if (system) messages.push({ role: 'system', content: system });

  for (const e of entries) {
    if (!isFinishedTurn(e)) continue; // see isFinishedTurn: cancelled partials are not turns
    const text = e.kind === 'user' ? e.text : stripThink(e.text);
    // merge consecutive same-role turns so roles strictly alternate
    const role = e.kind === 'user' ? 'user' : 'assistant';
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content += '\n\n' + text;
    else messages.push({ role, content: text });
  }
  return messages;
}
