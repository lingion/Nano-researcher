import type { CandidateQualityDiagnostics, SearchResult, ToolOutcome } from '../../agent/types.ts';

export interface AutoSearchRequest {
  query: string;
  limit: number;
  signal?: AbortSignal;
  deadlineMs?: number;
  maxEngineCalls?: number;
}

export interface EngineContext {
  signal: AbortSignal;
  deadlineMs: number;
  request: AutoSearchRequest;
}

export interface EngineResult {
  engine: string;
  outcome: Exclude<ToolOutcome, 'protocol_error'>;
  results: SearchResult[];
  durationMs: number;
  requestCount: number;
  retryCount: number;
  error?: { code: string; message: string };
  details?: Record<string, unknown>;
}

export interface AutoEngine {
  readonly name: string;
  readonly capabilities: readonly string[];
  run(query: string, context: EngineContext): Promise<EngineResult>;
}

export interface AutoDiagnostics {
  attemptedEngines: string[];
  engineResults: EngineResult[];
  stoppedReason: 'quality_threshold' | 'engine_budget' | 'deadline' | 'all_engines' | 'cancelled';
  batches: string[][];
  durationMs: number;
  uniqueResultCount?: number;
  duplicateResultCount?: number;
  filteredResultCount?: number;
  outputLimitedCount?: number;
  successfulEngineCount?: number;
  blockedEngineCount?: number;
  candidateQuality?: CandidateQualityDiagnostics;
}
