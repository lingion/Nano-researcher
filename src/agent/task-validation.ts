import type { ResearchTask } from './types.ts';

const OPTION_FIELDS: Record<string, true> = {
  maxIterations: true,
  completionMode: true,
  targetResultCount: true,
  evidenceRequired: true,
  minFetchedPages: true,
  maxSearchActionsPerTurn: true,
  maxFetchActionsPerTurn: true,
  locale: true,
  outputFormat: true,
  engineScope: true,
};

function integerInRange(options: Record<string, unknown>, field: string, maximum: number): void {
  const value = options[field];
  if (value === undefined) return;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`invalid_option_${field}: expected an integer from 1 to ${maximum}`);
  }
}

export function validateResearchTask(value: ResearchTask): void {
  if (value.domain !== undefined && (typeof value.domain !== 'string' || !value.domain.trim() || value.domain.length > 100 || !/^[a-z0-9][a-z0-9-]*$/i.test(value.domain.trim()))) {
    throw new Error('invalid_domain: expected a lowercase alphanumeric slug (1-100 chars, dashes allowed)');
  }
  if (value.options === undefined) return;
  if (!value.options || typeof value.options !== 'object' || Array.isArray(value.options)) throw new Error('options_must_be_object');
  const options = value.options as Record<string, unknown>;
  const unexpected = Object.keys(options).find((field) => !OPTION_FIELDS[field]);
  if (unexpected) throw new Error(`unknown_option_${unexpected}`);
  integerInRange(options, 'maxIterations', 100);
  integerInRange(options, 'targetResultCount', 100);
  integerInRange(options, 'minFetchedPages', 100);
  integerInRange(options, 'maxSearchActionsPerTurn', 8);
  integerInRange(options, 'maxFetchActionsPerTurn', 8);
  if (options.evidenceRequired !== undefined && typeof options.evidenceRequired !== 'boolean') throw new Error('invalid_option_evidenceRequired');
  if (options.completionMode !== undefined && options.completionMode !== 'target_results' && options.completionMode !== 'rounds') throw new Error('invalid_option_completionMode');
  if (options.locale !== undefined && (typeof options.locale !== 'string' || !options.locale.trim() || options.locale.length > 100)) throw new Error('invalid_option_locale');
  if (options.engineScope !== undefined) {
    if (!Array.isArray(options.engineScope) || options.engineScope.length === 0) throw new Error('invalid_option_engineScope: expected a non-empty array of engine names or capability tags');
    for (const scope of options.engineScope) {
      if (typeof scope !== 'string' || !scope.trim() || scope.length > 64 || !/^[a-z0-9][a-z0-9-]*$/i.test(scope.trim())) throw new Error('invalid_option_engineScope: each entry must be an alphanumeric slug');
    }
  }
}
