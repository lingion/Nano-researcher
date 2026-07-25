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

export type PolicyDecision = 'continue_search' | 'continue_fetch' | 'finalize' | 'stop' | 'summarize_and_stop';

/** Internal representation after the protocol maps the canonical wire field. */
export interface PolicyAgentDecision {
  decision: PolicyDecision;
  reasoning: string;
  searchActions: AgentSearchAction[];
  fetchActions: AgentFetchAction[];
  evidenceAssessments?: EvidenceAssessment[];
  finalPackage?: unknown | null;
  uncertainties: string[];
  discardedLeads: string[];
  /** Protocol-only failures from model wire parsing; never interpreted as a business decision. */
  protocolErrors?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** Canonical model-facing wire shape. */
export interface PolicyAgentWireDecision {
  decision: PolicyDecision;
  reasoning?: string;
  searchActions?: AgentSearchAction[];
  fetchActions?: AgentFetchAction[];
  evidenceAssessments?: EvidenceAssessment[];
  final_package?: unknown | null;
  uncertainties?: string[];
  discardedLeads?: string[];
}
