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
  currentTurnAnchorUrl?: string,
  config: GovernorConfig = { maxGeneralCandidatesCount: 2 },
): PolicyAgentState['discoveredCandidates'] {
  const normalizedCandidates = normalizeDiscoveryCandidates(rawCandidates);
  const officialCandidates = normalizedCandidates.filter((candidate) => candidate.policy_grade === 'official_text');
  const poolToPrune = normalizedCandidates.filter((candidate) => candidate.policy_grade !== 'official_text');
  const anchorCandidate = currentTurnAnchorUrl
    ? poolToPrune.find((candidate) => candidate.url === currentTurnAnchorUrl)
    : undefined;
  const retainedGeneralCandidates = [...poolToPrune]
    .filter((candidate) => candidate.url !== anchorCandidate?.url)
    .sort((left, right) => candidateEvidenceScore(right) - candidateEvidenceScore(left))
    .slice(0, anchorCandidate ? Math.max(0, config.maxGeneralCandidatesCount - 1) : config.maxGeneralCandidatesCount);
  const prunedGeneralCandidates = [...(anchorCandidate ? [anchorCandidate] : []), ...retainedGeneralCandidates]
    .sort((left, right) => candidateEvidenceScore(right) - candidateEvidenceScore(left));

  return [...officialCandidates, ...prunedGeneralCandidates];
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
