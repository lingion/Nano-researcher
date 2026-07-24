import path from 'node:path';
import { mkdir } from 'node:fs/promises';

import { writeTaskSummary } from '../artifacts/write-task-summary.ts';
import { writeResultAudit } from '../artifacts/write-result-audit.ts';
import { writeRunTranscript } from '../artifacts/write-run-transcript.ts';
import { writeReportHtml } from '../artifacts/write-report-html.ts';
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
import { deriveEarlyAccessItems } from '../artifacts/write-early-access-report.ts';
import { classifyDate } from '../search-fusion/recency-window.ts';

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
  return await createSearchMcpTools();
}

function countValidatedEvidence(state: PolicyAgentState): number {
  return state.fetchedEvidence.filter((page) => page.qualityCategory === 'GOLD_STANDARD' || page.qualityCategory === 'SILVER_STANDARD').length;
}

function withTargetValidatedEvidenceCount(state: PolicyAgentState, targetValidatedEvidenceCount: number): PolicyAgentState {
  return {
    ...state,
    targetValidatedEvidenceCount,
  };
}

function withConvergencePhase(state: PolicyAgentState, targetValidatedEvidenceCount: number): PolicyAgentState {
  const validated = countValidatedEvidence(state);
  if (validated < targetValidatedEvidenceCount) {
    return {
      ...state,
      convergencePhase: undefined,
      targetValidatedEvidenceCount,
    };
  }

  if (state.convergencePhase === 'post_convergence_review') {
    return {
      ...state,
      convergencePhase: 'final_summary',
      targetValidatedEvidenceCount,
    };
  }

  if (state.convergencePhase === 'final_summary') {
    return {
      ...state,
      convergencePhase: 'final_summary',
      targetValidatedEvidenceCount,
    };
  }

  return {
    ...state,
    convergencePhase: 'post_convergence_review',
    targetValidatedEvidenceCount,
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
    targetValidatedEvidenceCount?: number;
    targetHotspotCount?: number;
    fromDate?: string;
    toDate?: string;
    enableBrowser?: boolean;  } = {},
): Promise<PolicyAgentState & {
  decision: PolicyAgentDecision;
  loop_interrupted_by_gate?: boolean;
  final_quality_status?: string;
  final_quality_reason?: string;
}> {
  const maxIterations = options.maxIterations ?? 4;
  const targetValidatedEvidenceCount = options.targetValidatedEvidenceCount ?? Number.parseInt(process.env.POLICY_TARGET_VALIDATED_COUNT ?? '3', 10);
  const targetHotspotCount = options.targetHotspotCount ?? Number.parseInt(process.env.LIVE_AUDIT_TARGET_COUNT ?? '20', 10);
  const dateWindow = options.fromDate && options.toDate ? { start: options.fromDate, end: options.toDate } : undefined;
  let state: PolicyAgentState = {
    task: input,
    discoveredCandidates: [],
    fetchedEvidence: [],
    currentIteration: 0,
    uncertainties: [],
    targetValidatedEvidenceCount,
  };
  let fullAuditState: PolicyAgentState = state;
  const ownedToolset = options.searchTool && options.fetchTool ? null : await createDefaultToolset();
  const searchTool = options.searchTool ?? ownedToolset?.searchTool ?? createDefaultSearchTool();
  const baseFetchTool = options.fetchTool ?? ownedToolset?.fetchTool ?? createDefaultFetchTool();
  const fetchTool = options.enableBrowser
    ? { fetch: async (url: string) => fetchWithLocalPrimary(url, 20000, { enableBrowserFallback: true, fetchImpl: async (targetUrl, init) => await fetch(targetUrl, init) }) }
    : createPersistentFetchTool(baseFetchTool, { taskTopic: input.topic });

  let lastDecision: PolicyAgentDecision | null = null;
  let currentTurnAnchorUrl: string | undefined;

  try {
    for (let index = 0; index < maxIterations; index += 1) {
      const iterationInputState = withTargetValidatedEvidenceCount(
        pruneDiscoveryContext(normalizeFetchedEvidenceState(state), currentTurnAnchorUrl),
        targetValidatedEvidenceCount,
      );
      const result = await runLocalPolicyAgentIteration(iterationInputState, {
        askAgent: options.askAgent
          ? async (currentState) => {
              const normalizedState = normalizeFetchedEvidenceState(currentState);
              const prunedState = withTargetValidatedEvidenceCount(
                pruneDiscoveryContext(normalizedState, currentTurnAnchorUrl),
                targetValidatedEvidenceCount,
              );

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
        fetchedEvidence: result.fetchedEvidence,
        transcriptPath: result.transcriptPath,
        currentIteration: result.currentIteration,
        uncertainties: result.uncertainties,
        convergencePhase: result.convergencePhase,
        targetValidatedEvidenceCount,
      });
      state = withConvergencePhase(withTargetValidatedEvidenceCount(fullAuditState, targetValidatedEvidenceCount), targetValidatedEvidenceCount);
      lastDecision = result.decision;
      currentTurnAnchorUrl = result.decision.fetchActions.at(-1)?.url;

      if (['finalize', 'stop', 'summarize_and_stop'].includes(result.decision.decision)) {
        const validCount = deriveEarlyAccessItems(fullAuditState.fetchedEvidence, dateWindow).length;
        if (validCount < targetHotspotCount) {
          return {
            ...fullAuditState,
            decision: result.decision,
            final_quality_status: 'insufficient_target_count',
            final_quality_reason: `Only ${validCount} dated early-access hotspots found; target is ${targetHotspotCount}.`,
            target_count: targetHotspotCount,
            valid_count: validCount,
            shortfall: targetHotspotCount - validCount,
          } as PolicyAgentState & { decision: PolicyAgentDecision; final_quality_status: string; final_quality_reason: string; target_count: number; valid_count: number; shortfall: number };
        }
        return {
          ...fullAuditState,
          decision: result.decision,
        };
      }

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
        convergencePhase: result.convergencePhase,
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
      convergencePhase: fullAuditState.convergencePhase,
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
