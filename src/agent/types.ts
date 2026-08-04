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
  };
}

export interface AgentDecision {
  decision: AgentDecisionType;
  searchActions: Array<{ query: string; retry?: boolean }>;
  fetchActions: Array<{ url: string; retry?: boolean }>;
  uncertainties: string[];
  finalAnswer?: string;
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
  metadata?: Record<string, unknown>;
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
  };
}

export interface FetchResponse {
  outcome: ToolOutcome;
  requestedUrl: string;
  finalUrl: string;
  title: string;
  content: string;
  provider: string;
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
