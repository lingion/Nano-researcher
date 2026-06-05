export interface ScannerRulesConfig {
  trusted_domains: string[];
  derivative_keywords: string[];
  pdf_elevation: boolean;
  default_search_engines: string[];
  default_search_limit: number;
  default_fetch_max_chars: number;
}

export interface ScannerDomainsConfig {
  primary_source_domains: string[];
  secondary_source_domains: string[];
  official_suffixes: string[];
}

export interface ScannerConfig {
  rules: ScannerRulesConfig;
  domains: ScannerDomainsConfig;
}
