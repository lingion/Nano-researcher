export interface AgentSearchAction {
  query: string;
  why: string;
}

export interface AgentFetchAction {
  url: string;
  why: string;
}

export interface EvidenceAssessment {
  url: string;
  qualityCategory: 'GOLD_STANDARD' | 'SILVER_STANDARD' | 'NOISE';
  validationReason: string;
}

export interface PolicyAgentDecision {
  decision: 'continue_search' | 'continue_fetch' | 'finalize' | 'stop' | 'summarize_and_stop';
  reasoning: string;
  searchActions: AgentSearchAction[];
  fetchActions: AgentFetchAction[];
  evidenceAssessments?: EvidenceAssessment[];
  finalPackage?: unknown;
  uncertainties: string[];
  discardedLeads: string[];
}
