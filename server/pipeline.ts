// Pipeline mode: each stage's template receives the previous stage's output as {{INPUT}}.
import type { PipelineConfig, TranscriptEntry } from './types.ts';
import { stripThink } from './text.ts';

/**
 * The input for a stage: the latest good output of the previous stage,
 * or the user's initial input for stage 0.
 */
export function resolveStageInput(entries: TranscriptEntry[], stageIndex: number): string {
  if (stageIndex === 0) {
    const user = entries.filter((e) => e.kind === 'user').at(-1);
    return user?.text ?? '';
  }
  const prev = entries
    .filter((e) => e.kind === 'participant' && e.memberIndex === stageIndex - 1 && !e.error && e.text.trim())
    .at(-1);
  if (!prev) throw new Error(`stage ${stageIndex} has no input - stage ${stageIndex - 1} produced no output`);
  return stripThink(prev.text);
}

export function renderStagePrompt(template: string, input: string): string {
  return template.includes('{{INPUT}}')
    ? template.replaceAll('{{INPUT}}', input)
    : `${template.trim()}\n\n${input}`; // forgiving: append input if placeholder forgotten
}

export function validatePipeline(config: PipelineConfig): void {
  if (!config.input?.trim()) throw new Error('pipeline input is empty');
  if (!config.stages?.length) throw new Error('pipeline needs at least one stage');
}
