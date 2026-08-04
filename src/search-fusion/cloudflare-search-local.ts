export * from './auto-router.js';

import {
  buildCloudflareAlignedSearchResponse,
  type CloudflareAlignedSearchResponse,
} from './response-builder.js';
import type {
  AccessSourceGrade,
  KerryQualityStatus,
  SearchDiscoveryRecord,
} from './types.js';
import { isRetryableRuntimeError, retryDelayMs } from '../runtime/reliability.ts';
import { safeSerializeDebugPayload } from '../runtime/sanitize-debug.js';

interface SearchProviderResult {
  title?: string;
  url?: string;
  snippet?: string;
  source?: string;
}

interface SearchProvider {
  (query: string, signal?: AbortSignal): Promise<SearchDiscoveryRecord[] | SearchProviderResult[]>;
}

interface WebSearchArgs {
  auto_mode?: string;
  engines?: string[];
}

function evaluateQuality(result: SearchDiscoveryRecord): {
  quality_status: 'green' | 'yellow';
  quality_reason: string;
} {
  const haystack = `${result.title} ${result.snippet} ${result.url}`;
  const officialLike = /\.gov\.cn|www\.gov\.cn|\.cn\/zwgk\//i.test(result.url);
  const policyLike = /政策|办法|通知|意见|细则|正文/i.test(haystack);

  if (officialLike || policyLike) {
    return {
      quality_status: 'green',
      quality_reason: 'official_or_policy_like',
    };
  }

  if (isWeakHomepageLikeResult(result)) {
    return {
      quality_status: 'yellow',
      quality_reason: 'weak_homepage_like',
    };
  }

  return {
    quality_status: 'yellow',
    quality_reason: 'unclassified_result',
  };
}

function appendAttemptMetadata(
  stage: 'provider' | 'websearch' | 'html-fallback',
  results: SearchDiscoveryRecord[],
): SearchDiscoveryRecord[] {
  return results.map((result) => ({
    ...result,
    ...evaluateQuality(result),
    sources: result.sources ?? [result.source],
    attempts: [...(result.attempts ?? []), { stage, source: result.source }],
  }));
}

export function normalizeSearchDiscovery(input: {
  query: string;
  results: Array<{ title?: string; url?: string; snippet?: string; source?: string }>;
}): SearchDiscoveryRecord[] {
  return input.results
    .filter((item) => typeof item.url === 'string' && item.url.trim() !== '')
    .map((item) => ({
      query: input.query,
      title: item.title ?? 'Untitled result',
      url: item.url as string,
      snippet: item.snippet ?? '',
      source: item.source ?? 'cloudflare-search-local',
    }));
}

function determineAccessSourceGrade(result: SearchDiscoveryRecord): AccessSourceGrade {
  const normalizedUrl = result.url.toLowerCase();
  const normalizedText = `${result.title} ${result.snippet}`.toLowerCase();

  if (!result.url || result.title.trim().length < 2 || /error|403|404|502|503/i.test(normalizedText)) {
    return 'corrupted';
  }

  const officialDomain = /https?:\/\/(?:www\.)?((openai|anthropic|google|deepmind|microsoft|meta|huggingface|openrouter|perplexity|mistral|cohere|stability|runwayml|cursor|replit|together|groq|replicate|modal|ollama|lmstudio|character|github)\.(com|ai|dev|app|cloud)|x\.com|github\.com)(?=\/|$)/i.test(normalizedUrl);
  const accessLike = /beta|alpha|preview|experimental|labs|early access|waitlist|invite|eligib|apply|join|developer|api|sdk/i.test(normalizedText);
  const docsLike = /docs?|documentation|developers?|api reference|sdk/i.test(normalizedText + normalizedUrl);
  const productLike = /launch|announce|release|model|product|agent|feature|platform/i.test(normalizedText);

  const domesticOfficialDomain = /https?:\/\/(?:www\.)?(?:bailian\.aliyun\.com|(?:baidu|bce|aliyun|alibabacloud|qianwen|tencent|volcengine|doubao|zhipu|bigmodel|moonshot|kimi|deepseek|minimaxi|xfyun|huawei|xiaomi|modelscope)\.(?:com|cn|ai|cloud|net)|(?:baidu|aliyun|tencent|volcengine|zhipu|moonshot|deepseek|minimaxi|huawei|xiaomi)\.com\.cn)(?=\/|$)/i.test(normalizedUrl);
  const mainlandContext = /中国大陆|大陆地区|中国区|国内|公测|内测|灰度|体验资格|申请入口|邀请码|候补|开发者预览|招募|报名|开放平台/i.test(normalizedText);
  const foreignOfficialOnly = officialDomain && !domesticOfficialDomain && !mainlandContext;
  if (foreignOfficialOnly) return 'noise';
  if (isWeakHomepageLikeResult(result)) return 'noise';
  if (domesticOfficialDomain && accessLike) return 'official_access';
  if (domesticOfficialDomain && docsLike) return 'official_docs';
  if (officialDomain && /github\.com/i.test(normalizedUrl)) return 'official_github';
  if (domesticOfficialDomain && productLike) return 'official_product';
  if (domesticOfficialDomain) return 'official_announcement';
  if (officialDomain && productLike && mainlandContext) return 'official_product';
  if (officialDomain && mainlandContext) return 'official_announcement';
  if (/reuters|techcrunch|theverge|wired|36kr|机器之心|量子位/i.test(normalizedText)) return 'credible_reporting';
  return 'noise';
}

