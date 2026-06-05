import { normalizeDocumentNumber } from '../fetch-fusion/local-fetch-primary.ts';
import type { PolicyAgentState } from '../policy-task/state-schema.ts';

export interface GovernorConfig {
  maxGeneralCandidatesCount: number;
}

export function normalizeDiscoveryCandidates(
  candidates: PolicyAgentState['discoveredCandidates'],
): PolicyAgentState['discoveredCandidates'] {
  return candidates.map((candidate) => ({
    ...candidate,
    evidence_clues: candidate.evidence_clues
      ? {
          ...candidate.evidence_clues,
          extracted_doc_no: normalizeDocumentNumber(candidate.evidence_clues.extracted_doc_no),
        }
      : candidate.evidence_clues,
  }));
}

export function normalizeFetchedEvidenceState(state: PolicyAgentState): PolicyAgentState {
  return {
    ...state,
    fetchedEvidence: state.fetchedEvidence.map((page) => ({
      ...page,
      evidence_clues: page.evidence_clues
        ? {
            ...page.evidence_clues,
            extracted_doc_no: normalizeDocumentNumber(page.evidence_clues.extracted_doc_no),
          }
        : page.evidence_clues,
    })),
  };
}

export function candidateEvidenceScore(candidate: PolicyAgentState['discoveredCandidates'][number]): number {
  if (candidate.policy_grade === 'official_text') {
    return 1000;
  }
  if (candidate.policy_grade === 'official_interpretation') {
    return 900;
  }
  if (candidate.evidence_clues?.extracted_doc_no) {
    return 800;
  }
  if (candidate.policy_grade === 'portal_homepage') {
    return 200;
  }
  if (candidate.policy_grade === 'news_reprint') {
    return 100;
  }
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
