import type { SearchResponse, SearchResult } from '../agent/types.ts';
import { describeSearchProvider, type SearchProvider, type SearchProviderDescriptor } from './provider.ts';

export interface SearchServiceOptions {
  providers: SearchProvider[];
  maxResultsPerProvider?: number;
}

export class SearchService implements SearchProvider {
  readonly name = 'search-service';
  readonly capabilities = ['aggregator'];

  constructor(private readonly options: SearchServiceOptions) {}

  listProviders(): SearchProviderDescriptor[] {
    return this.options.providers.map(describeSearchProvider);
  }

  async search(query: string, options: { signal?: AbortSignal } = {}): Promise<SearchResponse> {
    const started = Date.now();
    const results: SearchResult[] = [];
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
    const settled = await Promise.all(this.options.providers.map(async (provider) => {
      const providerStarted = Date.now();
      try {
        const response = await provider.search(query, options);
        return { provider: provider.name, response, durationMs: Date.now() - providerStarted };
      } catch (error) {
        return { provider: provider.name, response: null, durationMs: Date.now() - providerStarted, error: { code: 'PROVIDER_ERROR', message: error instanceof Error ? error.message : String(error) } };
      }
    }));
    let retryCount = 0;
    for (const item of settled) {
      if (item.response) {
        retryCount += item.response.retryCount;
        results.push(...item.response.results.slice(0, this.options.maxResultsPerProvider ?? 20));
      }
    }
    const unique = new Map<string, SearchResult>();
    for (const result of results) {
      if (!result.url || unique.has(result.url)) continue;
      unique.set(result.url, { ...result, rank: result.rank ?? unique.size + 1 });
    }
    const normalized = [...unique.values()];
    return {
      outcome: normalized.length ? 'success_with_content' : settled.some((item) => item.error || item.response?.outcome === 'transport_error') ? 'transport_error' : 'success_empty',
      results: normalized,
      provider: this.name,
      durationMs: Date.now() - started,
      retryCount,
      ...(!normalized.length ? { error: settled.find((item) => item.error)?.error ?? settled.find((item) => item.response?.error)?.response?.error } : {}),
      diagnostics: settled.map((item) => ({
        provider: item.provider,
        outcome: item.response?.outcome ?? 'transport_error',
        durationMs: item.durationMs,
        resultCount: item.response?.results.length ?? 0,
        ...(item.error || item.response?.error ? { error: item.error ?? item.response?.error } : {}),
      })),
    };
  }
}
