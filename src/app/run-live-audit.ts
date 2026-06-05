import 'dotenv/config';

import {
  createLiveAuditRuntime,
  parseLiveAuditMaxIterations,
  runLiveAudit,
  runLiveAuditPreflight,
  type LiveAuditEnv,
} from './live-audit-runtime.ts';
import { runPolicyTaskLoop } from './run-policy-task.ts';
import { createSearchMcpTools } from '../runtime/search-mcp-tool-adapter.ts';
import type { DebugEvent } from '../runtime/ask-real-claude.ts';
import type { FetchTool, SearchTool } from '../runtime/tool-registry.ts';

export {
  createLiveAuditRuntime,
  parseLiveAuditMaxIterations,
  runLiveAudit,
  runLiveAuditPreflight,
  type LiveAuditEnv,
} from './live-audit-runtime.ts';

export function formatLiveAuditDebugEvent(event: DebugEvent): string {
  return `[live-audit-debug] ${JSON.stringify(event)}`;
}

export async function initializeLocalHeavyCannonWebSearch(): Promise<SearchTool> {
  const toolset = await createSearchMcpTools();
  return toolset.searchTool;
}

export async function initializeLocalHeavyCannonWebFetch(): Promise<FetchTool> {
  const toolset = await createSearchMcpTools();
  return toolset.fetchTool;
}

export async function main(env: LiveAuditEnv = process.env): Promise<void> {
  const runtime = createLiveAuditRuntime(env, {
    onDebugEvent: (event) => {
      console.log(formatLiveAuditDebugEvent(event));
    },
  });
  const ownedToolset = await createSearchMcpTools();

  try {
    const result = await runLiveAudit(runtime, {
      runPolicyTaskLoop: async (input, options) => {
        return await runPolicyTaskLoop(input, {
          ...options,
          ...(ownedToolset
            ? {
                searchTool: ownedToolset.searchTool,
                fetchTool: ownedToolset.fetchTool,
              }
            : {}),
        });
      },
    });

    console.log(JSON.stringify({
      topic: runtime.topic,
      loop_interrupted_by_gate: result.loop_interrupted_by_gate ?? false,
      final_quality_status: result.final_quality_status ?? null,
      final_quality_reason: result.final_quality_reason ?? null,
      current_iteration: result.currentIteration,
      discovered_candidates: result.discoveredCandidates.length,
      fetched_evidence: result.fetchedEvidence.length,
      final_decision: result.decision.decision,
      debug_trace_path: result.debugTracePath,
    }, null, 2));
  } finally {
    if (ownedToolset) {
      await ownedToolset.close();
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
