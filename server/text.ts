// Text utilities shared by modes.
import type { TranscriptEntry } from './types.ts';

/**
 * Remove <think>…</think> reasoning blocks (deepseek-r1 style) so they don't
 * pollute downstream context. Handles an unclosed block (stream cut mid-think).
 */
export function stripThink(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/g, '')
    .trim();
}

/** Render a roundtable transcript as plain labeled text for judging/consolidation. */
export function renderTranscriptText(entries: TranscriptEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    if (e.kind === 'error' || e.kind === 'consolidation') continue;
    const body = stripThink(e.text);
    if (!body) continue;
    lines.push(`[${e.speaker}]: ${body}`);
  }
  return lines.join('\n\n');
}
