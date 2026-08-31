// Session → readable markdown.
import { safeName } from './zip.ts';
import type { ChatConfig, CouncilConfig, Persona, PipelineConfig, RoundtableConfig, Session } from './types.ts';
import { tallyBallot, tallyToMarkdown } from './vote.ts';
import { buildSystemPrompt } from './chat.ts';

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

/*
 * `reasoning: false` drops <think> blocks from the output.
 *
 * Not a size optimisation. Reasoning is the model talking to itself, and when
 * an export is being fed to another model it is context spent on deliberation
 * that already reached its conclusion in the text below it. Kept by default,
 * because when a person is the reader the reasoning is often the interesting
 * part.
 */
export interface ExportOptions {
  reasoning?: boolean;
}

export function sessionToMarkdown(
  session: Session, personas: Persona[] = [], opts: ExportOptions = {},
): string {
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
    /*
     * What HAPPENED, not what was configured. The consolidator is recorded on
     * every council even when consolidation is switched off, because the
     * session view can still run it later - so printing it unconditionally
     * announced a synthesis that was never written. A reader then hunts for it
     * at the end of the document and finds the last member's answer sitting
     * where a synthesis would be, which is exactly how one gets mistaken for
     * the other. Costly on a long export, where nobody scrolls back to check.
     */
    const synthesised = session.entries.some((e) => e.kind === 'consolidation');
    lines.push(synthesised
      ? `Consolidator: ${c.consolidator.model}`
      : 'Consolidator: none - no consolidation was run. Every section below is one '
        + 'member answering the prompt independently; there is no synthesis.');
    if (c.ballot?.length) {
      lines.push('');
      lines.push(tallyToMarkdown(tallyBallot(c.ballot, session.entries)).trimEnd());
    }
  } else if (session.mode === 'chat') {
    const c = session.config as ChatConfig;
    lines.push(`Model: ${c.model}`);
    /*
     * The WHOLE prompt - persona, memory and session layers - not just the
     * free-text field. The gap was found from the other side: a transcript
     * where the model plainly knew things, exported with no trace of how it
     * knew them. Rendered at export time and marked as such, because a
     * persona's memories evolve and earlier turns in this same transcript
     * may have been sent an earlier version.
     */
    const sys = buildSystemPrompt(c, personas);
    if (sys) {
      lines.push('');
      lines.push('## System prompt');
      lines.push('');
      if (c.personaId) {
        lines.push('*(as rendered at export time - memories evolve, so earlier turns may have been sent an earlier version)*');
        lines.push('');
      }
      lines.push(sys);
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
    if (opts.reasoning !== false) {
      for (const t of thinking) {
        lines.push('> **reasoning**');
        for (const l of t.split('\n')) lines.push(('> ' + l).trimEnd());
        lines.push('');
      }
    }
    lines.push(balanceFences(body));
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * A council split into one markdown file per answer, for feeding them to
 * something else separately.
 *
 * The motivating case: ten members over a large document, where each member
 * restating the source in its own words IS the value rather than noise, and a
 * consolidator - especially a weaker one - would flatten exactly the
 * differences worth reading. One combined export is also simply too big to
 * hand to a model in one piece.
 *
 * Every file repeats the prompt. They are going to be read apart from each
 * other, and an answer without its question is a document nobody can check.
 */
export function councilToFiles(
  session: Session, opts: ExportOptions = {},
): Array<{ name: string; text: string }> {
  const prompt = session.entries.find((e) => e.kind === 'user')?.text?.trim() ?? '';
  const answers = session.entries.filter((e) => e.kind === 'participant' || e.kind === 'consolidation');
  const seen = new Map<string, number>();

  return answers.map((e, i) => {
    const { thinking, body } = splitThinking(e.text);
    const isSynthesis = e.kind === 'consolidation';
    const lines: string[] = [];
    lines.push(`# ${isSynthesis ? 'Consolidation' : 'Council member'}: ${e.speaker}`);
    lines.push('');
    lines.push(`- Session: ${session.title}`);
    lines.push(`- Model: ${e.model ?? e.speaker}`);
    lines.push(`- Exported: ${session.updatedAt}`);
    if (e.error) lines.push(`- ⚠ ${e.error === 'cancelled' ? 'stopped part-way - incomplete' : e.error}`);
    // Hitting the output cap is not an error, but a reader comparing answers
    // has to know which ones were cut off rather than finished.
    if (e.truncated) lines.push('- ⚠ stopped at its output limit, not because it had finished');
    lines.push('');
    if (prompt) {
      lines.push('## Prompt');
      lines.push('');
      lines.push(prompt);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
    if (opts.reasoning !== false && thinking.length) {
      lines.push('## Reasoning');
      lines.push('');
      for (const t of thinking) {
        for (const l of t.split('\n')) lines.push(('> ' + l).trimEnd());
        lines.push('');
      }
    }
    lines.push('## Answer');
    lines.push('');
    /*
     * A thinking model that hits its output cap mid-reasoning produces an
     * entry that is ALL reasoning and no answer. Exported with reasoning
     * dropped, that became a file with an empty Answer section and nothing to
     * explain it - which reads as a model that said nothing, rather than one
     * that was cut off before it got to the point.
     */
    if (!body.trim()) {
      lines.push(thinking.length
        ? '_(nothing but reasoning - this turn hit its output limit before writing an answer.'
          + (opts.reasoning === false ? ' Re-export with reasoning included to see how far it got.)_' : ')_')
        : '_(empty)_');
    } else {
      lines.push(balanceFences(body));
    }
    lines.push('');

    /*
     * Numbered by position so the archive lists in run order rather than
     * alphabetically, and suffixed on a repeat: the same model can sit twice
     * in one council, which is what the clone button is for, and two files
     * called the same thing is one file.
     */
    const base = safeName(e.model ?? e.speaker);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const ordinal = String(i + 1).padStart(2, '0');
    const suffix = n > 1 ? `-${n}` : '';
    return {
      name: `${ordinal}-${isSynthesis ? 'consolidation-' : ''}${base}${suffix}.md`,
      text: lines.join('\n'),
    };
  });
}
