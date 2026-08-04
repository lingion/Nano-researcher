export interface SearchAttemptRecord {
  stage: 'provider' | 'websearch' | 'html-fallback';
  source: string;
}

export type AccessSourceGrade =
  | 'official_product'
  | 'official_access'
  | 'official_docs'
  | 'official_announcement'
  | 'official_github'
  | 'credible_reporting'
  | 'noise'
  | 'corrupted';

export type KerryQualityStatus =
  | 'usable_results'
  | 'empty'
  | 'blocked_by_waf'
  | 'intent_mismatch'
  | 'junk_heavy';

export interface SearchDiscoveryRecord {
  query: string;
  title: string;
  url: string;
  snippet: string;
  source: string;
  sources?: string[];
  attempts?: SearchAttemptRecord[];
  quality_status?: 'green' | 'yellow';
  quality_reason?: string;
  fallback_used?: boolean;
  filtered_count?: number;
  merged_count?: number;
  deduped_count?: number;
  access_source_grade?: AccessSourceGrade;
  kerry_quality_status?: KerryQualityStatus;
  kerry_quality_reason?: string;
}
