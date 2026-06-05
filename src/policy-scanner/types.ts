import type { FetchedPageRecord } from '../fetch-fusion/types.js';
import type { ScannerConfig } from './config-schema.ts';

export interface CandidateVerdict {
  ok: boolean;
  tier: string;
  reasons: string[];
  rejects: string[];
  exactTitle: boolean;
  derivative: boolean;
  isOfficialPdf: boolean;
}

export interface JudgeCandidateInput {
  taskTopic: string;
  page: Pick<FetchedPageRecord, 'finalUrl' | 'title' | 'content' | 'kerry_cleaning'>;
  config: ScannerConfig;
}
