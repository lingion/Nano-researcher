import { pathToFileURL } from 'node:url';
import type { SearchResponse, SearchResult } from '../../agent/types.ts';
import type { SearchProvider } from '../provider.ts';

const MODULE = new URL('../../../vendor/search-mcp/src/index.js', import.meta.url);

export class LegacySearchMcpProvider implements SearchProvider {
  readonly name = 'search-mcp-multi-source';
  readonly capabilities = ['general-web', 'multi-source', 'news', 'scholarly', 'code', 'vertical-search'];
  readonly maxConcurrency = 1;
  private runner?: Promise<(args: Record<string, unknown>) => Promise<Record<string, unknown>>>;

  private load() {
    this.runner ??= import(pathToFileURL(MODULE.pathname).href).then((mod) => {
      if (typeof mod.runSearchAutoForCall !== 'function') throw new Error('legacy search MCP runner export missing');
      return mod.runSearchAutoForCall;
    });
    return this.runner;
  }

  async search(query: string, options: { signal?: AbortSignal } = {}): Promise<SearchResponse> {
    const started = Date.now();
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
    const timeoutMs = Number(process.env.SEARCH_MULTI_SOURCE_TIMEOUT_MS ?? 20_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`multi-source search timed out after ${timeoutMs}ms`)), timeoutMs);
    const abort = () => controller.abort(options.signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    options.signal?.addEventListener('abort', abort, { once: true });
    let response: Record<string, unknown>;
    try {
      response = await Promise.race([
        // Let auto select a bounded engine set first. Full fan-out is reserved
        // for explicit callers because it can exceed the agent run deadline.
        (await this.load())({ query, limit: 12, auto_mode: 'default' }),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        outcome: 'timeout',
        results: [],
        provider: this.name,
        durationMs: Date.now() - started,
        retryCount: 0,
        error: { code: 'MULTI_SOURCE_TIMEOUT', message },
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
    const raw = Array.isArray(response.results) ? response.results : [];
    const results: SearchResult[] = raw.map((item, index) => {
      const record = item as Record<string, unknown>;
      return {
        query,
        title: typeof record.title === 'string' ? record.title : String(record.url ?? 'Untitled result'),
        url: typeof record.url === 'string' ? record.url : '',
        snippet: typeof record.snippet === 'string' ? record.snippet : '',
        provider: typeof record.engine === 'string' ? record.engine : this.name,
        rank: typeof record.rank_within_engine === 'number' ? record.rank_within_engine : index + 1,
        metadata: {
          source: record.source,
          engine: record.engine,
          qualityStatus: record.quality_status,
          qualityReason: record.quality_reason,
          sources: record.sources,
        },
      };
    }).filter((item) => item.url);
    return {
      outcome: results.length ? 'success_with_content' : 'success_empty',
      results,
      provider: this.name,
      durationMs: Date.now() - started,
      retryCount: 0,
    };
  }
}