function accessSourceGradeWeight(grade: AccessSourceGrade): number {
  if (grade === 'official_access') return 6;
  if (grade === 'official_docs') return 5;
  if (grade === 'official_product') return 5;
  if (grade === 'official_announcement') return 4;
  if (grade === 'official_github') return 4;
  if (grade === 'credible_reporting') return 2;
  if (grade === 'noise') return 1;
  return 0;
}

function scoreSearchResult(query: string, result: SearchDiscoveryRecord): number {
  let score = 0;
  const haystack = `${result.title} ${result.snippet} ${result.url}`;

  score += accessSourceGradeWeight(determineAccessSourceGrade(result)) * 100;

  if (/\.gov\.cn|www\.gov\.cn|\.cn\/zwgk\//i.test(result.url)) {
    score += 50;
  }
  if (/政策|办法|通知|意见|细则|正文/i.test(haystack)) {
    score += 20;
  }
  if (/新闻|资讯|门户|首页/i.test(haystack)) {
    score -= 10;
  }
  if (/科技|招商/i.test(query) && /科技|招商/i.test(haystack)) {
    score += 10;
  }

  return score;
}

function isWeakHomepageLikeResult(result: SearchDiscoveryRecord): boolean {
  const haystack = `${result.title} ${result.snippet} ${result.url}`;
  const isHomepageLikeUrl = /^https?:\/\/[^/]+\/?$/i.test(result.url)
    || /\/index\.(html?|php|shtml)$/i.test(result.url);
  return isHomepageLikeUrl && /新闻|资讯|门户|首页|政务公开|导航|服务/i.test(haystack);
}

function rankSearchResults(query: string, results: SearchDiscoveryRecord[]): SearchDiscoveryRecord[] {
  return [...results].sort((left, right) => scoreSearchResult(query, right) - scoreSearchResult(query, left));
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalizeUrl(input: string): string {
  try {
    const url = new URL(input);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/index\.(html?|php|shtml)$/i, '/');
    return url.toString();
  } catch {
    return input.trim();
  }
}

function normalizeTitle(input: string): string {
  return input
    .replace(/[\s\-_—|｜]+/g, '')
    .trim();
}

function dedupeSearchResults(results: SearchDiscoveryRecord[]): SearchDiscoveryRecord[] {
  const deduped = new Map<string, SearchDiscoveryRecord>();

  for (const result of results) {
    const canonicalUrl = canonicalizeUrl(result.url);
    const canonicalTitle = normalizeTitle(result.title);
    const key = `${canonicalUrl}::${canonicalTitle}`;
    const existing = deduped.get(key);

    if (!existing) {
      deduped.set(key, {
        ...result,
        url: canonicalUrl,
      });
      continue;
    }

    const mergedSnippet = existing.snippet.length >= result.snippet.length ? existing.snippet : result.snippet;
    const mergedSource = existing.source === result.source ? existing.source : `${existing.source},${result.source}`;

    const mergedSources = Array.from(new Set([...(existing.sources ?? [existing.source]), ...(result.sources ?? [result.source])]));
    const mergedAttempts = [...(existing.attempts ?? []), ...(result.attempts ?? [])];

    deduped.set(key, {
      ...existing,
      url: canonicalUrl,
      snippet: mergedSnippet,
      source: mergedSource,
      sources: mergedSources,
      attempts: mergedAttempts,
    });
  }

  return Array.from(deduped.values());
}

