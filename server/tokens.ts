// Rough token estimation (~4 chars/token) for context budgeting.
import type { ChatMessage } from './types.ts';

export function estimate(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessages(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimate(m.content) + 4; // small per-message overhead
  return total;
}

export const OLLAMA_DEFAULT_NUM_CTX = 4096; // server default when the Modelfile sets nothing

/** Uncapped: >100 means Ollama will silently truncate from the front. */
export function contextPct(messages: ChatMessage[], numCtx: number | undefined): number {
  const ctx = numCtx && numCtx > 0 ? numCtx : OLLAMA_DEFAULT_NUM_CTX;
  return Math.round((estimateMessages(messages) / ctx) * 100);
}
