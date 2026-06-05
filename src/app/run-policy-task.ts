import path from 'node:path';
import { mkdir } from 'node:fs/promises';

import { writeTaskSummary } from '../artifacts/write-task-summary.ts';
import { writeResultAudit } from '../artifacts/write-result-audit.ts';
import { writeRunTranscript } from '../artifacts/write-run-transcript.ts';
import { writeReportHtml } from '../artifacts/write-report-html.ts';
import { searchWithCloudflareLocal, buildDefaultAutoWebSearchArgs } from '../search-fusion/cloudflare-search-local.ts';
import {
  createNdrcPolicySearchProvider,
  createMiitPolicySearchProvider,
  createGovCnPolicyLibraryProvider,
} from '../search-fusion/official-policy-entrances.ts';
import { fetchWithLocalPrimary } from '../fetch-fusion/local-fetch-primary.ts';
import {
  normalizeFetchedEvidenceState,
  pruneDiscoveryContext,
} from '../runtime/context-governor.ts';
import { assessLoopTermination } from '../runtime/termination-policy.ts';
import { runLocalPolicyAgentIteration } from '../runtime/run-local-policy-agent.ts';
import { createSearchMcpTools } from '../runtime/search-mcp-tool-adapter.ts';
import type { SearchTool, FetchTool } from '../runtime/tool-registry.ts';
import type { DebugEvent } from '../runtime/ask-real-claude.ts';
import type { PolicyAgentDecision } from '../policy-task/output-schema.ts';
import type { PolicyAgentState } from '../policy-task/state-schema.ts';
import { createPersistentFetchTool } from '../workspace/persistent-fetch-tool.ts';

function createDefaultSearchTool(): SearchTool {
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string>; method?: string; body?: string }) => {
    const response = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: init?.headers,
      body: init?.body,
    });

    return {
      text: async () => await response.text(),
    };
  };

  return {
    search: async (query: string) => (await searchWithCloudflareLocal(query, {
      providerSearches: [
        createNdrcPolicySearchProvider({ fetchImpl }),
        createMiitPolicySearchProvider({ fetchImpl }),
        createGovCnPolicyLibraryProvider({ fetchImpl }),
      ],
      webSearchArgs: buildDefaultAutoWebSearchArgs(query),
    })).results,
  };
}

function createDefaultFetchTool(): FetchTool {
  return {
    fetch: async (url: string) => fetchWithLocalPrimary(url),
  };
}

async function createDefaultToolset(): Promise<{
  searchTool: SearchTool;
  fetchTool: FetchTool;
  close?: () => Promise<void>;
}> {
  const backend = process.env.POLICY_SEARCH_BACKEND ?? 'legacy';
  if (backend === 'search-mcp') {
    return await createSearchMcpTools();
  }
  return {
    searchTool: createDefaultSearchTool(),
    fetchTool: createDefaultFetchTool(),
  };
}

async function writeDebugTraceArtifact(filePath: string, task: { topic: string }, events: DebugEvent[]): Promise<void> {
  await writeRunTranscript(filePath, {
    task,
    events,
  });
}