function parseSearchResultsFromHtml(html: string, query: string): SearchDiscoveryRecord[] {
  const patterns = [
    {
      link: /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis,
      snippet: /<a[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>(.*?)<\/a>/gis,
    },
    {
      link: /<h3[^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>\s*<\/h3>/gis,
      snippet: /<div[^>]*class=["'][^"']*c-abstract[^"']*["'][^>]*>(.*?)<\/div>/gis,
    },
  ];

  for (const pattern of patterns) {
    const snippets = Array.from(html.matchAll(pattern.snippet)).map((match) => stripHtml(match[1] ?? ''));
    const results = Array.from(html.matchAll(pattern.link)).map((match, index) => ({
      query,
      title: stripHtml(match[2] ?? ''),
      url: match[1] ?? '',
      snippet: snippets[index] ?? '',
      source: 'cloudflare-search-local',
    }));

    const normalized = rankSearchResults(query, normalizeSearchDiscovery({ query, results }));
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return [];
}

function determineKerryQualityState(results: SearchDiscoveryRecord[]): {
  status: KerryQualityStatus;
  reason: string;
} {
  if (results.length === 0) {
    return {
      status: 'empty',
      reason: 'All downstream engines and providers returned 0 documents.',
    };
  }

  const junkCount = results.filter((result) => {
    const grade = result.access_source_grade ?? determineAccessSourceGrade(result);
    return grade === 'noise' || grade === 'corrupted';
  }).length;

  if (junkCount / results.length >= 0.6) {
    return {
      status: 'junk_heavy',
      reason: 'Result pool is dominated by portal homepages or corrupted fragments.',
    };
  }

  const officialCount = results.filter((result) => {
    const grade = result.access_source_grade ?? determineAccessSourceGrade(result);
    return grade !== 'noise' && grade !== 'corrupted';
  }).length;

  if (officialCount > 0) {
    return {
      status: 'usable_results',
      reason: `Successfully aggregated ${officialCount} official AI product/access results.`,
    };
  }

  return {
    status: 'intent_mismatch',
    reason: 'Query returned active entries but lacks valid administrative policy text.',
  };
}

function attachAggregateMetadata(
  results: SearchDiscoveryRecord[],
  metadata: {
    fallback_used: boolean;
    filtered_count: number;
    merged_count: number;
    deduped_count: number;
  },
): SearchDiscoveryRecord[] {
  const gradedResults = results.map((result) => ({
    ...result,
    access_source_grade: determineAccessSourceGrade(result),
  }));
  const qualityState = determineKerryQualityState(gradedResults);

  return gradedResults.map((result) => ({
    ...result,
    ...metadata,
    kerry_quality_status: qualityState.status,
    kerry_quality_reason: qualityState.reason,
  }));
}

function diagnoseSearchLayers(input: {
  query: string;
  providerCount: number;
  globalSearchStatus: 'EXECUTED_SUCCESS' | 'SKIPPED_OR_UNDEFINED' | 'EXECUTED_EMPTY';
  fallbackResults: SearchDiscoveryRecord[];
}): void {
  if (process.env.LIVE_AUDIT_DEBUG !== '1') return;

  console.error('[SEARCH_LAYERED_DIAGNOSTICS]', safeSerializeDebugPayload({
    providerResultCount: input.providerCount,
    globalSearchStatus: input.globalSearchStatus,
    fallbackResultCount: input.fallbackResults.length,
    fallbackEmpty: input.fallbackResults.length === 0,
  }));
}

export async function searchWithCloudflareLocal(
  query: string,
  options: {
    fetchImpl?: (url: string, signal?: AbortSignal) => Promise<{ text: () => Promise<string> }>;
    providerSearches?: SearchProvider[];
    providerRetryAttempts?: number;
    providerRetryDelayMs?: number;
    webSearchArgs?: WebSearchArgs;
    currentRound?: number;
    signal?: AbortSignal;
  } = {},
): Promise<CloudflareAlignedSearchResponse> {
  const search = (globalThis as { WebSearch?: (input: { query: string; auto_mode?: string; engines?: string[] }) => Promise<Array<{ title?: string; url?: string; snippet?: string; source?: string }>> }).WebSearch;

  const collectedResults: SearchDiscoveryRecord[] = [];
  let filteredCount = 0;
  let fallbackUsed = false;
  let providerOutputCount = 0;
  let globalSearchStatus: 'EXECUTED_SUCCESS' | 'SKIPPED_OR_UNDEFINED' | 'EXECUTED_EMPTY' = typeof search === 'function'
    ? 'EXECUTED_EMPTY'
    : 'SKIPPED_OR_UNDEFINED';
  const fallbackResults: SearchDiscoveryRecord[] = [];

  const buildAlignedResponse = (results: SearchDiscoveryRecord[]) => buildCloudflareAlignedSearchResponse({
    query,
    currentRound: options.currentRound ?? 1,
    rawFoundCount: collectedResults.length,
    rawResults: results,
    metricsOverrides: {
      fallback_used: fallbackUsed,
      filtered_count: filteredCount,
      merged_count: collectedResults.length,
      deduped_count: Math.max(0, collectedResults.length - results.length),
    },
  });

  if (Array.isArray(options.providerSearches)) {
    for (const providerSearch of options.providerSearches) {
      const maxAttempts = Math.max(1, Math.min(3, Math.floor(options.providerRetryAttempts ?? 1)));
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const providerResults = await providerSearch(query, options.signal);
          const normalizedProviderResults = normalizeSearchDiscovery({
            query,
            results: providerResults as Array<{ title?: string; url?: string; snippet?: string; source?: string }>,
          });
          providerOutputCount += normalizedProviderResults.length;
          filteredCount += Math.max(0, (providerResults as Array<{ title?: string; url?: string; snippet?: string; source?: string }>).length - normalizedProviderResults.length);
          collectedResults.push(...appendAttemptMetadata(
            'provider',
            normalizedProviderResults,
          ));
          break;
        } catch (error) {
          if (options.signal?.aborted) throw error;
          if (attempt >= maxAttempts || !isRetryableRuntimeError(error)) break;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, options.providerRetryDelayMs ?? retryDelayMs(attempt));
            options.signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(options.signal?.reason ?? new Error('search aborted'));
            }, { once: true });
          });
        }
      }
    }
  }

  if (typeof search === 'function') {
    console.log('[SEARCH_REQUEST_METADATA]', safeSerializeDebugPayload({
      stage: 'websearch',
      currentRound: options.currentRound ?? 1,
      providerResultCount: collectedResults.length,
      autoMode: options.webSearchArgs?.auto_mode ?? null,
      engineCount: options.webSearchArgs?.engines?.length ?? 0,
    }));

    const results = await search({
      query,
      ...(options.webSearchArgs ?? {}),
    });
    const normalizedWebSearchResults = normalizeSearchDiscovery({ query, results });
    globalSearchStatus = normalizedWebSearchResults.length > 0 ? 'EXECUTED_SUCCESS' : 'EXECUTED_EMPTY';
    filteredCount += Math.max(0, results.length - normalizedWebSearchResults.length);
    collectedResults.push(...appendAttemptMetadata(
      'websearch',
      normalizedWebSearchResults,
    ));

    const webSearchDedupedResults = dedupeSearchResults(collectedResults);
    if (webSearchDedupedResults.some((result) => !isWeakHomepageLikeResult(result))) {
      return buildAlignedResponse(attachAggregateMetadata(
        rankSearchResults(query, webSearchDedupedResults),
        {
          fallback_used: fallbackUsed,
          filtered_count: filteredCount,
          merged_count: collectedResults.length,
          deduped_count: Math.max(0, collectedResults.length - webSearchDedupedResults.length),
        },
      ));
    }
  }

  if (typeof options.fetchImpl === 'function') {
    const fallbackUrls = [
      `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
    ];

    for (const url of fallbackUrls) {
      try {
        const response = await options.fetchImpl(url, options.signal);
        const html = await response.text();
        const parsedResults = appendAttemptMetadata(
          'html-fallback',
          parseSearchResultsFromHtml(html, query),
        );
        fallbackResults.push(...parsedResults);
        fallbackUsed = fallbackUsed || parsedResults.length > 0;
        const beforeCount = dedupeSearchResults(collectedResults).length;
        collectedResults.push(...parsedResults);
        const afterCount = dedupeSearchResults(collectedResults).length;
        if (afterCount > beforeCount) {
          break;
        }
      } catch {
        continue;
      }
    }
  }

  diagnoseSearchLayers({
    query,
    providerCount: providerOutputCount,
    globalSearchStatus,
    fallbackResults,
  });

  if (collectedResults.length === 0) {
    return buildAlignedResponse([]);
  }

  const dedupedResults = dedupeSearchResults(collectedResults);

  return buildAlignedResponse(attachAggregateMetadata(
    rankSearchResults(query, dedupedResults),
    {
      fallback_used: fallbackUsed,
      filtered_count: filteredCount,
      merged_count: collectedResults.length,
      deduped_count: Math.max(0, collectedResults.length - dedupedResults.length),
    },
  ));
}
