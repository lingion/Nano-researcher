import type { SearchResponse } from '../../../agent/types.ts';
import type { EngineContext } from '../contracts.ts';
import { SearchResponseEngine } from '../engine-runner.ts';

import { searchBing } from './bing.js';
import { searchBaidu } from './baidu.js';
import { searchSogou } from './sogou.js';
import { search360 } from './360.js';
import { searchQuark } from './quark.js';
import { searchYandex, searchNaver, searchMojeek, searchDogpile } from './extra-domestic-accessible.js';

function contextForEngine(context: EngineContext): Record<string, unknown> {
  return {
    signal: context.signal,
    timeoutMs: Math.max(1, Math.min(context.deadlineMs, 5000)),
    limit: context.request.limit,
    retries: 1,
    retryDelayMs: 120,
  };
}

function htmlEngine(name: string, capabilities: readonly string[], implementation: (query: string, context: Record<string, unknown>) => Promise<{ records?: Array<Record<string, unknown>>; diagnostics?: Record<string, unknown> }>) {
  return new SearchResponseEngine(name, capabilities, async (query, context): Promise<SearchResponse> => normalizeResponse(await implementation(query, contextForEngine(context)), query, name));
}

export const builtInSearchEngines = [
  new SearchResponseEngine('bing', ['general-web', 'chinese-web'], async (query, context): Promise<SearchResponse> => {
    const response = await searchBing(query, contextForEngine(context));
    return normalizeResponse(response, query, 'bing');
  }),
  new SearchResponseEngine('baidu', ['chinese-web'], async (query, context): Promise<SearchResponse> => {
    const response = await searchBaidu(query, contextForEngine(context));
    return normalizeResponse(response, query, 'baidu');
  }),
  new SearchResponseEngine('sogou', ['chinese-web'], async (query, context): Promise<SearchResponse> => {
    const response = await searchSogou(query, contextForEngine(context));
    return normalizeResponse(response, query, 'sogou');
  }),
  htmlEngine('360', ['chinese-web'], search360),
  htmlEngine('quark', ['chinese-web', 'vertical-search'], searchQuark),
  htmlEngine('yandex', ['general-web'], searchYandex),
  htmlEngine('naver', ['general-web', 'korean-web'], searchNaver),
  new SearchResponseEngine('dogpile', ['general-web', 'multi-source'], async (query, context): Promise<SearchResponse> => normalizeResponse(await searchDogpile(query, contextForEngine(context)), query, 'dogpile')),
];

function normalizeResponse(value: { records?: Array<Record<string, unknown>>; diagnostics?: Record<string, unknown>; provider?: string } | undefined, query: string, provider: string): SearchResponse {
  value = value ?? {};
  const records = value.records ?? [];
  return {
    outcome: records.length ? 'success_with_content' : 'success_empty',
    results: records.map((record, index) => ({
      query,
      title: String(record.title ?? record.url ?? 'Untitled result'),
      url: String(record.url ?? ''),
      snippet: String(record.snippet ?? ''),
      provider,
      rank: index + 1,
      metadata: { sourceFamily: record.sourceFamily, resultType: record.resultType, score: record.score },
    })).filter((item) => item.url),
    provider,
    durationMs: 0,
    retryCount: 0,
    diagnostics: value.diagnostics ? [{ provider, outcome: records.length ? 'success_with_content' : 'success_empty', durationMs: 0, resultCount: records.length, details: value.diagnostics }] : undefined,
    ...(value.diagnostics?.error ? { error: value.diagnostics.error as { code: string; message: string } } : {}),
  };
}
