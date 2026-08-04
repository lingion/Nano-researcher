import type { PolicyTaskInput } from './task-schema.js';
import type { SearchDiscoveryRecord } from '../search-fusion/types.js';
import type { FetchedPageRecord } from '../fetch-fusion/types.js';

export type DiscoveredCandidate = SearchDiscoveryRecord;

export type FetchedEvidence = FetchedPageRecord;

export type ConvergencePhase = 'post_convergence_review' | 'final_summary';

export interface TransportOutcome {
  status: 'healthy' | 'degraded' | 'failed';
  failedOperations: number;
  lastFailure?: Record<string, unknown>;
}

export interface RuntimeFailure {
  stage: 'agent' | 'search' | 'fetch';
  error: Record<string, unknown>;
}

export interface PolicyAgentState {
  task: PolicyTaskInput;
  discoveredCandidates: DiscoveredCandidate[];
  fetchedEvidence: FetchedEvidence[];
  transcriptPath?: string;
  currentIteration: number;
  uncertainties: string[];
  /** Transport-visible facts and protocol failures; runtime must not infer business outcomes. */
  transportFacts?: Array<Record<string, unknown>>;
  transportOutcome?: TransportOutcome;
  protocolErrors?: Array<Record<string, unknown>>;
  runtimeFailure?: RuntimeFailure;
  convergencePhase?: ConvergencePhase;
  targetHotspotCount?: number;
  targetValidatedEvidenceCount?: number;
}
