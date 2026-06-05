import type { ScannerConfig } from '../config-schema.ts';

export function classifyTier(url: string, config: ScannerConfig): string {
  const hostname = new URL(url).hostname;

  if (config.domains.primary_source_domains.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`))) {
    return 'primary_source_candidate';
  }

  if (config.domains.secondary_source_domains.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`))) {
    return 'secondary_source_candidate';
  }

  if (config.domains.official_suffixes.some((suffix) => hostname.endsWith(suffix.replace(/^\./, '')))) {
    return 'official_repost_or_related';
  }

  return 'unknown';
}
