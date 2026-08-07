export type AgentDecisionType = 'search' | 'fetch' | 'review' | 'finish';

export type ToolOutcome =
  | 'success_with_content'
  | 'success_empty'
  | 'http_error'
  | 'transport_error'
  | 'timeout'
  | 'protocol_error'
  | 'cancelled';

export interface ResearchTask {
  question: string;
  /**
   * Domain name (e.g. "general", "policy", "medical"). When set, the runtime
   * resolves it through a DomainResolver to a system prompt and optional engine
   * scope / completion defaults. Leaving it unset uses the generic default
   * prompt, which keeps the path domain-agnostic — the runtime never infers a
   * domain from the question text.
   */
  domain?: string;
  options?: {
    maxIterations?: number;
    completionMode?: 'target_results' | 'rounds';
    targetResultCount?: number;
    evidenceRequired?: boolean;
    minFetchedPages?: number;
    maxSearchActionsPerTurn?: number;
    maxFetchActionsPerTurn?: number;
    locale?: string;
    outputFormat?: 'json' | 'markdown';
    /**
     * Restricts the Auto engine batch to engines whose `name` is listed here,
     * or whose `capabilities` intersect the list when an entry is a capability
     * tag (e.g. "chinese-web", "general-web"). Defaults to all builtin
     * engines. Acts as a mechanical transport filter, not a relevance judge.
     */
    engineScope?: string[];
  };
}

export interface AgentDecision {
  decision: AgentDecisionType;
  searchActions: Array<{ query: string; retry?: boolean }>;
  fetchActions: Array<{ url: string; retry?: boolean }>;
  uncertainties: string[];
  finalAnswer?: string;
  /** Derived from finding-level citations by the decision parser. */
  evidenceUrls?: string[];
  findings?: Array<{
    id: string;
    claim: string;
    disposition: 'confirmed' | 'uncertain' | 'excluded';
    evidenceUrls: string[];
  }>;
}

export interface SearchResult {
  query: string;
  title: string;
  url: string;
  snippet: string;
  provider: string;
  rank?: number;
  providerRank?: number;
  sourceFamily?: string;
  resultType?: string;
  authorityScore?: number;
  sourceProvenance?: {
    authorityScore?: number;
    authorityBasis?: string;
  };
  displayUrl?: string;
  resolvedUrl?: string;
  publishedAt?: string;
  updatedAt?: string;
  unresolvedWrapper?: boolean;
  score?: number;
  scoreBreakdown?: Record<string, number>;
  metadata?: Record<string, unknown>;
}

export interface CandidateQualityDiagnostics {
  inputCount: number;
  uniqueResultCount: number;
  outputResultCount?: number;
  rejectionCounts: {
    invalidUrl: number;
    unresolvedWrapper: number;
    missingText: number;
    queryConstraint: number;
    lowRelevance: number;
    duplicateUrl: number;
  };
  inputExplicitProvenanceCount: number;
  uniqueExplicitProvenanceCount: number;
}

export interface SearchResponse {
  outcome: ToolOutcome;
  results: SearchResult[];
  provider: string;
  durationMs: number;
  retryCount: number;
  error?: { code: string; message: string };
  diagnostics?: Array<{ provider: string; outcome: ToolOutcome; durationMs: number; resultCount: number; requestCount?: number; details?: Record<string, unknown>; error?: { code: string; message: string } }>;
  autoDiagnostics?: {
    attemptedEngines: string[];
    batches: string[][];
    stoppedReason: 'quality_threshold' | 'engine_budget' | 'deadline' | 'all_engines' | 'cancelled';
    durationMs: number;
    uniqueResultCount?: number;
    duplicateResultCount?: number;
    filteredResultCount?: number;
    outputLimitedCount?: number;
    successfulEngineCount?: number;
    blockedEngineCount?: number;
    candidateQuality?: CandidateQualityDiagnostics;
  };
}

export interface FetchResponse {
  outcome: ToolOutcome;
  requestedUrl: string;
  finalUrl: string;
  title: string;
  content: string;
  provider: string;
  statusCode?: number;
  contentType?: string;
  contentLength?: number;
  truncated?: boolean;
  renderMode?: 'static' | 'browser' | 'unknown';
  extractionWarnings: string[];
  durationMs: number;
  retryCount: number;
  error?: { code: string; message: string };
}

export interface AgentState {
  task: ResearchTask;
  currentIteration: number;
  decisions: AgentDecision[];
  searchResults: SearchResult[];
  fetchedPages: FetchResponse[];
  uncertainties: string[];
  finalAnswer?: string;
  interrupted?: {
    reason: 'max_iterations' | 'timeout' | 'cancelled' | 'protocol_error' | 'provider_error' | 'completion_not_reached';
    message: string;
  };
}

export interface AgentResult {
  state: AgentState;
  decision: AgentDecision;
  status: 'completed' | 'interrupted' | 'failed';
}
