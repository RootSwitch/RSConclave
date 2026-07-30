// Council mode: transcript assembly and consolidator prompt templating.
import type { ChatMessage, CouncilConfig, TranscriptEntry } from './types.ts';
import { stripThink } from './text.ts';
import { ballotInstruction } from './vote.ts';

/**
 * Render the {{RESPONSES}} block from completed member entries.
 * Errored/empty members are noted so the consolidator knows they're missing.
 */
export function renderResponses(config: CouncilConfig, entries: TranscriptEntry[]): string {
  const blocks: string[] = [];
  for (let i = 0; i < config.members.length; i++) {
    const m = config.members[i];
    const entry = entries.filter((e) => e.memberIndex === i).at(-1);
    if (entry && entry.kind !== 'error' && entry.text.trim()) {
      blocks.push(`=== RESPONSE FROM: ${m.model} ===\n${stripThink(entry.text)}\n=== END RESPONSE ===`);
    } else {
      blocks.push(`=== RESPONSE FROM: ${m.model} ===\n(no response - error)\n=== END RESPONSE ===`);
    }
  }
  return blocks.join('\n\n');
}

export function renderTemplate(template: string, prompt: string, responses: string): string {
  return template.replaceAll('{{PROMPT}}', prompt).replaceAll('{{RESPONSES}}', responses);
}

export function buildConsolidatorPrompt(
  config: CouncilConfig,
  entries: TranscriptEntry[],
  template?: string,
  promptOverride?: string,
): string {
  return renderTemplate(
    template ?? config.consolidator.template,
    promptOverride ?? config.prompt,
    renderResponses(config, entries),
  );
}

/** All user prompts (original + follow-ups) joined, for the consolidator's {{PROMPT}}. */
export function joinedPrompts(entries: TranscriptEntry[]): string {
  const prompts = entries.filter((e) => e.kind === 'user').map((e) => e.text.trim());
  if (prompts.length <= 1) return prompts[0] ?? '';
  return prompts[0] + prompts.slice(1).map((p) => `\n\nFOLLOW-UP:\n${p}`).join('');
}

/**
 * Chat history for one member across rounds: each user prompt as a user message,
 * followed by that member's latest good response in the round (assistant).
 * Ends with the latest user prompt awaiting a response.
 */
export function buildMemberHistory(
  entries: TranscriptEntry[],
  memberIndex: number,
  ballot?: string[],
): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  let pendingResponse: string | null = null;
  const flush = () => {
    if (pendingResponse !== null) {
      msgs.push({ role: 'assistant', content: stripThink(pendingResponse) });
      pendingResponse = null;
    }
  };
  for (const e of entries) {
    if (e.kind === 'user') {
      flush();
      msgs.push({ role: 'user', content: e.text });
    } else if (e.kind === 'participant' && e.memberIndex === memberIndex && !e.error && e.text.trim()) {
      pendingResponse = e.text; // last one in the round wins (reruns)
    }
  }
  // pendingResponse after the final user prompt is intentionally dropped -
  // the member is about to (re)answer that prompt.

  /*
   * In ballot mode the instruction rides on the LAST user message rather than a
   * system message. Two reasons: a member's history may already carry rounds of
   * its own answers, and instructions that arrive as a system prompt are the
   * first thing dropped when Ollama truncates an overlong prompt from the front.
   * Attached to the live question, it survives as long as the question does.
   */
  if (ballot?.length) {
    const lastUser = msgs.filter((m) => m.role === 'user').at(-1);
    if (lastUser) lastUser.content += ballotInstruction(ballot);
  }
  return msgs;
}
