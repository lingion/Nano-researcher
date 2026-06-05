import type { JudgmentEngineConfig } from './types.ts';

export type CandidateTier =
  | 'primary_source_candidate'
  | 'secondary_source_candidate'
  | 'official_repost_or_related'
  | 'unknown';

function matchesConfiguredDomain(hostname: string, configuredDomain: string): boolean {
  return hostname === configuredDomain || hostname.endsWith(`.${configuredDomain}`);
}

export function classifyCandidateTier(url: string, config: JudgmentEngineConfig): CandidateTier {
  const hostname = new URL(url).hostname;

  if (config.domains.primary_source_domains.some((entry) => matchesConfiguredDomain(hostname, entry))) {
    return 'primary_source_candidate';
  }

  if (config.domains.secondary_source_domains.some((entry) => matchesConfiguredDomain(hostname, entry))) {
    return 'secondary_source_candidate';
  }

  if (config.domains.official_suffixes.some((suffix) => hostname.endsWith(suffix.replace(/^\./, '')))) {
    return 'official_repost_or_related';
  }

  return 'unknown';
}
