// Persona memory: what a persona has been told it remembers, rendered for a
// prompt. Deliberately dumb - a dated list, no retrieval, no ranking. The
// entries carry enough provenance (date, model, source session) that a
// smarter store could be built over them later without rewriting what they
// hold; for now the list is small enough to read, and reading it is the point.
import type { MemoryEntry, Persona } from './types.ts';
import { estimate } from './tokens.ts';

function dateOf(m: MemoryEntry): string {
  // The day is what matters in a memory; the time is noise.
  return m.at.slice(0, 10);
}

/** The entries as dated paragraphs, no framing. For templates ({{MEMORY}}). */
export function renderMemoryPlain(persona: Pick<Persona, 'memories'>): string {
  return (persona.memories ?? [])
    .map((m) => `[${dateOf(m)}] ${m.text.trim()}`)
    .filter((s) => s.length > 13) // more than just the date
    .join('\n\n');
}

/*
 * The system-prompt layer. The framing is not decoration: handed a bare list
 * of summaries, a model treats it either as instructions to follow or as the
 * conversation in progress. Saying what it is - remembered, summarised, maybe
 * incomplete - is what makes the model use it the way a person uses memory.
 */
export function renderMemoryLayer(persona: Pick<Persona, 'memories'>): string {
  const body = renderMemoryPlain(persona);
  if (!body) return '';
  return (
    'Things you remember from earlier conversations with this user. These are ' +
    'summaries written after each conversation, not verbatim records, and may be ' +
    'incomplete:\n\n' +
    body
  );
}

/** Rough size of the memory layer, for the "is this getting big" display. */
export function memoryTokens(persona: Pick<Persona, 'memories'>): number {
  const layer = renderMemoryLayer(persona);
  return layer ? estimate(layer) : 0;
}
