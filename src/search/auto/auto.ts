import type { SearchResponse, SearchResult } from '../../agent/types.ts';
import type { AutoDiagnostics, AutoEngine } from './contracts.ts';
import { rankCandidates } from './fusion-ranker.js';

const DEFAULT_DEADLINE_MS = 15_000;
const DEFAULT_MAX_ENGINE_CALLS = 8;

export interface AutoOptions {
  engines: AutoEngine[];
  deadlineMs?: number;
  maxEngineCalls?: number;
  limit?: number;
  primaryEngineCount?: number;
  minResultsBeforeExpansion?: number;
}

export class AutoSearchProvider {
  readonly name = 'search-auto';
  readonly capabilities = ['general-web', 'multi-source', 'vertical-search'];

  constructor(private readonly options: AutoOptions) {}

  async search(query: string, options: { signal?: AbortSignal } = {}): Promise<SearchResponse> {
    const started = Date.now();
    const controller = new AbortController();
    const deadlineMs = this.options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    const maxEngineCalls = boundedEngineCalls(this.options.maxEngineCalls, this.options.engines.length);
    if (options.signal?.aborted) {
      return cancelledResponse(Date.now() - started);
    }
    const timer = setTimeout(() => controller.abort(new Error('Auto search deadline exceeded')), deadlineMs);
    const forwardAbort = () => controller.abort(options.signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    const engineResults = [] as AutoDiagnostics['engineResults'];
    const batches: string[][] = [];
    const limit = this.options.limit ?? 10;
    try {
      const eligible = this.options.engines.slice(0, maxEngineCalls);
      if (eligible.length && !controller.signal.aborted) {
        batches.push(eligible.map((engine) => engine.name));
        const deadlineAt = started + deadlineMs;
        const batchResults = await Promise.all(eligible.map((engine) => runEngineSafely(
          engine,
          query,
          controller.signal,
          options.signal,
          deadlineAt,
          limit,
          maxEngineCalls,
          () => controller.abort(new Error('Auto search deadline exceeded')),
        )));
        engineResults.push(...batchResults);
      }
      const candidates = engineResults.flatMap((item) => item.results.map((result) => ({
        ...result,
        provider: result.provider || item.engine,
        providerRank: result.providerRank ?? result.rank,
      })));
      const ranked = rankCandidates(candidates, query);
      const results = ranked.results.slice(0, limit) as SearchResult[];
      const diagnostics: AutoDiagnostics = {
        attemptedEngines: engineResults.map((item) => item.engine),
        engineResults,
        stoppedReason: controller.signal.aborted ? (options.signal?.aborted ? 'cancelled' : 'deadline') : engineResults.length >= maxEngineCalls && maxEngineCalls < this.options.engines.length ? 'engine_budget' : 'all_engines',
        batches,
        durationMs: Date.now() - started,
        uniqueResultCount: ranked.results.length,
        duplicateResultCount: ranked.rejected.duplicate,
        filteredResultCount: ranked.rejected.invalid + ranked.rejected.wrapper + ranked.rejected.quality + ranked.rejected.constraint,
        outputLimitedCount: Math.max(0, ranked.results.length - results.length),
        successfulEngineCount: engineResults.filter((item) => item.outcome === 'success_with_content').length,
        blockedEngineCount: engineResults.filter((item) => item.details?.blocked === true || item.error?.code === 'CAPTCHA' || item.error?.code === 'PROVIDER_BLOCKED').length,
      };
      let outcome: SearchResponse['outcome'];
      let error: SearchResponse['error'];
      if (options.signal?.aborted) {
        outcome = 'cancelled';
      } else if (controller.signal.aborted) {
        outcome = 'timeout';
        error = { code: 'AUTO_TIMEOUT', message: 'Auto search exceeded its deadline' };
      } else if (results.length) {
        outcome = 'success_with_content';
      } else {
        const emptyOutcome = aggregateEmptyOutcome(engineResults);
        outcome = emptyOutcome.outcome;
        error = emptyOutcome.error;
      }
      return {
        outcome,
        results,
        provider: this.name,
        durationMs: Date.now() - started,
        retryCount: engineResults.reduce((sum, item) => sum + item.retryCount, 0),
        ...(error ? { error } : {}),
        diagnostics: diagnostics.engineResults.map((item) => ({ provider: item.engine, outcome: item.outcome, durationMs: item.durationMs, resultCount: item.results.length, requestCount: item.requestCount, ...(item.details ? { details: item.details } : {}), ...(item.error ? { error: item.error } : {}) })),
        autoDiagnostics: {
          attemptedEngines: diagnostics.attemptedEngines,
          batches: diagnostics.batches,
          stoppedReason: diagnostics.stoppedReason,
          durationMs: diagnostics.durationMs,
          uniqueResultCount: diagnostics.uniqueResultCount,
          duplicateResultCount: diagnostics.duplicateResultCount,
          filteredResultCount: diagnostics.filteredResultCount,
          outputLimitedCount: diagnostics.outputLimitedCount,
          successfulEngineCount: diagnostics.successfulEngineCount,
          blockedEngineCount: diagnostics.blockedEngineCount,
        },
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', forwardAbort);
    }
  }
}

async function runEngineSafely(
  engine: AutoEngine,
  query: string,
  signal: AbortSignal,
  externalSignal: AbortSignal | undefined,
  deadlineAt: number,
  limit: number,
  maxEngineCalls: number,
  onDeadline: () => void,
): Promise<AutoDiagnostics['engineResults'][number]> {
  const started = Date.now();
  if (signal.aborted) {
    return { engine: engine.name, outcome: 'cancelled', results: [], durationMs: 0, requestCount: 0, retryCount: 0, error: { code: 'CANCELLED', message: 'Auto search was cancelled before the provider started' } };
  }
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  if (remainingMs === 0) {
    onDeadline();
    return { engine: engine.name, outcome: 'timeout', results: [], durationMs: 0, requestCount: 0, retryCount: 0, error: { code: 'AUTO_TIMEOUT', message: 'Auto search exceeded its deadline before the provider started' } };
  }
  let invocation: Promise<AutoDiagnostics['engineResults'][number]>;
  try {
    // Start synchronously so an engine can observe an abort that happens
    // immediately after search() returns its promise.
    invocation = engine.run(query, {
      signal,
      deadlineMs: remainingMs,
      request: { query, limit, signal, deadlineMs: remainingMs, maxEngineCalls },
    });
  } catch (error) {
    return {
      engine: engine.name,
      outcome: signal.aborted ? 'cancelled' : 'transport_error',
      results: [],
      durationMs: Date.now() - started,
      requestCount: 1,
      retryCount: 0,
      error: { code: 'ENGINE_FAILED', message: error instanceof Error ? error.message : String(error) },
    };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeExternalAbort: (() => void) | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onDeadline();
        reject(new Error('AUTO_ENGINE_TIMEOUT'));
      }, remainingMs);
    });
    const cancellation = externalSignal
      ? new Promise<never>((_, reject) => {
        const abort = () => reject(externalSignal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
        if (externalSignal.aborted) abort();
        else {
          externalSignal.addEventListener('abort', abort, { once: true });
          removeExternalAbort = () => externalSignal.removeEventListener('abort', abort);
        }
      })
      : undefined;
    return await Promise.race([invocation, deadline, ...(cancellation ? [cancellation] : [])]);
  } catch (error) {
    if (error instanceof Error && error.message === 'AUTO_ENGINE_TIMEOUT') {
      return {
        engine: engine.name,
        outcome: 'timeout',
        results: [],
        durationMs: Date.now() - started,
        requestCount: 0,
        retryCount: 0,
        error: { code: 'AUTO_TIMEOUT', message: 'Auto search exceeded its deadline while the provider was running' },
      };
    }
    return {
      engine: engine.name,
      outcome: signal.aborted ? 'cancelled' : 'transport_error',
      results: [],
      durationMs: Date.now() - started,
      requestCount: 1,
      retryCount: 0,
      error: { code: 'ENGINE_FAILED', message: error instanceof Error ? error.message : String(error) },
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeExternalAbort?.();
    void invocation.catch(() => undefined);
  }
}

