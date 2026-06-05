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
  evidence_clues?: FetchEvidenceClues;
  kerry_cleaning?: KerryCleaningRecord;
  qualityCategory?: 'GOLD_STANDARD' | 'SILVER_STANDARD' | 'NOISE';
  validationReason?: string;
}
