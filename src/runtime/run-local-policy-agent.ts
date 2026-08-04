import type { PolicyAgentState } from '../policy-task/state-schema.js';
import type { PolicyAgentDecision } from '../policy-task/output-schema.js';
import type { SearchTool, FetchTool } from './tool-registry.js';
import { runOneSessionIteration } from './local-session-loop.js';
import { askRealClaudeDecision, type DebugEvent } from './ask-real-claude.js';

export async function runLocalPolicyAgentIteration(
  state: PolicyAgentState,
  deps: {
    askAgent?: (state: PolicyAgentState, signal?: AbortSignal) => Promise<PolicyAgentDecision>;
    callModel?: (prompt: string, signal?: AbortSignal) => Promise<string>;
    searchTool: SearchTool;
    fetchTool: FetchTool;
    onDebugEvent?: (event: DebugEvent) => void;
    onRawModelOutput?: (rawText: string) => void | Promise<void>;
    signal?: AbortSignal;
  },
): Promise<PolicyAgentState & { decision: PolicyAgentDecision }> {
  const result = await runOneSessionIteration(state, {
    ...deps,
    askAgent:
      deps.askAgent
        ? (currentState) => deps.askAgent!(currentState, deps.signal)
        : (currentState) => askRealClaudeDecision(currentState, {
            callModel: deps.callModel,
            onDebugEvent: deps.onDebugEvent,
            onRawModelOutput: deps.onRawModelOutput,
            signal: deps.signal,
          }),
    signal: deps.signal,
  });

  return {
    ...result.state,
    decision: result.decision,
  };
}
