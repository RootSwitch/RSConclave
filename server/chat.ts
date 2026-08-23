// Plain 1:1 chat. The simplest mode: no speaker labels, no turn order -
// just the transcript mapped straight onto user/assistant roles.
import type { ChatConfig, ChatMessage, Persona, TranscriptEntry } from './types.ts';
import { isFinishedTurn, stripThink } from './text.ts';
import { renderMemoryLayer } from './memory.ts';

export function buildSystemPrompt(config: ChatConfig, personas: Persona[]): string {
  const layers: string[] = [];
  const persona = config.personaId ? personas.find((p) => p.id === config.personaId) : undefined;
  if (persona?.systemPrompt.trim()) layers.push(persona.systemPrompt.trim());
  // Who the persona is, then what it remembers, then this session's own
  // instructions - so a per-chat system prompt can still override a memory.
  if (persona) {
    const memory = renderMemoryLayer(persona);
    if (memory) layers.push(memory);
  }
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
    // A summary written over the chat is about the conversation, not part of
    // it. Sent as an assistant turn it would be the model's most recent words
    // - and the next reply would pick up from the summary, not the chat.
    if (e.kind === 'consolidation') continue;
    const text = e.kind === 'user' ? e.text : stripThink(e.text);
    // merge consecutive same-role turns so roles strictly alternate
    const role = e.kind === 'user' ? 'user' : 'assistant';
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content += '\n\n' + text;
    else messages.push({ role, content: text });
  }
  return messages;
}
