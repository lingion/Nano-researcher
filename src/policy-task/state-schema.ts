import type { PolicyTaskInput } from './task-schema.js';
import type { SearchDiscoveryRecord } from '../search-fusion/types.js';
import type { FetchedPageRecord } from '../fetch-fusion/types.js';

export type DiscoveredCandidate = SearchDiscoveryRecord;

export type FetchedEvidence = FetchedPageRecord;

export interface PolicyAgentState {
  task: PolicyTaskInput;
  discoveredCandidates: DiscoveredCandidate[];
  fetchedEvidence: FetchedEvidence[];
  transcriptPath?: string;
  currentIteration: number;
  uncertainties: string[];
  /** Transport-visible facts and protocol failures; runtime must not infer business outcomes. */
  transportFacts?: Array<Record<string, unknown>>;
  protocolErrors?: Array<Record<string, unknown>>;
  convergencePhase?: 'post_convergence_review' | 'final_summary';
  targetValidatedEvidenceCount?: number;
}
