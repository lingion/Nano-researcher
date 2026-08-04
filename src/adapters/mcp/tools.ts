import { runAgent } from '../../app/run-agent.ts';
import type { ResearchAgentDependencies } from '../../agent/agent-loop.ts';
import type { ResearchTask } from '../../agent/types.ts';
import { validateResearchTask } from '../../agent/task-validation.ts';
import { createResearchDeadline } from '../../app/research-deadline.ts';

export function createResearchMcpHandlers(dependencies: ResearchAgentDependencies, options: { runTimeoutMs?: number } = {}) {
  return {
    research: async (input: ResearchTask, requestOptions: { signal?: AbortSignal } = {}) => {
      validateResearchTask(input);
      const deadline = options.runTimeoutMs === undefined ? undefined : createResearchDeadline(options.runTimeoutMs, requestOptions.signal);
      try {
        return await runAgent(input, dependencies, { signal: deadline?.signal ?? requestOptions.signal });
      } finally {
        deadline?.clear();
      }
    },
    search: async (input: { query: string }, options: { signal?: AbortSignal } = {}) => {
      if (!input || typeof input.query !== 'string' || !input.query.trim()) throw new Error('query_required');
      return dependencies.search.search(input.query, { signal: options.signal });
    },
    fetch: async (input: { url: string }, options: { signal?: AbortSignal } = {}) => {
      if (!input || typeof input.url !== 'string' || !input.url.trim()) throw new Error('url_required');
      return dependencies.fetch.fetch(input.url, { signal: options.signal });
    },
  };
}
