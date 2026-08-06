import type { FetchProvider } from '../fetch/provider.ts';
import type { SearchProvider } from '../search/provider.ts';
import type { AgentDecision, AgentState, FetchResponse, SearchResponse, ToolOutcome } from './types.ts';
import type { EvidenceStore } from '../evidence/types.ts';

export interface AgentDependencies {
  search: SearchProvider;
  fetch: FetchProvider;
  evidenceStore?: EvidenceStore;
  onEvent?: (event: { type: string; payload: Record<string, unknown> }) => void;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function throwCancelledAfterRequest(
  signal: AbortSignal | undefined,
  dependencies: AgentDependencies,
  type: 'search.cancelled' | 'fetch.cancelled',
  payload: Record<string, unknown>,
): void {
  if (!signal?.aborted) return;
  dependencies.onEvent?.({ type, payload: { ...payload, reason: 'cancelled' } });
  throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

async function settleActionBatch<T>(promises: Array<Promise<T>>): Promise<T[]> {
  const settled = await Promise.allSettled(promises);
  const rejected = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
  if (rejected) throw rejected.reason;
  return settled.map((item) => (item as PromiseFulfilledResult<T>).value);
}

function failureOutcome(error: unknown): ToolOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out/i.test(message) ? 'timeout' : 'transport_error';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function persistEvidence(
  operation: string,
  write: (() => Promise<void>) | undefined,
  dependencies: AgentDependencies,
): Promise<void> {
  if (!write) return;
  try {
    await write();
  } catch (error) {
    dependencies.onEvent?.({
      type: 'evidence.write_error',
      payload: { operation, code: 'EVIDENCE_WRITE_FAILED', message: errorMessage(error) },
    });
  }
}

export async function executeAgentActions(
  state: AgentState,
  decision: AgentDecision,
  dependencies: AgentDependencies,
  signal?: AbortSignal,
): Promise<AgentState> {
  const next = {
    ...state,
    searchResults: [...state.searchResults],
    fetchedPages: [...state.fetchedPages],
    decisions: [...state.decisions, decision],
    uncertainties: [...state.uncertainties, ...decision.uncertainties],
  };
  const searchResponses = await settleActionBatch(decision.searchActions.map(async (action) => {
    throwIfAborted(signal);
    dependencies.onEvent?.({ type: 'search.request', payload: { query: action.query, retry: action.retry === true } });
    const startedAt = Date.now();
    let response: SearchResponse;
    try {
      response = await dependencies.search.search(action.query, { signal });
    } catch (error) {
      throwCancelledAfterRequest(signal, dependencies, 'search.cancelled', { query: action.query });
      response = {
        outcome: failureOutcome(error),
        results: [],
        provider: dependencies.search.name,
        durationMs: Date.now() - startedAt,
        retryCount: action.retry === true ? 1 : 0,
        error: { code: 'SEARCH_PROVIDER_THROW', message: errorMessage(error) },
      };
    }
    throwCancelledAfterRequest(signal, dependencies, 'search.cancelled', { query: action.query });
    await persistEvidence('saveSearchResults', dependencies.evidenceStore?.saveSearchResults
      ? () => dependencies.evidenceStore!.saveSearchResults!(response.results)
      : undefined, dependencies);
    dependencies.onEvent?.({ type: 'search.result', payload: {
      query: action.query,
      outcome: response.outcome,
      resultCount: response.results.length,
      ...(response.error ? { error: response.error } : {}),
      ...(response.autoDiagnostics ? { autoDiagnostics: response.autoDiagnostics } : {}),
      ...(response.diagnostics ? { diagnostics: response.diagnostics } : {}),
    } });
    return response;
  }));
  for (const response of searchResponses) next.searchResults.push(...response.results);

  const fetchResponses = await settleActionBatch(decision.fetchActions.map(async (action) => {
    throwIfAborted(signal);
    dependencies.onEvent?.({ type: 'fetch.request', payload: { url: action.url, retry: action.retry === true } });
    const startedAt = Date.now();
    let response: FetchResponse;
    try {
      response = await dependencies.fetch.fetch(action.url, { signal });
    } catch (error) {
      throwCancelledAfterRequest(signal, dependencies, 'fetch.cancelled', { url: action.url });
      response = {
        outcome: failureOutcome(error),
        requestedUrl: action.url,
        finalUrl: action.url,
        title: '',
        content: '',
        provider: dependencies.fetch.name,
        extractionWarnings: [],
        durationMs: Date.now() - startedAt,
        retryCount: action.retry === true ? 1 : 0,
        error: { code: 'FETCH_PROVIDER_THROW', message: errorMessage(error) },
      };
    }
    throwCancelledAfterRequest(signal, dependencies, 'fetch.cancelled', { url: action.url });
    await persistEvidence('saveFetchedPage', dependencies.evidenceStore?.saveFetchedPage
      ? () => dependencies.evidenceStore!.saveFetchedPage!(response)
      : undefined, dependencies);
    dependencies.onEvent?.({ type: 'fetch.result', payload: {
      requestedUrl: response.requestedUrl,
      finalUrl: response.finalUrl,
      provider: response.provider,
      outcome: response.outcome,
      ...(response.statusCode !== undefined ? { statusCode: response.statusCode } : {}),
      ...(response.contentType ? { contentType: response.contentType } : {}),
      contentLength: response.contentLength ?? response.content.length,
      truncated: response.truncated === true,
      ...(response.renderMode ? { renderMode: response.renderMode } : {}),
      durationMs: response.durationMs,
      retryCount: response.retryCount,
      extractionWarnings: response.extractionWarnings,
      ...(response.error ? { error: response.error } : {}),
    } });
    return response;
  }));
  next.fetchedPages.push(...fetchResponses);
  return { ...next, currentIteration: state.currentIteration + 1, finalAnswer: decision.finalAnswer };
}
