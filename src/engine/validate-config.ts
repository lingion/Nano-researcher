import type { JudgmentEngineConfig } from './types.ts';

export class ConfigValidationError extends Error {
  readonly code = 'ENGINE_CONFIG_INVALID';

  constructor(fieldPath: string) {
    super(`JudgmentEngine config requires ${fieldPath}.`);
    this.name = 'ConfigValidationError';
  }
}

function requireStringArray(value: unknown, fieldPath: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ConfigValidationError(fieldPath);
  }
}

export function validateJudgmentEngineConfig(config: JudgmentEngineConfig): void {
  requireStringArray(config.rules?.trusted_domains, 'rules.trusted_domains');
  requireStringArray(config.rules?.derivative_keywords, 'rules.derivative_keywords');
  requireStringArray(config.rules?.default_search_engines, 'rules.default_search_engines');
  requireStringArray(config.domains?.primary_source_domains, 'domains.primary_source_domains');
  requireStringArray(config.domains?.secondary_source_domains, 'domains.secondary_source_domains');
  requireStringArray(config.domains?.official_suffixes, 'domains.official_suffixes');

  if (typeof config.rules?.pdf_elevation !== 'boolean') {
    throw new ConfigValidationError('rules.pdf_elevation');
  }

  if (typeof config.rules?.default_search_limit !== 'number') {
    throw new ConfigValidationError('rules.default_search_limit');
  }

  if (typeof config.rules?.default_fetch_max_chars !== 'number') {
    throw new ConfigValidationError('rules.default_fetch_max_chars');
  }
}
