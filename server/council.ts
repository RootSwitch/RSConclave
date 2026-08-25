// Council mode: transcript assembly and consolidator prompt templating.
import type { ChatMessage, CouncilConfig, CouncilMember, Persona, TranscriptEntry } from './types.ts';
import { incompleteNote, isFinishedTurn, stripThink } from './text.ts';
import { ballotInstruction } from './vote.ts';
import { renderMemoryLayer } from './memory.ts';

/**
 * A member's standing instructions: its persona, and whatever that persona
 * remembers. Same layering and the same order as chat and roundtable, so one
 * persona behaves the same wherever it is seated.
 *
 * Empty for a member with no persona, which is every member unless you say
 * otherwise - a council's default is still the bare prompt.
 */
export function buildMemberSystemPrompt(member: CouncilMember, personas: Persona[]): string {
  const persona = member.personaId ? personas.find((p) => p.id === member.personaId) : undefined;
  if (!persona) return '';
  const layers: string[] = [];
  if (persona.systemPrompt.trim()) layers.push(persona.systemPrompt.trim());
  const memory = renderMemoryLayer(persona);
  if (memory) layers.push(memory);
  return layers.join('\n\n');
}

/**
 * Render the {{RESPONSES}} block from completed member entries.
 * Errored/empty members are noted so the consolidator knows they're missing.
 */
export function renderResponses(config: CouncilConfig, entries: TranscriptEntry[]): string {
  const blocks: string[] = [];
  for (let i = 0; i < config.members.length; i++) {
    const m = config.members[i];
    const entry = entries.filter((e) => e.memberIndex === i).at(-1);
    /*
     * Judge emptiness on the ANSWER, not on the raw text.
     *
     * A reasoning model given a small output cap can spend the entire budget
     * inside <think>, close the tag, and stop with no prose at all. The raw
     * entry is then hundreds of characters long and passes any "did it say
     * something" test, while the part anyone can read is empty - so the
     * consolidator was handed a labelled block containing nothing and asked to
     * summarise it, which it duly did. Observed with a 120-token cap on a live
     * reasoning model; every other emptiness test in the codebase already
     * strips think first (see isFinishedTurn), and this one was missed.
     */
    const answer = entry ? stripThink(entry.text).trim() : '';
    /*
     * A skipped member is reported as skipped even when it had produced
     * something. Skip means "I do not want this one" - handing its half-answer
     * to the consolidator anyway would weigh an opinion the user rejected. The
     * text stays in the transcript to read or copy; it just does not vote.
     */
    if (entry?.error === 'skipped') {
      blocks.push(`=== RESPONSE FROM: ${m.model} ===
(skipped)
=== END RESPONSE ===`);
      continue;
    }
    if (entry && entry.kind !== 'error' && answer) {
      // Labelled format, so a cancelled partial is included and marked rather
      // than reported as "no response" for text the user can see on screen.
      blocks.push(`=== RESPONSE FROM: ${m.model}${incompleteNote(entry)} ===\n${answer}\n=== END RESPONSE ===`);
    } else {
      // Say which kind of nothing it was: "it thought and never answered" is a
      // cap to raise, "it errored" is something else entirely.
      const why = entry && entry.kind !== 'error' && entry.text.trim()
        ? '(no answer - the model used its whole output budget reasoning)'
        : '(no response - error)';
      blocks.push(`=== RESPONSE FROM: ${m.model} ===\n${why}\n=== END RESPONSE ===`);
    }
  }
  return blocks.join('\n\n');
}

export function renderTemplate(template: string, prompt: string, responses: string): string {
  // Function replacements: see renderStagePrompt. Model responses full of code
  // are the NORMAL case for a consolidator, so a "$&" in any member's answer
  // would otherwise corrupt the synthesis prompt silently.
  return template
    .replaceAll('{{PROMPT}}', () => prompt)
    .replaceAll('{{RESPONSES}}', () => responses);
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
  systemPrompt?: string,
): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  // Ahead of the history, as everywhere else. Absent for a member with no
  // persona, so the default council behaviour - the bare prompt, nothing to
  // make one member's answer incomparable with another's - is unchanged.
  if (systemPrompt?.trim()) msgs.push({ role: 'system', content: systemPrompt.trim() });
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
    } else if (e.kind === 'participant' && e.memberIndex === memberIndex && isFinishedTurn(e)) {
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
