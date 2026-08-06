const BASE_URL = 'https://quark.sm.cn/s';
import { createProviderSession } from './session.js';
import { DEFAULT_ANDROID_UA } from './http.js';
import { parseQuarkHtml } from './parsers.js';

const PARSER_VERSION = 'quark-hydration-v1';

function hasHydrationMarkup(html) {
  return /<script\b(?=[^>]*\bid\s*=\s*["']s-data-[^"']+["'])(?=[^>]*\bdata-used-by\s*=\s*["']hydrate["'])[^>]*>/i.test(html);
}

export async function searchQuark(query, context = {}) {
  const limit = Math.max(1, Math.min(50, Number(context.limit) || 10));
  const started = Date.now();
  const session = createProviderSession({ ...context, maxRequests: 1 });
  const url = `${BASE_URL}?q=${encodeURIComponent(query)}&layout=html&page=1`;
  try {
    const { response, text: html } = await session.get(url, { userAgent: context.userAgent || DEFAULT_ANDROID_UA, headers: { 'accept-language': 'zh-CN,zh;q=0.9' } });
    if (/\{[^{}]*"action"\s*:\s*"captcha"[^{}]*\}|x5sec|验证码/i.test(html)) return { records: [], provider: 'quark', durationMs: Date.now() - started, diagnostics: { status: response.status, blocked: true, blockReason: 'captcha_or_verification', requestCount: session.requestCount, parserVersion: PARSER_VERSION } };
    const records = parseQuarkHtml(html, limit);
    const markupFound = hasHydrationMarkup(html);
    return { records, provider: 'quark', durationMs: Date.now() - started, diagnostics: { status: response.status, blocked: false, markupFound, parseFailures: records.length === 0 && !markupFound ? 1 : 0, requestCount: session.requestCount, parserVersion: PARSER_VERSION } };
  } catch (error) {
    return { records: [], provider: 'quark', durationMs: Date.now() - started, diagnostics: { requestCount: session.requestCount, error: { code: error.code || 'ENGINE_FAILED', message: error instanceof Error ? error.message : String(error) } } };
  }
}
