// Persona memory: what a persona has been told it remembers, rendered for a
// prompt. Deliberately dumb - a dated list, no retrieval, no ranking. The
// entries carry enough provenance (date, model, source session) that a
// smarter store could be built over them later without rewriting what they
// hold; for now the list is small enough to read, and reading it is the point.
import type { MemoryEntry, Persona } from './types.ts';
import { NOTHING_NEW } from './types.ts';
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

/*
 * Did the summariser say there was nothing worth remembering?
 *
 * Lenient about what surrounds the sentinel, because models rarely answer with
 * a bare token - they add a full stop, or a sentence explaining themselves.
 * Bounded by length so a real memory that happens to contain the words is not
 * thrown away.
 */
export function isNothingNew(text: string): boolean {
  const t = text.trim();
  return t.length <= 120 && new RegExp(NOTHING_NEW, 'i').test(t);
}

/*
 * How much of `a` is already present in `b`, 0..1, by shared words.
 *
 * Containment rather than Jaccard: the failure this catches is a summariser
 * regurgitating an existing memory, sometimes with a few words added, and
 * containment scores that high where a symmetric measure would be dragged
 * down by the additions. Crude on purpose - it only has to be good enough to
 * ask "are you sure", and a measure someone can predict in their head is
 * worth more here than a better one they cannot.
 */
const STOPWORDS = new Set([
  // Ordinary English glue, plus the words every memory in this app opens with.
  // Without these the measure is dominated by phrasing rather than subject:
  // "The user runs MobaXTerm on Windows" scored 0.8 against an unrelated
  // memory about sim racing, on the strength of "the user runs windows".
  'the', 'and', 'for', 'with', 'that', 'this', 'they', 'their', 'them', 'from', 'into',
  'are', 'was', 'were', 'has', 'have', 'had', 'not', 'but', 'all', 'can', 'its',
  'use', 'uses', 'using', 'used', 'user', 'about', 'when', 'where', 'which', 'while',
  'would', 'could', 'should', 'also', 'more', 'than', 'then', 'there', 'these', 'those',
  'some', 'any', 'one', 'two', 'out', 'over', 'under', 'after', 'before', 'only', 'just',
  'like', 'other', 'same', 'such', 'both', 'each', 'many', 'most', 'much', 'very',
  'still', 'being', 'been', 'does', 'did', 'doing', 'make', 'made', 'run', 'runs',
  'get', 'got', 'want', 'wants', 'new', 'via', 'per', 'own', 'set', 'way', 'well',
]);

/** Distinctive words only: what a text is ABOUT, not how it is phrased. */
function subjectWords(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
    if (!STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

/** Below this many distinctive words, a text is too short to judge against. */
const MIN_SUBJECT_WORDS = 6;

export function overlap(a: string, b: string): number {
  const A = subjectWords(a);
  const B = subjectWords(b);
  // A one-line memory is contained in almost any longer text by coincidence,
  // so refuse to judge rather than report a number that is mostly noise.
  if (Math.min(A.size, B.size) < MIN_SUBJECT_WORDS) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

/** Above this, saving asks for confirmation instead of just doing it. */
export const DUPLICATE_OVERLAP = 0.8;

/** The existing memory a new one most resembles, if any is close enough. */
export function findNearDuplicate(
  persona: Pick<Persona, 'memories'>,
  text: string,
): { entry: MemoryEntry; score: number } | null {
  let best: { entry: MemoryEntry; score: number } | null = null;
  for (const m of persona.memories ?? []) {
    const score = overlap(text, m.text);
    if (score >= DUPLICATE_OVERLAP && (!best || score > best.score)) best = { entry: m, score };
  }
  return best;
}
