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
}
