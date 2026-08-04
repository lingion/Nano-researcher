const BASE_URL = 'https://quark.sm.cn/s';
import { createProviderSession } from './session.js';
import { DEFAULT_ANDROID_UA } from './http.js';

export async function searchQuark(query, context = {}) {
  const limit = Math.max(1, Math.min(50, Number(context.limit) || 10));
  const started = Date.now();
  const session = createProviderSession({ ...context, maxRequests: 1 });
  const url = `${BASE_URL}?q=${encodeURIComponent(query)}&layout=html&page=1`;
  try {
    const { response, text: html } = await session.get(url, { userAgent: context.userAgent || DEFAULT_ANDROID_UA, headers: { 'accept-language': 'zh-CN,zh;q=0.9' } });
    if (/\{[^{}]*"action"\s*:\s*"captcha"[^{}]*\}|x5sec|验证码/i.test(html)) return { records: [], provider: 'quark', durationMs: Date.now() - started, diagnostics: { status: response.status, blocked: true, blockReason: 'captcha_or_verification', requestCount: session.requestCount, parserVersion: 'searxng-quark-v2' } };
    const records = [];
    const scriptRe = /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
    for (const match of html.matchAll(scriptRe)) collectUrls(match[1], records, limit);
    return { records: records.slice(0, limit), provider: 'quark', durationMs: Date.now() - started, diagnostics: { status: response.status, blocked: false, requestCount: session.requestCount, parserVersion: 'searxng-quark-v2' } };
  } catch (error) {
    return { records: [], provider: 'quark', durationMs: Date.now() - started, diagnostics: { requestCount: session.requestCount, error: { code: error.code || 'ENGINE_FAILED', message: error instanceof Error ? error.message : String(error) } } };
  }
}

function collectUrls(raw, records, limit) {
  let data;
  try { data = JSON.parse(raw); } catch { return; }
  walk(data, records, limit);
}

function walk(value, records, limit) {
  if (records.length >= limit || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) walk(item, records, limit); return; }
  const url = typeof value.url === 'string' ? value.url : typeof value.source_url === 'string' ? value.source_url : '';
  const title = typeof value.title === 'string' ? value.title : '';
  const snippet = typeof value.content === 'string' ? value.content : typeof value.summary === 'string' ? value.summary : '';
  if (/^https?:\/\//i.test(url) && title) records.push({ title: clean(title), url, snippet: clean(snippet), provider: 'quark', rank: records.length + 1 });
  for (const child of Object.values(value)) walk(child, records, limit);
}

function clean(value) { return String(value || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim(); }
