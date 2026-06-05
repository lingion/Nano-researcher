export * from './auto-router.js';

import {
  buildCloudflareAlignedSearchResponse,
  type CloudflareAlignedSearchResponse,
} from './response-builder.js';
import type {
  KerryQualityStatus,
  PolicyGrade,
  SearchDiscoveryRecord,
} from './types.js';

interface SearchProviderResult {
  title?: string;
  url?: string;
  snippet?: string;
  source?: string;
}

interface SearchProvider {
  (query: string): Promise<SearchDiscoveryRecord[] | SearchProviderResult[]>;
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

function determinePolicyGrade(result: SearchDiscoveryRecord): PolicyGrade {
  const normalizedUrl = result.url.toLowerCase();
  const normalizedText = `${result.title} ${result.snippet}`.toLowerCase();

  if (!result.url || result.title.trim().length < 2 || /error|403|404|502|503/i.test(normalizedText)) {
    return 'corrupted';
  }

  const isOfficialDomain = /\.gov\.cn(?=\/|$)/i.test(normalizedUrl);

  if (isWeakHomepageLikeResult(result)) {
    return 'portal_homepage';
  }

  if (isOfficialDomain) {
    if (/解读|一图读懂|图解|答记者问|发布会/i.test(normalizedText)) {
      return 'official_interpretation';
    }

    if (/通知|办法|条例|细则|规划|意见|纲要|关于印发|正文|〔20\d{2}〕|第\d+号/i.test(normalizedText)) {
      return 'official_text';
    }

    return 'official_text';
  }

  if (/新华|人民网|报道|讯|政策|通知|办法|意见/i.test(normalizedText)) {
    return 'news_reprint';
  }

  return 'portal_homepage';
}

function policyGradeWeight(grade: PolicyGrade): number {
  if (grade === 'official_text') return 5;
  if (grade === 'official_interpretation') return 4;
  if (grade === 'news_reprint') return 3;
  if (grade === 'portal_homepage') return 2;
  return 1;
}

function scoreSearchResult(query: string, result: SearchDiscoveryRecord): number {
  let score = 0;
  const haystack = `${result.title} ${result.snippet} ${result.url}`;

  score += policyGradeWeight(determinePolicyGrade(result)) * 100;

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
    const grade = result.policy_grade ?? determinePolicyGrade(result);
    return grade === 'portal_homepage' || grade === 'corrupted';
  }).length;

  if (junkCount / results.length >= 0.6) {
    return {
      status: 'junk_heavy',
      reason: 'Result pool is dominated by portal homepages or corrupted fragments.',
    };
  }

  const officialCount = results.filter((result) => {
    const grade = result.policy_grade ?? determinePolicyGrade(result);
    return grade === 'official_text' || grade === 'official_interpretation';
  }).length;

  if (officialCount > 0) {
    return {
      status: 'usable_results',
      reason: `Successfully aggregated ${officialCount} official policy results.`,
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
    policy_grade: determinePolicyGrade(result),
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

  console.error('\n=== [SEARCH LAYERED DIAGNOSTICS] ===');
  console.error(`Current Query: "${input.query}"`);
  console.error(`[Layer 1 - Official Providers] Output count = ${input.providerCount} (NDRC, MIIT, gov.cn)`);
  console.error(`[Layer 2 - globalThis.WebSearch] Invocation Status = ${input.globalSearchStatus}`);
  console.error(`[Layer 3 - HTML Fallback] Extracted total = ${input.fallbackResults.length}`);
  if (input.fallbackResults.length === 0) {
    console.error('[Layer 3 Warning] Fallback HTML parsing returned 0. Possible causes: Anti-bot blocked, Network isolation, or Parser outdated.');
  } else {
    console.error(`[Layer 3 Sample] First result title: "${input.fallbackResults[0]?.title ?? 'No Title'}"`);
  }
  console.error('=== [END OF SEARCH DIAGNOSTICS] ===\n');
}

export async function searchWithCloudflareLocal(
  query: string,
  options: {
    fetchImpl?: (url: string) => Promise<{ text: () => Promise<string> }>;
    providerSearches?: SearchProvider[];
    webSearchArgs?: WebSearchArgs;
    currentRound?: number;
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
      const providerResults = await providerSearch(query);
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
    }
  }

  if (typeof search === 'function') {
    console.log('[FORENSIC] triggering real search request', JSON.stringify({
      query,
      stage: 'websearch',
      currentRound: options.currentRound ?? 1,
      providerResultCount: collectedResults.length,
      autoMode: options.webSearchArgs?.auto_mode ?? null,
      engines: options.webSearchArgs?.engines ?? null,
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
        const response = await options.fetchImpl(url);
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
    throw new Error(`[Search Fatal] Zero search results collected across all 3 layers (Providers, Global, Fallback) for query "${query}".`);
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
