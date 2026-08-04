import path from 'node:path';
import { mkdir } from 'node:fs/promises';

import { writeTaskSummary } from '../artifacts/write-task-summary.ts';
import { writeResultAudit } from '../artifacts/write-result-audit.ts';
import { writeRunTranscript } from '../artifacts/write-run-transcript.ts';
import { writeReportHtml } from '../artifacts/write-report-html.ts';
import { fetchWithLocalPrimary } from '../fetch-fusion/local-fetch-primary.ts';
import { fetchWithBrowserFallback } from '../fetch-fusion/browser-fetch.ts';
import type { BrowserAdapter } from '../fetch-fusion/browser-fetch.ts';
import {
  pruneDiscoveryContext,
} from '../runtime/context-governor.ts';
import { runLocalPolicyAgentIteration } from '../runtime/run-local-policy-agent.ts';
import type { SearchTool, FetchTool } from '../runtime/tool-registry.ts';
import { createSearchMcpTools } from '../runtime/search-mcp-tool-adapter.ts';
import type { DebugEvent } from '../runtime/ask-real-claude.ts';
import { summarizeError } from '../runtime/sanitize-debug.ts';
import type { PolicyAgentDecision } from '../policy-task/output-schema.ts';
import type { PolicyAgentState } from '../policy-task/state-schema.ts';
import { createPersistentFetchTool } from '../workspace/persistent-fetch-tool.ts';
import { classifyDate } from '../search-fusion/recency-window.ts';
import { searchWithCloudflareLocal } from '../search-fusion/cloudflare-search-local.ts';
import { buildDefaultAutoWebSearchArgs } from '../search-fusion/auto-router.ts';
import {
  createGovCnPolicyLibraryProvider,
  createMiitPolicySearchProvider,
  createNdrcPolicySearchProvider,
} from '../search-fusion/official-policy-entrances.ts';

function normalizeAssessmentUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

function applyEvidenceAssessments(
  pages: PolicyAgentState['fetchedEvidence'],
  assessments: PolicyAgentDecision['evidenceAssessments'] = [],
): PolicyAgentState['fetchedEvidence'] {
  if (!assessments?.length) return pages;
  const byUrl = new Map<string, NonNullable<PolicyAgentDecision['evidenceAssessments']>[number]>();
  for (const assessment of assessments) {
    byUrl.set(normalizeAssessmentUrl(assessment.url), assessment);
  }
  return pages.map((page) => {
    const assessment = byUrl.get(normalizeAssessmentUrl(page.requestedUrl))
      ?? byUrl.get(normalizeAssessmentUrl(page.finalUrl));
    return assessment
      ? { ...page, qualityCategory: assessment.qualityCategory, validationReason: assessment.validationReason }
      : page;
  });
}

function createDefaultFetchTool(): FetchTool {
  return {
    fetch: async (url: string, signal?: AbortSignal) => fetchWithLocalPrimary(url, 20000, {
      fetchImpl: async (targetUrl, init) => await fetch(targetUrl, init),
      signal,
    }),
  };
}

function createDefaultSearchTool(): SearchTool {
  const fetchImpl = async (
    url: string,
    init?: { headers?: Record<string, string>; method?: string; body?: string; signal?: AbortSignal },
  ) => await fetch(url, init);

  return {
    search: async (query: string, signal?: AbortSignal) => {
      const response = await searchWithCloudflareLocal(query, {
        fetchImpl: async (url, requestSignal) => await fetchImpl(url, { signal: requestSignal }),
        signal,
        webSearchArgs: buildDefaultAutoWebSearchArgs(query),
        providerSearches: [
          createNdrcPolicySearchProvider({ fetchImpl }),
          createMiitPolicySearchProvider({ fetchImpl }),
          createGovCnPolicyLibraryProvider({ fetchImpl }),
        ],
      });
      return response.results;
    },
  };
}

type OwnedToolset = {
  searchTool: SearchTool;
  fetchTool: FetchTool;
  close?: () => Promise<void>;
};

