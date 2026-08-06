import type { SearchResponse } from '../../../agent/types.ts';
import type { EngineContext } from '../contracts.ts';
import { SearchResponseEngine } from '../engine-runner.ts';
import { normalizeSourceProvenance } from './result.js';

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

type RawProviderResponse = {
  records?: Array<Record<string, unknown>>;
  diagnostics?: Record<string, unknown>;
  provider?: string;
  durationMs?: number;
  retryCount?: number;
  error?: { code: string; message: string };
};

export function normalizeResponse(value: RawProviderResponse | undefined, query: string, provider: string): SearchResponse {
  value = value ?? {};
  const rawRecords = value.records;
  const records = Array.isArray(rawRecords) ? rawRecords : [];
  const normalizedResults = records.map((record, index) => {
    const sourceProvenance = normalizeSourceProvenance(record.sourceProvenance);
    return {
      query,
      title: String(record.title ?? record.url ?? 'Untitled result'),
      url: String(record.url ?? ''),
      snippet: String(record.snippet ?? ''),
      provider: String(record.provider ?? provider),
      rank: finiteNumber(record.rank) ?? index + 1,
      providerRank: finiteNumber(record.providerRank) ?? finiteNumber(record.rank) ?? index + 1,
      ...(typeof record.sourceFamily === 'string' ? { sourceFamily: record.sourceFamily } : {}),
      ...(typeof record.resultType === 'string' ? { resultType: record.resultType } : {}),
      ...(finiteNumber(record.authorityScore) !== undefined ? { authorityScore: finiteNumber(record.authorityScore) } : {}),
      ...(sourceProvenance ? { sourceProvenance } : {}),
      ...(typeof record.displayUrl === 'string' ? { displayUrl: record.displayUrl } : {}),
      ...(typeof record.resolvedUrl === 'string' ? { resolvedUrl: record.resolvedUrl } : {}),
      ...(typeof record.publishedAt === 'string' ? { publishedAt: record.publishedAt } : {}),
      ...(typeof record.updatedAt === 'string' ? { updatedAt: record.updatedAt } : {}),
      ...(record.unresolvedWrapper === true ? { unresolvedWrapper: true } : {}),
      metadata: {
        ...(record.score === undefined ? {} : { score: record.score }),
        ...(record.metadata && typeof record.metadata === 'object' ? record.metadata as Record<string, unknown> : {}),
      },
    };
  }).filter((item) => item.url);
  const rawDiagnostics = value.diagnostics ?? {};
  const explicitError = value.error ?? asError(rawDiagnostics.error);
  const parserError = !normalizedResults.length && (records.length > 0 || rawRecords !== undefined && !Array.isArray(rawRecords))
    ? { code: 'PARSER_FAILURE', message: 'Provider response contained no usable result URLs' }
    : undefined;
  const rawError = explicitError ?? diagnosticError(rawDiagnostics) ?? parserError;
  const outcome = rawError ? classifyEmptyOutcome(rawDiagnostics, rawError) : normalizedResults.length ? 'success_with_content' : classifyEmptyOutcome(rawDiagnostics);
  const retryCount = Math.max(finiteNumber(value.retryCount) ?? 0, finiteNumber(rawDiagnostics.retryCount) ?? 0, sumAttemptField(rawDiagnostics, 'retryCount'));
  const durationMs = finiteNumber(value.durationMs) ?? finiteNumber(rawDiagnostics.durationMs) ?? 0;
  const details = { ...rawDiagnostics };
  if (rawError) details.error = rawError;
  const diagnostic = {
    provider,
    outcome,
    durationMs,
    resultCount: normalizedResults.length,
    requestCount: Math.max(finiteNumber(rawDiagnostics.requestCount) ?? 0, attemptRequestCount(rawDiagnostics), attemptCount(rawDiagnostics)) || 1,
    details,
    ...(rawError ? { error: rawError } : {}),
  };
  return {
    outcome,
    results: normalizedResults,
    provider,
    durationMs,
    retryCount,
    diagnostics: [diagnostic],
    ...(rawError ? { error: rawError } : {}),
  };
}

function classifyEmptyOutcome(diagnostics: Record<string, unknown>, error?: { code: string; message: string }): SearchResponse['outcome'] {
  if (diagnostics.blocked === true) return 'http_error';
  if (error) {
    if (error.code === 'timeout') return 'timeout';
    if (error.code === 'cancelled') return 'cancelled';
    if (error.code === 'http_status' || Number(diagnostics.status) >= 400) return 'http_error';
    return 'transport_error';
  }
  if (Number(diagnostics.status) >= 400) return 'http_error';
  if ((finiteNumber(diagnostics.parseFailures) ?? 0) > 0) return 'transport_error';
  return 'success_empty';
}

function diagnosticError(diagnostics: Record<string, unknown>): { code: string; message: string } | undefined {
  if (diagnostics.blocked === true) {
    return { code: 'PROVIDER_BLOCKED', message: String(diagnostics.blockReason || 'Provider blocked the request') };
  }
  if (Number(diagnostics.status) >= 400) {
    return { code: 'HTTP_STATUS', message: `Provider returned HTTP ${diagnostics.status}` };
  }
  if ((finiteNumber(diagnostics.parseFailures) ?? 0) > 0) {
    return { code: 'PARSER_FAILURE', message: 'Provider response could not be parsed into search results' };
  }
  return undefined;
}

function asError(value: unknown): { code: string; message: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') return undefined;
  return { code: candidate.code, message: candidate.message };
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function attemptCount(diagnostics: Record<string, unknown>): number {
  return Array.isArray(diagnostics.attempts) ? Math.max(0, diagnostics.attempts.length) : 0;
}

function sumAttemptField(diagnostics: Record<string, unknown>, field: string): number {
  if (!Array.isArray(diagnostics.attempts)) return 0;
  return diagnostics.attempts.reduce((sum, item) => sum + (item && typeof item === 'object' ? finiteNumber((item as Record<string, unknown>)[field]) ?? 0 : 0), 0);
}

function attemptRequestCount(diagnostics: Record<string, unknown>): number {
  if (!Array.isArray(diagnostics.attempts)) return 0;
  return diagnostics.attempts.reduce((sum, item) => sum + 1 + (item && typeof item === 'object' ? finiteNumber((item as Record<string, unknown>).retryCount) ?? 0 : 0), 0);
}
