// Session → readable markdown.
import type { ChatConfig, CouncilConfig, PipelineConfig, RoundtableConfig, Session } from './types.ts';
import { tallyBallot, tallyToMarkdown } from './vote.ts';

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
        ? `Consolidation - ${e.speaker}`
        : e.model && e.speaker !== e.model
          ? `${e.speaker} (${e.model})`
          : e.speaker;
    lines.push(`### ${label}`);
    if (e.kind === 'error') lines.push(`> ⚠ error: ${e.error ?? 'unknown'}`);
    lines.push('');
    lines.push(e.text.trim());
    lines.push('');
  }
  return lines.join('\n');
}
