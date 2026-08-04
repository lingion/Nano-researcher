import { parseQuery } from "../query/query-parser.js";

export const PARSER_VERSION = "html-v2";

export function prepareProviderQuery(rawQuery) {
  const query = typeof rawQuery === "string" ? parseQuery(rawQuery) : rawQuery;
  // Keep the transport query lossless. Parsed fields remain available to the
  // fusion layer, but removing operators before the provider request breaks
  // site/date/phrase searches at the source.
  const text = String(query?.raw || query?.text || "").trim();
  return { query: query || parseQuery(""), text };
}

export function providerLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 10;
  return Math.max(1, Math.min(50, Math.floor(number)));
}

export function providerSuccess({ provider, sourceFamily, resultType, records, response, url, diagnostics = {} }) {
  const normalized = records.map((record, index) => ({
    ...record,
    displayUrl: record.displayUrl || record.url,
    provider,
    sourceFamily,
    resultType: record.resultType || resultType,
    providerRank: index + 1
  }));
  const attempts = Array.isArray(diagnostics.attempts) ? diagnostics.attempts : [attemptDiagnostic({ url, response, records, diagnostics, retryCount: diagnostics.retryCount ?? 0 })];
  const attemptRetryCount = sumAttempts(attempts, "retryCount");
  const attemptRequestCount = sumRequests(attempts);
  const retryCount = Math.max(Number(diagnostics.retryCount) || 0, attemptRetryCount);
  const requestCount = Math.max(Number(diagnostics.requestCount) || 0, attemptRequestCount);
  return {
    provider,
    attempted: true,
    durationMs: Number(diagnostics.durationMs) || 0,
    records: normalized,
    diagnostics: {
      status: response?.status ?? null,
      responseUrl: response?.url || url,
      parserVersion: diagnostics.parserVersion || PARSER_VERSION,
      parseFailures: diagnostics.parseFailures ?? 0,
      wrappers: normalized.filter((record) => record.unresolvedWrapper).length,
      blocked: diagnostics.blocked ?? false,
      blockReason: diagnostics.blockReason || "",
      markupFound: diagnostics.markupFound ?? true,
      ...(diagnostics.durationMs !== undefined ? { durationMs: diagnostics.durationMs } : {}),
      requestCount: requestCount || 1,
      retryCount,
      attempts
    }
  };
}

export function diagnoseHtml({ provider, html, responseUrl, recordCount }) {
  const body = String(html ?? "").toLowerCase();
  const finalUrl = String(responseUrl ?? "").toLowerCase();
  const marker = {
    bing: /\bb_algo\b/.test(body),
    baidu: /\bc-result\b|\bc-container\b/.test(body),
    sogou: /\bvrwrap\b|\bcitelinkclass\b/.test(body)
  }[provider] ?? false;
  const blockedUrl = /captcha|antispider|wappass|verify|unusual[-_ ]activity/.test(finalUrl);
  const blockedBody = !marker && /captcha|antispider|wappass|verify|unusual activity|验证码|安全验证/.test(body);
  const blocked = blockedUrl || blockedBody;
  return {
    blocked,
    blockReason: blocked ? "captcha_or_verification" : "",
    markupFound: marker,
    parseFailures: recordCount === 0 && !blocked ? 1 : 0
  };
}

export function providerFailure({ provider, url, error, diagnostics = {} }) {
  const attempts = Array.isArray(diagnostics.attempts) ? diagnostics.attempts : [attemptDiagnostic({ url, error, diagnostics, retryCount: diagnostics.retryCount ?? error?.retryCount ?? 0 })];
  const attemptRetryCount = sumAttempts(attempts, "retryCount");
  const attemptRequestCount = sumRequests(attempts);
  const retryCount = Math.max(Number(diagnostics.retryCount) || 0, attemptRetryCount);
  const requestCount = Math.max(Number(diagnostics.requestCount) || 0, attemptRequestCount);
  return {
    provider,
    attempted: true,
    durationMs: Number(diagnostics.durationMs) || 0,
    records: [],
    diagnostics: {
      status: error?.status ?? null,
      responseUrl: null,
      parserVersion: PARSER_VERSION,
      parseFailures: 0,
      wrappers: 0,
      error: {
        code: error?.code || "provider_error",
        message: error?.message || "Provider request failed"
      },
      url,
      ...(diagnostics.durationMs !== undefined ? { durationMs: diagnostics.durationMs } : {}),
      requestCount: requestCount || 1,
      retryCount,
      attempts
    }
  };
}

export function attemptDiagnostic({ url, response = undefined, records = [], diagnostics = {}, error, retryCount = error?.retryCount ?? 0 }) {
  const outcome = records.length
    ? "success_with_content"
    : diagnostics.blocked
      ? "http_error"
      : error?.code === "timeout"
        ? "timeout"
      : error?.code === "cancelled"
        ? "cancelled"
        : error?.code === "http_status" || Number(error?.status) >= 400 || Number(response?.status) >= 400
          ? "http_error"
        : error || diagnostics.parseFailures
            ? "transport_error"
            : "success_empty";
  return {
    url,
    responseUrl: response?.url || null,
    status: response?.status ?? error?.status ?? null,
    outcome,
    resultCount: records.length,
    retryCount: Number(retryCount) || 0,
    ...(diagnostics.blocked ? { blocked: true, blockReason: diagnostics.blockReason || "" } : {}),
    ...(error ? { error: { code: error.code || "provider_error", message: error.message || String(error) } } : {})
  };
}

function sumAttempts(attempts, field) {
  return attempts.reduce((sum, attempt) => sum + (attempt && typeof attempt === "object" ? Number(attempt[field]) || 0 : 0), 0);
}

function sumRequests(attempts) {
  return attempts.reduce((sum, attempt) => sum + 1 + (attempt && typeof attempt === "object" ? Number(attempt.retryCount) || 0 : 0), 0);
}
