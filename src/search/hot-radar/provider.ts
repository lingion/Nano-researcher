// src/search/hot-radar/provider.ts
import type { SearchProvider } from '../provider.ts';
import type { SearchResponse } from '../../agent/types.ts';
import { collectAllSources, type HotRadarRecord } from './sources.ts';

export interface HotRadarProviderOptions {
  collect?: typeof collectAllSources;
  limit?: number;
}

export class HotRadarSearchProvider implements SearchProvider {
  readonly name = 'hot-radar';
  readonly capabilities = ['general-web', 'hot-board', 'multi-source'] as const;

  constructor(private readonly options: HotRadarProviderOptions = {}) {}

  async search(query: string, options: { signal?: AbortSignal } = {}): Promise<SearchResponse> {
    const started = Date.now();
    if (options.signal?.aborted) return { outcome: 'success_empty', results: [], provider: this.name, durationMs: 0, retryCount: 0 };
    const { records } = await this.options.collect?.({}) ?? await collectAllSources({});
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matched = tokens.length
      ? records.filter((r) => tokens.some((t) => r.title.toLowerCase().includes(t)))
      : records;
    const board = matched.length ? matched : records;
    const limited = board.slice(0, this.options.limit ?? 20);
    const results = limited.map((r, i) => this.toSearchResult(r, i + 1));
    return {
      outcome: results.length ? 'success_with_content' : 'success_empty',
      results,
      provider: this.name,
      durationMs: Date.now() - started,
      retryCount: 0,
    };
  }

  private toSearchResult(record: HotRadarRecord, rank: number) {
    const hotPart = record.hot ? ` | 热度=${record.hot}` : '';
    return {
      query: '',
      title: record.title,
      url: record.url,
      snippet: `[${record.source}]${hotPart}${record.extra ? ` | ${record.extra}` : ''}`,
      provider: this.name,
      rank,
      metadata: { hotBoardSource: record.source, hot: record.hot },
    };
  }
}
