export type PageRenderMode = 'static' | 'spa_extraction' | 'playwright';

export type FreshnessStatus = 'in_window' | 'out_of_window' | 'date_unknown';

export type AccessSignal =
  | 'gray_release'
  | 'small_batch'
  | 'invite_only'
  | 'waitlist'
  | 'application_open'
  | 'developer_preview'
  | 'limited_rollout'
  | 'closed'
  | 'public_release';

export interface FetchEvidenceClues {
  is_suspected_reprint: boolean;
  extracted_doc_no: string | null;
  potential_official_urls: string[];
}

export interface KerryCleaningRecord {
  raw_text?: string;
  cleaned_text?: string;
  metadata?: Record<string, unknown>;
  removed_fragments?: unknown[];
  cleaning_alerts?: unknown[];
  cleaning_stats?: Record<string, unknown>;
}

export interface FetchedPageRecord {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  content: string;
  backend: string;
  statusCode?: number;
  contentType?: string;
  contentLength?: number;
  truncated?: boolean;
  publishedAt?: string;
  updatedAt?: string;
  lastVerifiedAt?: string;
  pageRenderMode?: PageRenderMode;
  accessSignals?: AccessSignal[];
  freshnessStatus?: FreshnessStatus;
  dateEvidence?: string[];
  extractionWarnings?: string[];
  evidence_clues?: FetchEvidenceClues;
  kerry_cleaning?: KerryCleaningRecord;
  qualityCategory?: 'GOLD_STANDARD' | 'SILVER_STANDARD' | 'NOISE';
  validationReason?: string;
}
