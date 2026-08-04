import { runResearchAgent, type ResearchAgentDependencies } from '../agent/agent-loop.ts';
import type { AgentResult, ResearchTask } from '../agent/types.ts';
import type { EvidenceStore } from '../evidence/types.ts';

export interface RunAgentOptions {
  signal?: AbortSignal;
  systemPrompt?: string;
  evidenceStore?: EvidenceStore;
}

export async function runAgent(
  task: ResearchTask,
  dependencies: ResearchAgentDependencies,
  options: RunAgentOptions = {},
): Promise<AgentResult> {
  const result = await runResearchAgent(task, { ...dependencies, ...(options.evidenceStore ? { evidenceStore: options.evidenceStore } : {}) }, options);
  try {
    await options.evidenceStore?.saveAgentResult?.(result);
  } catch (error) {
    dependencies.onEvent?.({
      type: 'evidence.write_error',
      payload: { operation: 'saveAgentResult', code: 'EVIDENCE_WRITE_FAILED', message: error instanceof Error ? error.message : String(error) },
    });
  }
  return result;
}
