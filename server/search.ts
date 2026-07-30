// Session search: case-insensitive substring over titles, transcripts and
// the text a user typed into a setup (scenario, prompts, overlays,
// templates). Plain linear scan - at personal-archive scale (hundreds of
// sessions) this is milliseconds, and it keeps the app zero-dependency.
import type { Session } from './types.ts';

export interface SearchHit {
  speaker: string; // entry speaker, or "title" / "setup"
  snippet: string; // match with surrounding context, whitespace-collapsed
}

export interface SearchResult {
  id: string;
  title: string;
  mode: Session['mode'];
  updatedAt: string;
  hits: SearchHit[]; // capped per session; total says how many really matched
  total: number;
}

const SNIPPET_RADIUS = 45;
const HITS_PER_SESSION = 3;
const MAX_SESSIONS = 50;

function snippet(text: string, idx: number, qLen: number): string {
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + qLen + SNIPPET_RADIUS);
  return (start > 0 ? '…' : '') +
    text.slice(start, end).replace(/\s+/g, ' ').trim() +
    (end < text.length ? '…' : '');
}

/** The human-entered text fields of any mode's config, flattened. */
function configText(config: any): string {
  const parts: string[] = [];
  for (const key of ['prompt', 'scenario', 'input', 'systemPrompt']) {
    if (typeof config?.[key] === 'string') parts.push(config[key]);
  }
  for (const p of config?.participants ?? []) {
    if (p?.name) parts.push(p.name);
    if (p?.overlayPrompt) parts.push(p.overlayPrompt);
  }
  for (const s of config?.stages ?? []) {
    if (s?.name) parts.push(s.name);
    if (s?.template) parts.push(s.template);
  }
  if (config?.consolidator?.template) parts.push(config.consolidator.template);
  return parts.join('\n');
}

export function searchSessions(sessions: Session[], query: string): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const results: SearchResult[] = [];

  for (const s of sessions) {
    const hits: SearchHit[] = [];
    let total = 0;
    const consider = (speaker: string, text: string) => {
      const idx = text.toLowerCase().indexOf(q);
      if (idx === -1) return;
      total++;
      if (hits.length < HITS_PER_SESSION) hits.push({ speaker, snippet: snippet(text, idx, q.length) });
    };
    consider('title', s.title);
    if (s.tags?.length) consider('tags', s.tags.join(' '));
    consider('setup', configText(s.config));
    for (const e of s.entries) consider(e.speaker, e.text);
    if (total > 0) {
      results.push({ id: s.id, title: s.title, mode: s.mode, updatedAt: s.updatedAt, hits, total });
    }
  }

  results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return results.slice(0, MAX_SESSIONS);
}
