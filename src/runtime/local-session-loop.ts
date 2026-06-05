import type { PolicyAgentState } from '../policy-task/state-schema.js';
import type { PolicyAgentDecision } from '../policy-task/output-schema.js';
import type { SearchTool, FetchTool } from './tool-registry.js';
import type { DebugEvent } from './ask-real-claude.js';

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
    };
  }

  return {
    message: String(error),
  };
}

export async function runOneSessionIteration(
  state: PolicyAgentState,
  deps: {
    askAgent: (state: PolicyAgentState) => Promise<PolicyAgentDecision>;
    searchTool: SearchTool;
    fetchTool: FetchTool;
    onDebugEvent?: (event: DebugEvent) => void;
  },
): Promise<{ state: PolicyAgentState; decision: PolicyAgentDecision }> {
  const decision = await deps.askAgent(state);
  deps.onDebugEvent?.({
    type: 'agent.decision',
    payload: {
      decision,
    },
  });

  const discovered = [...state.discoveredCandidates];
  for (const [index, action] of decision.searchActions.entries()) {
    console.log('[FORENSIC] consuming search action', JSON.stringify({
      iteration: state.currentIteration,
      actionIndex: index,
      totalSearchActions: decision.searchActions.length,
      query: action.query,
      why: action.why,
      discoveredBefore: discovered.length,
    }));

    deps.onDebugEvent?.({
      type: 'tool.search.request',
      payload: {
        query: action.query,
        why: action.why,
      },
    });

    try {
      const found = await deps.searchTool.search(action.query);
      deps.onDebugEvent?.({
        type: 'tool.search.result',
        payload: {
          query: action.query,
          resultCount: found.length,
          results: found,
        },
      });

      discovered.push(...found);
    } catch (error) {
      deps.onDebugEvent?.({
        type: 'tool.search.failure',
        payload: {
          query: action.query,
          why: action.why,
          error: serializeError(error),
        },
      });
      throw error;
    }
  }

  const fetched = [...state.fetchedEvidence];
  if (process.env.LIVE_AUDIT_DEBUG === '1') {
    console.error('\n=== [LLM BRAIN ACTION DEFLECTION AUDIT] ===');
    console.error('[Round Audit] Next Decision Summary:');
    console.error(`  -> decision.type = "${decision?.decision ?? 'UNKNOWN'}"`);
    console.error(`  -> decision.searchActions count = ${decision?.searchActions?.length ?? 0}`);
    console.error(`  -> decision.fetchActions count = ${decision?.fetchActions?.length ?? 0}`);

    if (decision?.fetchActions && decision.fetchActions.length > 0) {
      console.error(`  -> [CRITICAL EVIDENCE] Captured target fetch URLs: ${JSON.stringify(decision.fetchActions.map((action) => action.url))}`);
    } else {
      console.error('  -> [WARNING REASONING] LLM refused to issue FETCH action this round. Still locked in search phase.');
    }
    console.error('=== [END OF BRAIN AUDIT] ===\n');

    const rawString = typeof (decision?.finalPackage as { _raw_model_output?: unknown } | undefined)?._raw_model_output === 'string'
      ? ((decision.finalPackage as { _raw_model_output: string })._raw_model_output)
      : JSON.stringify(decision);
    console.error('\n🔬 === [RAW BRAIN OUTPUT CELL BIOPSY] ===');
    console.error(`Raw Model Output Excerpt:\n${rawString.substring(0, 1000)}`);
    if (rawString.length > 1000) {
      console.error(`... [TRUNCATED] ...\n${rawString.substring(rawString.length - 1000)}`);
    }
    console.error('🔬 === [END OF CELL BIOPSY] ===\n');
  }
  for (const action of decision.fetchActions) {
    deps.onDebugEvent?.({
      type: 'tool.fetch.request',
      payload: {
        url: action.url,
        why: action.why,
      },
    });

    try {
      const page = await deps.fetchTool.fetch(action.url);
      deps.onDebugEvent?.({
        type: 'tool.fetch.result',
        payload: {
          url: action.url,
          page,
        },
      });

      fetched.push(page);
    } catch (error) {
      deps.onDebugEvent?.({
        type: 'tool.fetch.failure',
        payload: {
          url: action.url,
          why: action.why,
          error: serializeError(error),
        },
      });
      throw error;
    }
  }

  const nextState = {
    ...state,
    discoveredCandidates: discovered,
    fetchedEvidence: fetched,
    currentIteration: state.currentIteration + 1,
    uncertainties: decision.uncertainties,
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
