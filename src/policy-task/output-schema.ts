export interface AgentSearchAction {
  query: string;
  why: string;
}

export interface AgentFetchAction {
  url: string;
  why: string;
}

export interface PolicyAgentDecision {
  decision: 'continue_search' | 'continue_fetch' | 'finalize' | 'stop';
  reasoning: string;
  searchActions: AgentSearchAction[];
  fetchActions: AgentFetchAction[];
  finalPackage?: unknown;
  uncertainties: string[];
  discardedLeads: string[];
}
