const BASE_URL = 'https://www.so.com';
import { createProviderSession } from './session.js';

export async function search360(query, context = {}) {
  const limit = Math.max(1, Math.min(50, Number(context.limit) || 10));
  const started = Date.now();
  try {
    const session = createProviderSession({ ...context, maxRequests: 2 });
    await session.get(`${BASE_URL}/`, { accept: 'text/html,*/*' });
    const url = `${BASE_URL}/s?pn=1&q=${encodeURIComponent(query)}`;
    const { response, text: html } = await session.get(url, { headers: { 'accept-language': 'zh-CN,zh;q=0.9' } });
    const results = [];
    const cardRe = /<li\b[^>]*class=["'][^"']*res-list[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
    for (const match of html.matchAll(cardRe)) {
      if (results.length >= limit) break;
      const card = match[1];
      const anchor = card.match(/<h3\b[^>]*class=["'][^"']*res-title[^"']*["'][^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>/i);
      if (!anchor) continue;
      const attrs = anchor[1];
      const urlMatch = attrs.match(/\bdata-mdurl\s*=\s*["']([^"']+)/i) || attrs.match(/\bhref\s*=\s*["']([^"']+)/i);
      if (!urlMatch?.[1]) continue;
      const title = clean(anchor[2]);
      const snippet = clean(card.match(/<(?:p|span)\b[^>]*class=["'][^"']*(?:res-desc|res-list-summary)[^"']*["'][^>]*>([\s\S]*?)<\/(?:p|span)>/i)?.[1] || '');
      if (title && /^https?:\/\//i.test(urlMatch[1])) results.push({ title, url: urlMatch[1], snippet, provider: '360', rank: results.length + 1 });
    }
    return { records: results, provider: '360', durationMs: Date.now() - started, diagnostics: { status: response.status, blocked: /captcha|verify|验证码/i.test(html), parserVersion: 'searxng-360-v2', requestCount: session.requestCount } };
  } catch (error) {
    return { records: [], provider: '360', durationMs: Date.now() - started, diagnostics: { error: { code: 'ENGINE_FAILED', message: error instanceof Error ? error.message : String(error) } } };
  }
}

function clean(value) { return String(value || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim(); }
