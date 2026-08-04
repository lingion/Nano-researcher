import type { SearchResponse } from '../../agent/types.ts';
import type { AutoEngine, EngineContext, EngineResult } from './contracts.ts';

export type SearchImplementation = (query: string, context: EngineContext) => Promise<SearchResponse>;

export class SearchResponseEngine implements AutoEngine {
  constructor(
    readonly name: string,
    readonly capabilities: readonly string[],
    private readonly implementation: SearchImplementation,
  ) {}

  async run(query: string, context: EngineContext): Promise<EngineResult> {
    const started = Date.now();
    try {
      const response = await this.implementation(query, context);
      const diagnostics = response.diagnostics ?? [];
      const attempts = diagnostics.flatMap((item) => {
        const nested = item.details?.attempts;
        if (Array.isArray(nested)) return nested;
        return item.details?.url ? [item.details] : [];
      });
      const observedAttemptCount = attempts.length || diagnostics.length;
      const requestCount = diagnostics.reduce((sum, item) => sum + finiteNonNegative(item.requestCount), 0) || Math.max(1, observedAttemptCount);
      const retryCount = Math.max(
        finiteNonNegative(response.retryCount),
        attempts.reduce((sum, attempt) => sum + finiteNonNegative(attempt.retryCount), 0),
      );
      const detailSource = diagnostics.at(-1)?.details;
      const details = {
        ...(detailSource || {}),
        attemptCount: observedAttemptCount,
        ...(attempts.length ? { attempts } : {}),
      };
      return {
        engine: this.name,
        outcome: response.outcome === 'protocol_error' ? 'transport_error' : response.outcome as Exclude<import('../../agent/types.ts').ToolOutcome, 'protocol_error'>,
        results: response.results,
        durationMs: Date.now() - started,
        requestCount,
        retryCount,
        details,
        ...(response.error ? { error: response.error } : {}),
      };
    } catch (error) {
      return {
        engine: this.name,
        outcome: context.signal.aborted ? 'cancelled' : 'transport_error',
        results: [],
        durationMs: Date.now() - started,
        requestCount: 1,
        retryCount: 0,
        error: { code: 'ENGINE_FAILED', message: error instanceof Error ? error.message : String(error) },
      };
    }
  }
}

function finiteNonNegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
