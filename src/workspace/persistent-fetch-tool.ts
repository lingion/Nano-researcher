import type { FetchTool } from '../runtime/tool-registry.js';
import { EvidenceManager } from './index.ts';

export function createPersistentFetchTool(
  fetchTool: FetchTool,
  options: { manager?: EvidenceManager; workspaceRoot?: string; taskTopic?: string } = {},
): FetchTool {
  const manager = options.manager ?? new EvidenceManager(options.workspaceRoot);

  return {
    fetch: async (url: string, signal?: AbortSignal) => {
      const record = await fetchTool.fetch(url, signal);
      await manager.saveFetchResult(record, options.taskTopic ?? '');
      return record;
    },
  };
}
