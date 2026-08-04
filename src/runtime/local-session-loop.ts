import type { PolicyAgentState } from '../policy-task/state-schema.js';
import type { PolicyAgentDecision } from '../policy-task/output-schema.js';
import type { SearchTool, FetchTool } from './tool-registry.js';
import type { DebugEvent } from './ask-real-claude.js';

import { ProtocolDecisionError } from './decision-protocol.js';
import { summarizeError, summarizeFetchedPage, summarizeSearchResults, sanitizeDebugValue, safeSerializeDebugPayload } from './sanitize-debug.js';

function serializeError(error: unknown): Record<string, unknown> {
  return summarizeError(error);
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted)
    || (error instanceof DOMException && error.name === 'AbortError')
    || (error instanceof Error && (error.name === 'AbortError' || error.name === 'RuntimeTimeoutError'));
}

export async function runOneSessionIteration(
  state: PolicyAgentState,
  deps: {
    askAgent: (state: PolicyAgentState, signal?: AbortSignal) => Promise<PolicyAgentDecision>;
    searchTool: SearchTool;
    fetchTool: FetchTool;
    onDebugEvent?: (event: DebugEvent) => void;
    signal?: AbortSignal;
  },
): Promise<{ state: PolicyAgentState; decision: PolicyAgentDecision }> {
  if (deps.signal?.aborted) throw deps.signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
  let decision: PolicyAgentDecision;
  try {
    decision = await deps.askAgent(state, deps.signal);
  } catch (error) {
    const errorRecord = serializeError(error);
    deps.onDebugEvent?.({
      type: 'agent.failure',
      payload: {
        stage: 'agent',
        error: errorRecord,
      },
    });
    const failedState: PolicyAgentState = {
      ...state,
      runtimeFailure: {
        stage: 'agent',
        error: errorRecord,
      },
    };
    deps.onDebugEvent?.({
      type: 'state.updated',
      payload: {
        state: failedState,
      },
    });
    throw error;
  }
  if (deps.signal?.aborted) throw deps.signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
  if (!decision || typeof decision.decision !== 'string' || !Array.isArray(decision.searchActions) || !Array.isArray(decision.fetchActions)) {
    throw new ProtocolDecisionError({ scope: 'decision', code: 'INVALID_ENVELOPE', message: 'Runtime received an invalid decision shape' });
  }
  if (decision.protocolErrors?.length) {
    throw new ProtocolDecisionError({ scope: 'decision', code: 'INVALID_ACTIONS', message: 'Runtime received a decision containing protocol errors' });
  }
  const actionCount = decision.searchActions.length + decision.fetchActions.length;
  const invalidCombination =
    (decision.decision === 'continue_search' && decision.fetchActions.length > 0) ||
    (decision.decision === 'continue_fetch' && decision.searchActions.length > 0) ||
    (['finalize', 'stop', 'summarize_and_stop'] as string[]).includes(decision.decision) && actionCount > 0;
  if (invalidCombination) {
    throw new ProtocolDecisionError({ scope: 'decision', code: 'INVALID_ACTIONS', message: `Decision ${decision.decision} is inconsistent with supplied actions` });
  }
  deps.onDebugEvent?.({
    type: 'agent.decision',
    payload: {
      decision: sanitizeDebugValue(decision) as Record<string, unknown>,
    },
  });

  const discovered = [...state.discoveredCandidates];
  const transportFacts = [...(state.transportFacts ?? [])];
  let failedOperations = state.transportOutcome?.failedOperations ?? 0;
  let lastFailure = state.transportOutcome?.lastFailure;

  for (const [index, action] of decision.searchActions.entries()) {
    if (deps.signal?.aborted) throw deps.signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
    deps.onDebugEvent?.({
      type: 'tool.search.request',
      payload: {
        query: action.query,
        why: action.why,
      },
    });

    try {
      const startedAt = Date.now();
      deps.onDebugEvent?.({ type: 'stage.start', payload: { stage: 'search', query: action.query, iteration: state.currentIteration, startedAt: new Date(startedAt).toISOString() } });
      const found = await deps.searchTool.search(action.query, deps.signal);
      deps.onDebugEvent?.({ type: 'stage.end', payload: { stage: 'search', query: action.query, iteration: state.currentIteration, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt } });
      deps.onDebugEvent?.({
        type: 'tool.search.result',
        payload: {
          query: action.query,
          resultCount: found.length,
          results: summarizeSearchResults(found),
        },
      });

      discovered.push(...found);
    } catch (error) {
      if (isCancellation(error, deps.signal)) throw error;
      deps.onDebugEvent?.({
        type: 'stage.failure',
        payload: {
          stage: 'search',
          query: action.query,
          iteration: state.currentIteration,
          error: serializeError(error),
        },
      });
      deps.onDebugEvent?.({
        type: 'tool.search.failure',
        payload: {
          query: action.query,
          why: action.why,
          error: serializeError(error),
        },
      });
      const failure = { type: 'transport_error', operation: 'search', query: action.query, error: serializeError(error) };
      transportFacts.push(failure);
      failedOperations += 1;
      lastFailure = failure;
      continue;
    }
  }

  const fetched = [...state.fetchedEvidence];
  if (process.env.LIVE_AUDIT_DEBUG === '1') {
    console.error('[LIVE_AUDIT_DEBUG]', safeSerializeDebugPayload({
      decision: decision.decision,
      searchActionCount: decision.searchActions.length,
      fetchActionCount: decision.fetchActions.length,
      iteration: state.currentIteration,
    }));
  }
  for (const action of decision.fetchActions) {
    if (deps.signal?.aborted) throw deps.signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
    deps.onDebugEvent?.({
      type: 'tool.fetch.request',
      payload: {
        url: action.url,
        why: action.why,
      },
    });

    try {
      const startedAt = Date.now();
      deps.onDebugEvent?.({ type: 'stage.start', payload: { stage: 'fetch', url: action.url, iteration: state.currentIteration, startedAt: new Date(startedAt).toISOString() } });
      const page = await deps.fetchTool.fetch(action.url, deps.signal);
      deps.onDebugEvent?.({ type: 'stage.end', payload: { stage: 'fetch', url: action.url, iteration: state.currentIteration, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt } });
      deps.onDebugEvent?.({
        type: 'tool.fetch.result',
        payload: {
          url: action.url,
          page: summarizeFetchedPage(page),
        },
      });

      fetched.push(page);
    } catch (error) {
      if (isCancellation(error, deps.signal)) throw error;
      deps.onDebugEvent?.({
        type: 'stage.failure',
        payload: {
          stage: 'fetch',
          url: action.url,
          iteration: state.currentIteration,
          error: serializeError(error),
        },
      });
      deps.onDebugEvent?.({
        type: 'tool.fetch.failure',
        payload: {
          url: action.url,
          why: action.why,
          error: serializeError(error),
        },
      });
      const failure = { type: 'transport_error', operation: 'fetch', url: action.url, error: serializeError(error) };
      transportFacts.push(failure);
      failedOperations += 1;
      lastFailure = failure;
      continue;
    }
  }

  const nextState = {
    ...state,
    discoveredCandidates: discovered,
    fetchedEvidence: fetched,
    currentIteration: state.currentIteration + 1,
    uncertainties: decision.uncertainties,
    transportFacts,
    transportOutcome: {
      status: failedOperations > 0 ? (discovered.length + fetched.length > 0 ? 'degraded' : 'failed') : 'healthy',
      failedOperations,
      ...(lastFailure ? { lastFailure } : {}),
    },
    protocolErrors: decision.protocolErrors ?? state.protocolErrors,
  };

  deps.onDebugEvent?.({
    type: 'state.updated',
    payload: {
      state: nextState,
    },
  });

  return {
    decision,
    state: nextState,
  };
}
