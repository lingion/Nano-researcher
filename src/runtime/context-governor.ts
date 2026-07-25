import { normalizeDocumentNumber } from '../fetch-fusion/local-fetch-primary.ts';
import type { PolicyAgentState } from '../policy-task/state-schema.ts';

export interface GovernorConfig {
  maxGeneralCandidatesCount: number;
}

export function normalizeDiscoveryCandidates(
  candidates: PolicyAgentState['discoveredCandidates'],
): PolicyAgentState['discoveredCandidates'] {
  return candidates;
}

export function normalizeFetchedEvidenceState(state: PolicyAgentState): PolicyAgentState {
  return state;
}

export function candidateEvidenceScore(_candidate: PolicyAgentState['discoveredCandidates'][number]): number {
  // Business relevance is model-owned; runtime does not score candidates.
  return 0;
}

export function governLLMActiveView(
  rawCandidates: PolicyAgentState['discoveredCandidates'],
  _currentTurnAnchorUrl?: string,
  _config: GovernorConfig = { maxGeneralCandidatesCount: 2 },
): PolicyAgentState['discoveredCandidates'] {
  return normalizeDiscoveryCandidates(rawCandidates);
}

export function pruneDiscoveryContext(
  state: PolicyAgentState,
  currentTurnAnchorUrl?: string,
  config: GovernorConfig = { maxGeneralCandidatesCount: 2 },
): PolicyAgentState {
  return {
    ...state,
    discoveredCandidates: governLLMActiveView(state.discoveredCandidates, currentTurnAnchorUrl, config),
  };
}
