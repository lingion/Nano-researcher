import { normalizeDocumentNumber } from '../fetch-fusion/local-fetch-primary.ts';
import type { PolicyAgentState } from '../policy-task/state-schema.ts';

export interface GovernorConfig {
  maxGeneralCandidatesCount: number;
}

export function normalizeDiscoveryCandidates(
  candidates: PolicyAgentState['discoveredCandidates'],
): PolicyAgentState['discoveredCandidates'] {
  return candidates.map((candidate) => {
    const extractedDocNo = normalizeDocumentNumber(candidate.evidence_clues?.extracted_doc_no ?? null);
    if (extractedDocNo === (candidate.evidence_clues?.extracted_doc_no ?? null)) {
      return candidate;
    }

    return {
      ...candidate,
      evidence_clues: {
        ...candidate.evidence_clues,
        extracted_doc_no: extractedDocNo,
      },
    };
  });
}

export function normalizeFetchedEvidenceState(state: PolicyAgentState): PolicyAgentState {
  return state;
}

const ACCESS_SOURCE_GRADE_SCORE: Record<string, number> = {
  official_access: 40,
  official_docs: 35,
  official_product: 30,
  official_announcement: 25,
  official_github: 20,
  credible_reporting: 10,
  noise: 2,
  corrupted: 0,
};

export function candidateEvidenceScore(candidate: PolicyAgentState['discoveredCandidates'][number]): number {
  const gradeScore = ACCESS_SOURCE_GRADE_SCORE[candidate.access_source_grade ?? 'corrupted'] ?? 0;
  const documentScore = candidate.evidence_clues?.extracted_doc_no ? 1 : 0;
  return gradeScore + documentScore;
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
