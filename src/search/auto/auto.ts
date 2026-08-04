import type { SearchResponse, SearchResult } from '../../agent/types.ts';
import type { AutoDiagnostics, AutoEngine } from './contracts.ts';
import { rankCandidates } from './fusion-ranker.js';

const DEFAULT_DEADLINE_MS = 15_000;
const DEFAULT_MAX_ENGINE_CALLS = 3;

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
    const timer = setTimeout(() => controller.abort(new Error('Auto search deadline exceeded')), deadlineMs);
    const forwardAbort = () => controller.abort(options.signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    const engineResults = [] as AutoDiagnostics['engineResults'];
    const batches: string[][] = [];
    const limit = this.options.limit ?? 10;
    const maxEngineCalls = Math.min(this.options.maxEngineCalls ?? DEFAULT_MAX_ENGINE_CALLS, this.options.engines.length);
    try {
      const eligible = this.options.engines.slice(0, maxEngineCalls);
      const primaryCount = Math.max(1, Math.min(this.options.primaryEngineCount ?? 5, eligible.length));
      const engineBatches = [eligible.slice(0, primaryCount), eligible.slice(primaryCount)];
      for (const [index, batch] of engineBatches.entries()) {
        if (!batch.length || controller.signal.aborted) break;
        batches.push(batch.map((engine) => engine.name));
        const batchResults = await Promise.all(batch.map((engine) => {
          if (controller.signal.aborted) return null;
          return engine.run(query, { signal: controller.signal, deadlineMs, request: { query, limit, signal: controller.signal, deadlineMs, maxEngineCalls } });
        }));
        engineResults.push(...batchResults.filter((item): item is NonNullable<typeof item> => item !== null));
        const currentResults = rankCandidates(engineResults.flatMap((item) => item.results), query).results;
        const minimum = this.options.minResultsBeforeExpansion ?? Math.max(5, Math.min(limit, 8));
        if (index === 0 && currentResults.length >= minimum) break;
      }
      const candidates = engineResults.flatMap((item) => item.results.map((result) => ({
        ...result,
        provider: result.provider || item.engine,
        providerRank: result.rank,
      })));
      const results = rankCandidates(candidates, query).results.slice(0, limit) as SearchResult[];
      const diagnostics: AutoDiagnostics = {
        attemptedEngines: engineResults.map((item) => item.engine),
        engineResults,
        stoppedReason: controller.signal.aborted ? (options.signal?.aborted ? 'cancelled' : 'deadline') : batches.length === 1 && engineResults.length < maxEngineCalls ? 'quality_threshold' : engineResults.length >= maxEngineCalls ? 'engine_budget' : 'all_engines',
        batches,
        durationMs: Date.now() - started,
        uniqueResultCount: results.length,
        duplicateResultCount: Math.max(0, engineResults.reduce((sum, item) => sum + item.results.length, 0) - results.length),
        successfulEngineCount: engineResults.filter((item) => item.outcome === 'success_with_content').length,
        blockedEngineCount: engineResults.filter((item) => item.details?.blocked === true || item.error?.code === 'CAPTCHA').length,
      };
      return {
        outcome: results.length ? 'success_with_content' : controller.signal.aborted ? 'timeout' : 'success_empty',
        results,
        provider: this.name,
        durationMs: Date.now() - started,
        retryCount: engineResults.reduce((sum, item) => sum + item.retryCount, 0),
        diagnostics: diagnostics.engineResults.map((item) => ({ provider: item.engine, outcome: item.outcome, durationMs: item.durationMs, resultCount: item.results.length, requestCount: item.requestCount, ...(item.details ? { details: item.details } : {}), ...(item.error ? { error: item.error } : {}) })),
        autoDiagnostics: {
          attemptedEngines: diagnostics.attemptedEngines,
          batches: diagnostics.batches,
          stoppedReason: diagnostics.stoppedReason,
          durationMs: diagnostics.durationMs,
          uniqueResultCount: diagnostics.uniqueResultCount,
          duplicateResultCount: diagnostics.duplicateResultCount,
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