async function createDefaultToolset(): Promise<OwnedToolset> {
  return {
    searchTool: createDefaultSearchTool(),
    fetchTool: createDefaultFetchTool(),
  };
}

async function writeDebugTraceArtifact(filePath: string, task: { topic: string }, events: DebugEvent[]): Promise<void> {
  await writeRunTranscript(filePath, {
    task,
    events,
  }, { mode: 'debug' });
}

export async function runPolicyTaskLoop(
  input: { topic: string },
  options: {
    maxIterations?: number;
    askAgent?: (state: PolicyAgentState, signal?: AbortSignal) => Promise<PolicyAgentDecision>;
    callModel?: (prompt: string, signal?: AbortSignal) => Promise<string>;
    searchTool?: SearchTool;
    fetchTool?: FetchTool;
    browserAdapter?: BrowserAdapter;
    onDebugEvent?: (event: DebugEvent) => void;
    onRawModelOutput?: (rawText: string) => void | Promise<void>;
    signal?: AbortSignal;
    fromDate?: string;
    toDate?: string;
    enableBrowser?: boolean;
    targetHotspotCount?: number;
    targetValidatedEvidenceCount?: number;
    createToolset?: () => Promise<OwnedToolset>;
  } = {},
): Promise<PolicyAgentState & {
  decision: PolicyAgentDecision;
  loop_interrupted_by_gate?: boolean;
  final_quality_status?: string;
  final_quality_reason?: string;
}> {
  const maxIterations = options.maxIterations ?? 4;
  const dateWindow = options.fromDate && options.toDate ? { start: options.fromDate, end: options.toDate } : undefined;
  let state: PolicyAgentState = {
    task: input,
    discoveredCandidates: [],
    fetchedEvidence: [],
    currentIteration: 0,
    uncertainties: [],
    targetHotspotCount: options.targetHotspotCount ?? 0,
    targetValidatedEvidenceCount: options.targetValidatedEvidenceCount ?? 0,
  };
  let fullAuditState: PolicyAgentState = state;
  const ownedToolset = options.searchTool && options.fetchTool
    ? null
    : await (options.createToolset?.() ?? createDefaultToolset());
  const searchTool = options.searchTool ?? ownedToolset?.searchTool ?? createDefaultSearchTool();
  const baseFetchTool = options.fetchTool ?? ownedToolset?.fetchTool ?? createDefaultFetchTool();
  const fetchTool = createPersistentFetchTool(
    options.enableBrowser
      ? {
          fetch: async (url: string, signal?: AbortSignal) => fetchWithBrowserFallback(url, {
            staticFetch: async (targetUrl, requestSignal) => {
              const record = await baseFetchTool.fetch(targetUrl, requestSignal);
              return {
                title: record.title,
                content: record.content,
                finalUrl: record.finalUrl,
              };
            },
            browser: options.browserAdapter,
            now: new Date().toISOString(),
            dateWindow: dateWindow
              ? { start: String(dateWindow.start), end: String(dateWindow.end) }
              : undefined,
            signal,
          }),
        }
      : baseFetchTool,
    { taskTopic: input.topic },
  );

  let lastDecision: PolicyAgentDecision | null = null;
  let currentTurnAnchorUrl: string | undefined;
  let primaryError: unknown;

  try {
    for (let index = 0; index < maxIterations; index += 1) {
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
      const iterationInputState = pruneDiscoveryContext(state, currentTurnAnchorUrl);
      const result = await runLocalPolicyAgentIteration(iterationInputState, {
        askAgent: options.askAgent
          ? async (currentState) => {
              const prunedState = pruneDiscoveryContext(currentState, currentTurnAnchorUrl);

              return await options.askAgent?.(prunedState, options.signal);
            }
          : undefined,
        callModel: options.callModel,
        searchTool,
        fetchTool,
        onDebugEvent: options.onDebugEvent,
        onRawModelOutput: options.onRawModelOutput,
        signal: options.signal,
      });

      const discoveredDelta = result.discoveredCandidates.slice(iterationInputState.discoveredCandidates.length);
      const fetchedDelta = result.fetchedEvidence.slice(iterationInputState.fetchedEvidence.length);

      const assessedFetchedEvidence = applyEvidenceAssessments(
        result.fetchedEvidence,
        result.decision.evidenceAssessments,
      );

      fullAuditState = {
        task: result.task,
        discoveredCandidates: [...fullAuditState.discoveredCandidates, ...discoveredDelta],
        fetchedEvidence: assessedFetchedEvidence,
        transcriptPath: result.transcriptPath,
        currentIteration: result.currentIteration,
        uncertainties: result.uncertainties,
        transportFacts: result.transportFacts,
        transportOutcome: result.transportOutcome,
        protocolErrors: result.protocolErrors,
        convergencePhase: result.convergencePhase ?? fullAuditState.convergencePhase,
        targetHotspotCount: result.targetHotspotCount ?? fullAuditState.targetHotspotCount ?? options.targetHotspotCount ?? 0,
        targetValidatedEvidenceCount: result.targetValidatedEvidenceCount ?? fullAuditState.targetValidatedEvidenceCount ?? options.targetValidatedEvidenceCount ?? 0,
      };
      state = fullAuditState;
      lastDecision = result.decision;
      currentTurnAnchorUrl = result.decision.fetchActions.at(-1)?.url;

      if (['finalize', 'stop', 'summarize_and_stop'].includes(result.decision.decision)) {
        if (result.decision.decision === 'finalize' && result.transportOutcome?.status !== 'healthy') {
          return {
            ...fullAuditState,
            decision: result.decision,
            loop_interrupted_by_gate: true,
            final_quality_status: result.transportOutcome.status,
            final_quality_reason: 'Finalization blocked because one or more transport operations failed.',
          };
        }
        return { ...fullAuditState, decision: result.decision };
      }

    }

    if (!lastDecision) {
      throw new Error('Policy task loop ended before any decision was produced.');
    }

    return {
      ...fullAuditState,
      decision: lastDecision,
      loop_interrupted_by_gate: true,
      final_quality_reason: 'Maximum policy iterations reached before the model produced a terminal decision.',
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (ownedToolset?.close) {
      try {
        await ownedToolset.close();
      } catch (cleanupError) {
        options.onDebugEvent?.({
          type: 'mcp.cleanup.failure',
          payload: {
            cleanupError: summarizeError(cleanupError),
            ...(primaryError ? { originalError: summarizeError(primaryError) } : {}),
          },
        });
        if (!primaryError) throw cleanupError;
      }
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
    createToolset?: () => Promise<OwnedToolset>;
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

  let ownedToolset: OwnedToolset | null = null;
  let primaryError: unknown;
  try {
    if (!options.searchTool || !options.fetchTool) {
      ownedToolset = await (options.createToolset?.() ?? createDefaultToolset());
    }
    const searchTool = options.searchTool ?? ownedToolset?.searchTool ?? createDefaultSearchTool();
    if (!searchTool) {
      throw new Error('Default search tool is unavailable.');
    }
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
        searchTool,
        fetchTool: createPersistentFetchTool(options.fetchTool ?? ownedToolset?.fetchTool ?? createDefaultFetchTool(), { taskTopic: input.topic }),
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
    primaryError = error;
    if (options.debug) {
      debugEvents.push({
        type: 'run.failure',
        payload: summarizeError(error),
      });
      await writeDebugTraceArtifact(debugTracePath, input, debugEvents);
    }
    throw error;
  } finally {
    if (ownedToolset?.close) {
      try {
        await ownedToolset.close();
      } catch (cleanupError) {
        const event: DebugEvent = {
          type: 'mcp.cleanup.failure',
          payload: {
            cleanupError: summarizeError(cleanupError),
            ...(primaryError ? { originalError: summarizeError(primaryError) } : {}),
          },
        };
        onDebugEvent(event);
        if (options.debug) {
          try {
            await writeDebugTraceArtifact(debugTracePath, input, debugEvents);
          } catch {
            // Preserve the original run or cleanup error.
          }
        }
        if (!primaryError) throw cleanupError;
      }
    }
  }
}
