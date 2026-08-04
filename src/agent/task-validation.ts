import type { ResearchTask } from './types.ts';

const OPTION_FIELDS = new Set([
  'maxIterations', 'completionMode', 'targetResultCount', 'evidenceRequired', 'minFetchedPages',
  'maxSearchActionsPerTurn', 'maxFetchActionsPerTurn', 'locale', 'outputFormat',
]);

function integerInRange(options: Record<string, unknown>, field: string, maximum: number): void {
  const value = options[field];
  if (value === undefined) return;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`invalid_option_${field}: expected an integer from 1 to ${maximum}`);
  }
}

export function validateResearchTask(value: ResearchTask): void {
  if (!value || typeof value !== 'object' || typeof value.question !== 'string' || !value.question.trim()) {
    throw new Error('question_required');
  }
  if (value.options === undefined) return;
  if (!value.options || typeof value.options !== 'object' || Array.isArray(value.options)) throw new Error('options_must_be_object');
  const options = value.options as Record<string, unknown>;
  const unexpected = Object.keys(options).find((field) => !OPTION_FIELDS.has(field));
  if (unexpected) throw new Error(`unknown_option_${unexpected}`);
  integerInRange(options, 'maxIterations', 100);
  integerInRange(options, 'targetResultCount', 100);
  integerInRange(options, 'minFetchedPages', 100);
  integerInRange(options, 'maxSearchActionsPerTurn', 8);
  integerInRange(options, 'maxFetchActionsPerTurn', 8);
  if (options.evidenceRequired !== undefined && typeof options.evidenceRequired !== 'boolean') throw new Error('invalid_option_evidenceRequired');
  if (options.completionMode !== undefined && options.completionMode !== 'target_results' && options.completionMode !== 'rounds') throw new Error('invalid_option_completionMode');
  if (options.locale !== undefined && (typeof options.locale !== 'string' || !options.locale.trim() || options.locale.length > 100)) throw new Error('invalid_option_locale');
  if (options.outputFormat !== undefined && options.outputFormat !== 'json' && options.outputFormat !== 'markdown') throw new Error('invalid_option_outputFormat');
}
