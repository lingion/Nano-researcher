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
      return {
        engine: this.name,
        outcome: response.outcome === 'timeout' ? 'timeout' : response.outcome === 'transport_error' ? 'transport_error' : response.outcome as Exclude<import('../../agent/types.ts').ToolOutcome, 'protocol_error' | 'cancelled'>,
        results: response.results,
        durationMs: Date.now() - started,
        requestCount: Number(response.diagnostics?.[0]?.requestCount || 1),
        retryCount: response.retryCount,
        details: response.diagnostics?.[0]?.details || undefined,
        ...(response.error ? { error: response.error } : {}),
      };
    } catch (error) {
      return {
        engine: this.name,
        outcome: context.signal.aborted ? 'timeout' : 'transport_error',
        results: [],
        durationMs: Date.now() - started,
        requestCount: 1,
        retryCount: 0,
        error: { code: 'ENGINE_FAILED', message: error instanceof Error ? error.message : String(error) },
      };
    }
  }
}
