import { runResearchAgent, type ResearchAgentDependencies } from '../agent/agent-loop.ts';
import type { AgentResult, ResearchTask } from '../agent/types.ts';
import type { EvidenceStore } from '../evidence/types.ts';
import { applyDomainDefaults, type DomainResolver } from '../domain/resolver.ts';

export interface RunAgentOptions {
  signal?: AbortSignal;
  systemPrompt?: string;
  evidenceStore?: EvidenceStore;
  /**
   * Optional domain resolver. When supplied alongside a task that carries a
   * `domain`, the agent resolves the domain document into a system prompt and
   * optional completion defaults before the loop starts. An explicit
   * `systemPrompt` always wins over the resolved prompt.
   */
  domainResolver?: DomainResolver;
}

export async function runAgent(
  task: ResearchTask,
  dependencies: ResearchAgentDependencies,
  options: RunAgentOptions = {},
): Promise<AgentResult> {
  let effectiveTask = task;
  let systemPrompt = options.systemPrompt;
  // Domain resolution is the only place a domain document can influence the
  // run: it supplies a system prompt, gap-fills completion defaults (caller
  // values win), and narrows the engine batch. An explicit systemPrompt short-
  // circuits resolution so callers keep direct control.
  if (options.domainResolver && task.domain && !options.systemPrompt) {
    const resolved = await options.domainResolver.resolve(task.domain);
    const withDefaults = resolved.defaults ? applyDomainDefaults(task, resolved.defaults) : task;
    const mergedOptions = { ...(withDefaults.options ?? {}) };
    if (resolved.engineScope && mergedOptions.engineScope === undefined) mergedOptions.engineScope = resolved.engineScope;
    effectiveTask = { ...withDefaults, options: mergedOptions };
    systemPrompt = resolved.systemPrompt;
  }
  const result = await runResearchAgent(effectiveTask, { ...dependencies, ...(options.evidenceStore ? { evidenceStore: options.evidenceStore } : {}) }, { ...(options.signal ? { signal: options.signal } : {}), ...(systemPrompt ? { systemPrompt } : {}) });
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
