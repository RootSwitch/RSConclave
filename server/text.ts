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

/*
 * Can this entry be handed to a model as a finished turn?
 *
 * The rule used to be written out separately in six places and disagreed with
 * itself in three of them: a cancelled partial was context in the roundtable and
 * in the council's consolidator, but not in chat, council follow-ups or a
 * pipeline stage - while the UI labelled it "partial output kept" everywhere. It
 * lives here now so all six read the same answer.
 *
 * A cancelled generation is a fragment, often mid-sentence and sometimes
 * mid-word. As a plain assistant message it is indistinguishable from a
 * considered answer, so it is left out of every conversational history. The two
 * places that render a LABELLED transcript (the council's {{RESPONSES}} block
 * and the judge transcript) include it and mark it incomplete instead - the
 * format can say what it is, and the text is real content the reader can see.
 *
 * Errors are out either way: kind === 'error' entries carry a failure message
 * rather than model output.
 */
export function isFinishedTurn(e: TranscriptEntry): boolean {
  if (e.kind === 'error' || e.error) return false;
  // User text is never think-stripped for content, so do not strip it here
  // either - "<think>x</think>" typed by a person is a real message.
  const body = e.kind === 'user' ? e.text : stripThink(e.text);
  return body.trim() !== '';
}

/** Speaker-label suffix marking a turn that was cut short; '' for a clean one. */
export function incompleteNote(e: TranscriptEntry): string {
  if (e.error === 'cancelled') return ' (INCOMPLETE - CANCELLED PART-WAY)';
  // A dropped stream leaves a turn just as unfinished as a cancelled one, and
  // a consolidator reading it deserves to know it is judging half an answer.
  //
  // Truncation alone is enough - requiring an error too silently exempted the
  // commonest case of all. A turn that hits its output cap sets truncated and
  // no error (nothing went wrong, it just ran out of budget), so it reached
  // the consolidator labelled as a finished answer and got weighed as one.
  if (e.truncated) return ' (INCOMPLETE - CUT OFF PART-WAY)';
  return '';
}

/*
 * Fill {{KEY}} placeholders. Function replacement throughout, because the
 * values are transcripts and memories - the most $-laden text in the app,
 * and String.replace treats $& and $1 in a replacement STRING as patterns.
 */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, () => value);
  }
  return out;
}

/** Render a roundtable transcript as plain labeled text for judging/consolidation. */
export function renderTranscriptText(entries: TranscriptEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    if (e.kind === 'error' || e.kind === 'consolidation') continue;
    const body = stripThink(e.text);
    if (!body) continue;
    // Labelled format, so a cancelled partial rides along marked rather than
    // being dropped - a judge asked to summarise what was said should see it.
    lines.push(`[${e.speaker}${incompleteNote(e)}]: ${body}`);
  }
  return lines.join('\n\n');
}
