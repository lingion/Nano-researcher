import type { ScannerConfig } from '../policy-scanner/config-schema.ts';
import type { FetchedPageRecord } from '../fetch-fusion/types.ts';

export interface CandidateVerdict {
  ok: boolean;
  score: number;
  reasons: string[];
  rejects: string[];
  tier: string;
  metadata: Record<string, unknown>;
}

export interface EngineInput {
  topic: string;
  candidate: Pick<FetchedPageRecord, 'finalUrl' | 'title' | 'content' | 'kerry_cleaning'>;
}

export interface JudgmentEngineConfig extends ScannerConfig {}
