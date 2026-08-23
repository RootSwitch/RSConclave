// Session → readable markdown.
import type { ChatConfig, CouncilConfig, PipelineConfig, RoundtableConfig, Session } from './types.ts';
import { tallyBallot, tallyToMarkdown } from './vote.ts';

/*
 * Close a code fence the model left open.
 *
 * Entry text went into the document raw, so one unbalanced ``` in any reply
 * swallowed everything after it into a code block when rendered - the rest of
 * that answer, every later turn, the whole tail of the export.
 */
function balanceFences(text: string): string {
  const fences = text.match(/^[ \t]*```/gm)?.length ?? 0;
  return fences % 2 === 0 ? text : text + '\n```';
}

/*
 * Split reasoning out of an entry so it can be shown as such.
 *
 * <think> blocks were exported verbatim, and a markdown renderer treats them as
 * an unknown HTML tag: the reasoning DISAPPEARS in rendered output, or bleeds
 * into the answer with no delimiter in raw text. A blockquote is visible in both
 * and needs no HTML.
 */
function splitThinking(text: string): { thinking: string[]; body: string } {
  const thinking: string[] = [];
  const body = text
    .replace(/<think>([\s\S]*?)(?:<\/think>|$)/g, (_m, t: string) => {
      if (t.trim()) thinking.push(t.trim());
      return '';
    })
    .trim();
  return { thinking, body };
}

export function sessionToMarkdown(session: Session): string {
  const lines: string[] = [];
  lines.push(`# ${session.title}`);
  lines.push('');
  lines.push(`- Mode: ${session.mode}`);
  lines.push(`- Created: ${session.createdAt}`);
  lines.push(`- Status: ${session.status}`);
  if (session.tags?.length) lines.push(`- Tags: ${session.tags.join(', ')}`);
  // Provenance, so a forked transcript is not mistaken for the whole story.
  if (session.forkedFrom) {
    lines.push(`- Forked from: ${session.forkedFrom.title} (at entry ${session.forkedFrom.entryId})`);
  }
  lines.push('');

  if (session.mode === 'council') {
    const c = session.config as CouncilConfig;
    lines.push(`Members: ${c.members.map((m) => m.model).join(', ')}`);
    lines.push(`Consolidator: ${c.consolidator.model}`);
    if (c.ballot?.length) {
      lines.push('');
      lines.push(tallyToMarkdown(tallyBallot(c.ballot, session.entries)).trimEnd());
    }
  } else if (session.mode === 'chat') {
    const c = session.config as ChatConfig;
    lines.push(`Model: ${c.model}`);
    if (c.systemPrompt?.trim()) {
      lines.push('');
      lines.push('## System prompt');
      lines.push('');
      lines.push(c.systemPrompt.trim());
    }
  } else if (session.mode === 'pipeline') {
    const c = session.config as PipelineConfig;
    lines.push(`Stages: ${c.stages.map((s, i) => `${i + 1}. ${s.name?.trim() || s.model}`).join(' → ')}`);
  } else {
    const c = session.config as RoundtableConfig;
    lines.push(`Participants: ${c.participants.map((p) => `${p.name} (${p.model})`).join(', ')}`);
    if (c.scenario.trim()) {
      lines.push('');
      lines.push('## Scenario');
      lines.push('');
      lines.push(c.scenario.trim());
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const e of session.entries) {
    const label =
      e.kind === 'consolidation'
        // In a chat the consolidation is a summary written for memory; the
        // word "consolidation" there would send a reader looking for members.
        ? `${session.mode === 'chat' ? 'Summary' : 'Consolidation'} - ${e.speaker}`
        : e.model && e.speaker !== e.model
          ? `${e.speaker} (${e.model})`
          : e.speaker;
    lines.push(`### ${label}`);
    if (e.kind === 'error') lines.push(`> ⚠ error: ${e.error ?? 'unknown'}`);
    // Marked for the same reason the UI marks it: an incomplete turn read as a
    // finished one in an exported transcript, with nothing to say otherwise.
    else if (e.error === 'cancelled') lines.push('> ⚠ stopped part-way - this turn is incomplete');
    lines.push('');
    // A person's own words are never reasoning output; leave them exactly as
    // typed, tags and all.
    const { thinking, body } = e.kind === 'user'
      ? { thinking: [] as string[], body: e.text.trim() }
      : splitThinking(e.text);
    for (const t of thinking) {
      lines.push('> **reasoning**');
      for (const l of t.split('\n')) lines.push(('> ' + l).trimEnd());
      lines.push('');
    }
    lines.push(balanceFences(body));
    lines.push('');
  }
  return lines.join('\n');
}