function boundedEngineCalls(value: number | undefined, engineCount: number): number {
  if (!engineCount) return 0;
  const requested = Number(value ?? DEFAULT_MAX_ENGINE_CALLS);
  const bounded = Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_MAX_ENGINE_CALLS;
  return Math.min(engineCount, Math.max(0, bounded));
}

function cancelledResponse(durationMs: number): SearchResponse {
  return {
    outcome: 'cancelled',
    results: [],
    provider: 'search-auto',
    durationMs,
    retryCount: 0,
    diagnostics: [],
    autoDiagnostics: {
      attemptedEngines: [],
      batches: [],
      stoppedReason: 'cancelled',
      durationMs,
      uniqueResultCount: 0,
      duplicateResultCount: 0,
      filteredResultCount: 0,
      outputLimitedCount: 0,
      successfulEngineCount: 0,
      blockedEngineCount: 0,
    },
  };
}

type EmptyFailureOutcome = Extract<SearchResponse['outcome'], 'timeout' | 'http_error' | 'transport_error' | 'cancelled'>;

function aggregateEmptyOutcome(engineResults: AutoDiagnostics['engineResults']): { outcome: SearchResponse['outcome']; error?: SearchResponse['error'] } {
  for (const outcome of ['timeout', 'http_error', 'transport_error', 'cancelled'] as const) {
    const failed = engineResults.find((item) => item.outcome === outcome);
    if (!failed) continue;
    const failure: EmptyFailureOutcome = outcome;
    return {
      outcome: failure,
      error: failed.error ?? { code: `AUTO_${failure.toUpperCase()}`, message: `Search engine ${failed.engine} returned ${failure}` },
    };
  }
  return { outcome: 'success_empty' };
}
