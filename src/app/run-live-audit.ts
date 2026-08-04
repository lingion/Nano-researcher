import 'dotenv/config';

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

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
import { safeSerializeDebugPayload, sanitizeDebugEvent, summarizeError } from '../runtime/sanitize-debug.ts';

export {
  createLiveAuditRuntime,
  parseLiveAuditMaxIterations,
  runLiveAudit,
  runLiveAuditPreflight,
  type LiveAuditEnv,
} from './live-audit-runtime.ts';

export function formatLiveAuditDebugEvent(event: DebugEvent): string {
  return `[live-audit-debug] ${safeSerializeDebugPayload(sanitizeDebugEvent(event))}`;
}

export async function initializeLocalHeavyCannonWebSearch(): Promise<SearchTool> {
  const toolset = await createSearchMcpTools();
  const searchTool = toolset.searchTool as SearchTool & { close?: () => Promise<void> };
  searchTool.close = toolset.close;
  return searchTool;
}

export async function initializeLocalHeavyCannonWebFetch(): Promise<FetchTool> {
  const toolset = await createSearchMcpTools();
  const fetchTool = toolset.fetchTool as FetchTool & { close?: () => Promise<void> };
  fetchTool.close = toolset.close;
  return fetchTool;
}

type MainDependencies = {
  createToolset?: typeof createSearchMcpTools;
  runLiveAudit?: typeof runLiveAudit;
  runPolicyTaskLoop?: typeof runPolicyTaskLoop;
};

export async function main(
  env: LiveAuditEnv = process.env,
  dependencies: MainDependencies = {},
): Promise<void> {
  const createToolset = dependencies.createToolset ?? createSearchMcpTools;
  const executeLiveAudit = dependencies.runLiveAudit ?? runLiveAudit;
  const executePolicyTaskLoop = dependencies.runPolicyTaskLoop ?? runPolicyTaskLoop;
  const runtime = createLiveAuditRuntime(env, {
    onDebugEvent: (event) => {
      console.log(formatLiveAuditDebugEvent(event));
    },
  });
  const ownedToolset = await createToolset();

  let primaryError: unknown;
  try {
    const result = await executeLiveAudit(runtime, {
      runPolicyTaskLoop: async (input, options) => {
        return await executePolicyTaskLoop(input, {
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

    console.log(safeSerializeDebugPayload({
      topic_present: Boolean(runtime.topic),
      loop_interrupted_by_gate: result.loop_interrupted_by_gate ?? false,
      final_quality_status: result.final_quality_status ?? null,
      current_iteration: result.currentIteration,
      discovered_candidates: result.discoveredCandidates.length,
      fetched_evidence: result.fetchedEvidence.length,
      validated_early_access_count: typeof result.validatedEarlyAccessItems === 'number'
        ? result.validatedEarlyAccessItems
        : Array.isArray(result.validatedEarlyAccessItems)
          ? result.validatedEarlyAccessItems.length
          : 0,
      reported_early_access_count: typeof result.reportedEarlyAccessItems === 'number'
        ? result.reportedEarlyAccessItems
        : Array.isArray(result.reportedEarlyAccessItems)
          ? result.reportedEarlyAccessItems.length
          : 0,
      early_access_target_present: result.earlyAccessTarget !== null && result.earlyAccessTarget !== undefined,
      early_access_shortfall_present: result.earlyAccessShortfall !== null && result.earlyAccessShortfall !== undefined,
      early_access_report_present: Boolean(result.earlyAccessReportPath),
      final_decision: result.decision.decision,
      debug_trace_present: Boolean(result.debugTracePath),
    }));
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (ownedToolset) {
      try {
        await ownedToolset.close();
      } catch (cleanupError) {
        const event = {
          type: 'mcp.cleanup.failure',
          payload: {
            cleanupError: summarizeError(cleanupError),
            ...(primaryError ? { originalError: summarizeError(primaryError) } : {}),
          },
        } satisfies DebugEvent;
        try {
          appendFileSync(
            `${runtime.outputDir}/live.log`,
            `${new Date().toISOString()} ${safeSerializeDebugPayload(event)}\n`,
            'utf8',
          );
          const tracePath = `${runtime.outputDir}/debug-trace.json`;
          const trace = JSON.parse(readFileSync(tracePath, 'utf8')) as { task?: unknown; events?: DebugEvent[] };
          writeFileSync(tracePath, JSON.stringify({
            ...trace,
            events: [...(trace.events ?? []), event],
          }, null, 2));
        } catch (traceError) {
          console.error(safeSerializeDebugPayload({
            type: 'debug_trace.write_error',
            originalError: event.payload,
            traceWriteError: summarizeError(traceError),
          }));
        }
        console.error(safeSerializeDebugPayload(event));
        if (!primaryError) throw cleanupError;
      }
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(safeSerializeDebugPayload(summarizeError(error)));
    process.exitCode = 1;
  });
}
