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
  return {
    provider,
    attempted: true,
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
      requestCount: diagnostics.requestCount ?? 1
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

export function providerFailure({ provider, url, error }) {
  return {
    provider,
    attempted: true,
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
      url
    }
  };
}
