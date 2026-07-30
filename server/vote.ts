// Council ballot mode: tally which option each member landed on.
//
// Pure and separate from the engine so it can be tested against the awkward
// real-world shapes directly. Models do not answer ballots cleanly: they add
// preamble, restate the question, bold the answer, or pick an option whose text
// happens to contain another option's text. All of that is handled here.
import type { TranscriptEntry } from './types.ts';

export interface Tally {
  option: string;
  count: number;
  voters: string[]; // model names, in the order they voted
}

export interface BallotResult {
  tallies: Tally[];
  /** Members whose answer matched no option, or who errored out. */
  undecided: string[];
  votesCast: number;
}

/**
 * Which option did this text vote for?
 *
 * Read from the END backwards, because the instruction asks members to finish
 * with their choice and a model that reasons out loud will mention several
 * options along the way. The last mention is the conclusion; an earlier one is
 * usually "it could be A, but...".
 *
 * Longest option first, so when one option's text contains another's ("Yes" vs
 * "Yes, with conditions") the more specific answer wins rather than whichever
 * happens to appear earlier in the list.
 */
/*
 * Whole-word matcher for one option.
 *
 * Plain substring matching is not usable here, and not for an exotic reason:
 * the option "No" appears inside "not", "nothing", "know" and "cannot", so
 * "I would rather not commit" counted as a vote for No. Boundaries are only
 * added at ends that are word characters, so an option like "+1" or "(a)"
 * still matches.
 */
function optionMatcher(option: string): RegExp | null {
  const trimmed = option.trim();
  if (!trimmed) return null;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lead = /^\w/.test(trimmed) ? '\\b' : '';
  const trail = /\w$/.test(trimmed) ? '\\b' : '';
  return new RegExp(lead + escaped + trail, 'gi');
}

export function pickOption(text: string, options: string[]): string | null {
  if (!text?.trim()) return null;
  // Longest first, so on an equal position the more specific option is already
  // the incumbent and a shorter substring of it cannot displace it.
  const ranked = [...options].sort((a, b) => b.length - a.length);
  let best: { option: string; at: number } | null = null;
  for (const option of ranked) {
    const re = optionMatcher(option);
    if (!re) continue;
    let at = -1;
    for (const m of text.matchAll(re)) at = m.index ?? at;
    if (at === -1) continue;
    if (!best || at > best.at) best = { option, at };
  }
  return best ? best.option : null;
}

export function tallyBallot(options: string[], entries: TranscriptEntry[]): BallotResult {
  const tallies: Tally[] = options.map((option) => ({ option, count: 0, voters: [] }));
  const undecided: string[] = [];
  let votesCast = 0;

  for (const e of entries) {
    // Council members only: skip the prompt, the consolidation and the errors.
    if (e.kind !== 'participant') continue;
    if (e.memberIndex === undefined || e.memberIndex < 0) continue;
    const who = e.model || e.speaker;
    if (e.error) {
      undecided.push(who);
      continue;
    }
    const choice = pickOption(e.text, options);
    if (!choice) {
      undecided.push(who);
      continue;
    }
    const row = tallies.find((t) => t.option === choice);
    if (row) {
      row.count++;
      row.voters.push(who);
      votesCast++;
    }
  }
  return { tallies, undecided, votesCast };
}

/** The instruction appended to each member's prompt in ballot mode. */
export function ballotInstruction(options: string[]): string {
  return (
    `\n\nAnswer in prose first, then finish with a single final line of exactly ` +
    `one of these options and nothing else:\n` +
    options.map((o) => `- ${o}`).join('\n')
  );
}

/** Markdown block for exports; empty string when there is nothing to show. */
export function tallyToMarkdown(result: BallotResult): string {
  if (!result.tallies.some((t) => t.count > 0) && !result.undecided.length) return '';
  const lines = ['## Ballot', ''];
  for (const t of result.tallies) {
    lines.push(`- **${t.option}** - ${t.count}${t.voters.length ? ` (${t.voters.join(', ')})` : ''}`);
  }
  if (result.undecided.length) {
    lines.push(`- _no clear answer_ - ${result.undecided.length} (${result.undecided.join(', ')})`);
  }
  lines.push('');
  return lines.join('\n');
}