export async function runPolicyTaskLoop(
  input: { topic: string },
  options: {
    maxIterations?: number;
    askAgent?: (state: PolicyAgentState) => Promise<PolicyAgentDecision>;
    callModel?: (prompt: string) => Promise<string>;
    searchTool?: SearchTool;
    fetchTool?: FetchTool;
    onDebugEvent?: (event: DebugEvent) => void;
  } = {},
): Promise<PolicyAgentState & {
  decision: PolicyAgentDecision;
  loop_interrupted_by_gate?: boolean;
  final_quality_status?: string;
  final_quality_reason?: string;
}> {
  const maxIterations = options.maxIterations ?? 4;
  let state: PolicyAgentState = {
    task: input,
    discoveredCandidates: [],
    fetchedEvidence: [],
    currentIteration: 0,
    uncertainties: [],
  };
  let fullAuditState: PolicyAgentState = state;
  const ownedToolset = options.searchTool && options.fetchTool ? null : await createDefaultToolset();
  const searchTool = options.searchTool ?? ownedToolset?.searchTool ?? createDefaultSearchTool();
  const baseFetchTool = options.fetchTool ?? ownedToolset?.fetchTool ?? createDefaultFetchTool();
  const fetchTool = createPersistentFetchTool(baseFetchTool, { taskTopic: input.topic });

  let lastDecision: PolicyAgentDecision | null = null;
  let currentTurnAnchorUrl: string | undefined;

  try {
    for (let index = 0; index < maxIterations; index += 1) {
      const iterationInputState = pruneDiscoveryContext(normalizeFetchedEvidenceState(state), currentTurnAnchorUrl);
      const result = await runLocalPolicyAgentIteration(iterationInputState, {
        askAgent: options.askAgent
          ? async (currentState) => {
              const normalizedState = normalizeFetchedEvidenceState(currentState);
              const prunedState = pruneDiscoveryContext(normalizedState, currentTurnAnchorUrl);

              return await options.askAgent?.(prunedState);
            }
          : undefined,
        callModel: options.callModel,
        searchTool,
        fetchTool,
        onDebugEvent: options.onDebugEvent,
      });

      const discoveredDelta = result.discoveredCandidates.slice(iterationInputState.discoveredCandidates.length);
      const fetchedDelta = result.fetchedEvidence.slice(iterationInputState.fetchedEvidence.length);

      fullAuditState = normalizeFetchedEvidenceState({
        task: result.task,
        discoveredCandidates: [...fullAuditState.discoveredCandidates, ...discoveredDelta],
        fetchedEvidence: [...fullAuditState.fetchedEvidence, ...fetchedDelta],
        transcriptPath: result.transcriptPath,
        currentIteration: result.currentIteration,
        uncertainties: result.uncertainties,
      });
      state = fullAuditState;
      lastDecision = result.decision;
      currentTurnAnchorUrl = result.decision.fetchActions.at(-1)?.url;

      const termination = assessLoopTermination({
        currentIteration: result.currentIteration,
        maxIterations,
        lastCandidateQualityState: [...fullAuditState.discoveredCandidates]
          .reverse()
          .find((candidate) => candidate.kerry_quality_status)
          ? {
              status: [...fullAuditState.discoveredCandidates]
                .reverse()
                .find((candidate) => candidate.kerry_quality_status)?.kerry_quality_status,
              reason: [...fullAuditState.discoveredCandidates]
                .reverse()
                .find((candidate) => candidate.kerry_quality_status)?.kerry_quality_reason,
            }
          : undefined,
        agentDecisionType: result.decision.decision,
      });

      if (termination.shouldBreak) {
        return {
          ...fullAuditState,
          decision: result.decision,
          ...(termination.interruptedByGate
            ? {
                loop_interrupted_by_gate: true,
                final_quality_status: termination.finalQualityStatus,
                final_quality_reason: termination.finalQualityReason,
              }
            : {}),
        };
      }
    }

    if (!lastDecision) {
      throw new Error('Policy task loop ended before any decision was produced.');
    }

    const termination = assessLoopTermination({
      currentIteration: fullAuditState.currentIteration,
      maxIterations,
      lastCandidateQualityState: [...fullAuditState.discoveredCandidates]
        .reverse()
        .find((candidate) => candidate.kerry_quality_status)
        ? {
            status: [...fullAuditState.discoveredCandidates]
              .reverse()
              .find((candidate) => candidate.kerry_quality_status)?.kerry_quality_status,
            reason: [...fullAuditState.discoveredCandidates]
              .reverse()
              .find((candidate) => candidate.kerry_quality_status)?.kerry_quality_reason,
          }
        : undefined,
      agentDecisionType: lastDecision.decision,
    });

    return {
      ...fullAuditState,
      decision: lastDecision,
      ...(termination.interruptedByGate
        ? {
            loop_interrupted_by_gate: true,
            final_quality_status: termination.finalQualityStatus,
            final_quality_reason: termination.finalQualityReason,
          }
        : {}),
    };
  } finally {
    if (ownedToolset?.close) {
      await ownedToolset.close();
    }
  }
}

export async function runPolicyTask(
  input: { topic: string },
  options: {
    outputDir: string;
    debug?: boolean;
    callModel?: (prompt: string) => Promise<string>;
    searchTool?: SearchTool;
    fetchTool?: FetchTool;
  },
): Promise<{
  taskSummaryPath: string;
  resultAuditPath: string;
  reportHtmlPath: string;
  runTranscriptPath: string;
  debugTracePath?: string;
}> {
  await mkdir(options.outputDir, { recursive: true });

  const taskSummaryPath = path.join(options.outputDir, 'task-summary.json');
  const resultAuditPath = path.join(options.outputDir, 'result-audit.json');
  const reportHtmlPath = path.join(options.outputDir, 'report.html');
  const runTranscriptPath = path.join(options.outputDir, 'run-transcript.json');
  const debugTracePath = path.join(options.outputDir, 'debug-trace.json');

  const debugEvents: DebugEvent[] = [];
  const onDebugEvent = (event: DebugEvent) => {
    if (options.debug) {
      debugEvents.push(event);
    }
  };

  try {
    const result = await runLocalPolicyAgentIteration(
      {
        task: input,
        discoveredCandidates: [],
        fetchedEvidence: [],
        currentIteration: 0,
        uncertainties: [],
      },
      {
        callModel: options.callModel,
        searchTool: options.searchTool ?? createDefaultSearchTool(),
        fetchTool: createPersistentFetchTool(options.fetchTool ?? createDefaultFetchTool(), { taskTopic: input.topic }),
        onDebugEvent,
      },
    );

    await writeTaskSummary(taskSummaryPath, {
      task: input,
      decision: result.decision,
      currentIteration: result.currentIteration,
      uncertainties: result.uncertainties,
    });
    await writeResultAudit(resultAuditPath, {
      task: input,
      decision: result.decision,
      candidates: result.discoveredCandidates,
      fetchedEvidence: result.fetchedEvidence,
    });
    await writeRunTranscript(runTranscriptPath, {
      task: input,
      turns: [
        {
          iteration: result.currentIteration,
          decision: result.decision,
          discoveredCandidates: result.discoveredCandidates,
          fetchedEvidence: result.fetchedEvidence,
          uncertainties: result.uncertainties,
        },
      ],
      ...(options.debug ? { debug: { events: debugEvents, tracePath: debugTracePath } } : {}),
    });

    if (options.debug) {
      await writeDebugTraceArtifact(debugTracePath, input, debugEvents);
    }

    await writeReportHtml(reportHtmlPath, input.topic);

    return {
      taskSummaryPath,
      resultAuditPath,
      reportHtmlPath,
      runTranscriptPath,
      ...(options.debug ? { debugTracePath } : {}),
    };
  } catch (error) {
    if (options.debug) {
      debugEvents.push({
        type: 'run.failure',
        payload: error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack ?? null,
            }
          : {
              message: String(error),
            },
      });
      await writeDebugTraceArtifact(debugTracePath, input, debugEvents);
    }
    throw error;
  }
}
