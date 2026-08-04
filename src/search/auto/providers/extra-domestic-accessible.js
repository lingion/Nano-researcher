export async function searchYandex(query, context = {}) {
  const session = createProviderSession({ ...context, maxRequests: 1 });
  const url = `https://yandex.com/search/site/?tmpl_version=releases&text=${encodeURIComponent(query)}&web=1&frame=1&searchid=3131712&lang=en`;
  try {
    const { text, response } = await session.get(url, { headers: { cookie: 'yp=1716337604.sp.family%3A0#1685406411.szm.1:1920x1080:1920x999' } });
    const diagnostics = { status: response.status, parserVersion: 'searxng-yandex-v2', requestCount: session.requestCount, blocked: response.headers.get('x-yandex-captcha') === 'captcha' || /are you not a robot|captcha/i.test(text) };
    if (diagnostics.blocked) return { records: [], provider: 'yandex', diagnostics };
    return { ...parseYandex(text, context.limit), provider: 'yandex', diagnostics };
  } catch (error) { return { records: [], provider: 'yandex', diagnostics: { requestCount: session.requestCount, error: { code: error.code || 'ENGINE_FAILED', message: error.message || String(error) } } }; }
}
export async function searchNaver(query, context = {}) {
  const started = Date.now();
  const session = createProviderSession({ ...context, maxRequests: 1 });
  try {
    const { response, text: html } = await session.get(`https://search.naver.com/search.naver?query=${encodeURIComponent(query)}&start=1&where=web`, { headers: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' } });
    const records = [];
    const pattern = /<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>(?:(?!<a\b)[\s\S])*?<span\b[^>]*class=["'][^"']*sds-comps-text-type-headline1[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;
    for (const match of html.matchAll(pattern)) {
      if (records.length >= (context.limit || 10)) break;
      const title = clean(match[2]);
      if (title) records.push({ title, url: match[1], snippet: '', provider: 'naver', rank: records.length + 1 });
    }
    return { records, provider: 'naver', durationMs: Date.now() - started, diagnostics: { status: response.status, parserVersion: 'naver-headline-v2', requestCount: session.requestCount } };
  } catch (error) {
    return { records: [], provider: 'naver', durationMs: Date.now() - started, diagnostics: { error: { code: 'ENGINE_FAILED', message: error instanceof Error ? error.message : String(error) } } };
  }
}
export async function searchMojeek(query, context = {}) {
  const session = createProviderSession({ ...context, maxRequests: 2 });
  try {
    const preferences = await session.get('https://www.mojeek.com/preferences', { headers: { 'accept-language': 'en-US,en;q=0.5' } });
    const language = preferences.text.match(/<select[^>]+name=["']lb["'][\s\S]*?<option[^>]+value=["']([^"']+)/i)?.[1] || 'all';
    const region = preferences.text.match(/<select[^>]+name=["']arc["'][\s\S]*?<option[^>]+value=["']([^"']+)/i)?.[1] || 'world';
    const url = `https://www.mojeek.com/search?q=${encodeURIComponent(query)}&safe=1&lb=${encodeURIComponent(language)}&arc=${encodeURIComponent(region)}`;
    const { text, response } = await session.get(url);
    const parsed = parseMojeek(text, context.limit);
    return { ...parsed, provider: 'mojeek', diagnostics: { status: response.status, parserVersion: 'searxng-mojeek-v2', requestCount: session.requestCount } };
  } catch (error) { return { records: [], provider: 'mojeek', diagnostics: { requestCount: session.requestCount, error: { code: error.code || 'ENGINE_FAILED', message: error.message || String(error) } } }; }
}

export async function searchDogpile(query, context = {}) {
  const started = Date.now();
  try {
    const response = await fetch('https://www.dogpile.com/api/search', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'Mozilla/5.0' }, body: JSON.stringify({ q: query, qadf: 'moderate', page: 1 }), signal: context.signal });
    const data = await response.json();
    const records = (Array.isArray(data.results) ? data.results : []).slice(0, context.limit || 10).map((item, index) => ({ title: clean(item.title), url: item.clickUrl, snippet: clean(item.description), provider: 'dogpile', rank: index + 1 })).filter((item) => item.title && /^https?:\/\//i.test(item.url || ''));
    return { records, provider: 'dogpile', durationMs: Date.now() - started, diagnostics: { status: response.status, parserVersion: 'searxng-dogpile-v1' } };
  } catch (error) { return { records: [], provider: 'dogpile', durationMs: Date.now() - started, diagnostics: { error: { code: 'ENGINE_FAILED', message: error instanceof Error ? error.message : String(error) } } }; }
}

async function htmlSearch(provider, url, context, cardRe, anchorClass) {
  const started = Date.now();
  try {
    const response = await fetch(url, { headers: { accept: 'text/html,*/*', 'user-agent': 'Mozilla/5.0', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' }, signal: context.signal });
    const html = await response.text();
    const records = [];
    for (const match of html.matchAll(cardRe)) {
      if (records.length >= (context.limit || 10)) break;
      const card = match[1];
      const anchor = card.match(new RegExp(`<a[^>]+(?:class=["'][^"']*${anchorClass}[^"']*["'][^>]*|href=["']([^"']+)["'])[^>]*>([\\s\\S]*?)</a>`, 'i'));
      const href = card.match(/\b(?:href|data-url)=["'](https?:\/\/[^"']+)/i)?.[1] || anchor?.[1];
      const title = clean(anchor?.[2] || card.match(/<h[234][^>]*>([\s\S]*?)<\/h[234]>/i)?.[1] || '');
      const snippet = clean(card.match(/<(?:p|div|span)[^>]*class=["'][^"']*(?:text|content|snippet|description|body)[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1] || '');
      if (title && /^https?:\/\//i.test(href || '')) records.push({ title, url: href, snippet, provider, rank: records.length + 1 });
    }
    return { records, provider, durationMs: Date.now() - started, diagnostics: { status: response.status, parserVersion: `searxng-${provider}-v1` } };
  } catch (error) { return { records: [], provider, durationMs: Date.now() - started, diagnostics: { error: { code: 'ENGINE_FAILED', message: error instanceof Error ? error.message : String(error) } } }; }
}
function parseYandex(html, limit = 10) { return parseCards(html, /<li\b[^>]*class=["'][^"']*serp-item[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi, /b-serp-item__title-link/, limit); }
function parseMojeek(html, limit = 10) { return parseCards(html, /<li\b[^>]*class=["'][^"']*results-standard[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi, 'ob', limit); }
function parseCards(html, cardRe, anchorClass, limit) { const records = []; for (const match of String(html).matchAll(cardRe)) { if (records.length >= (limit || 10)) break; const card = match[1]; const anchor = card.match(new RegExp(`<a[^>]+class=["'][^"']*${anchorClass}[\s\S]*?</a>`, 'i')); const href = card.match(/\b(?:href|data-url)=["'](https?:\/\/[^"']+)/i)?.[1] || anchor?.[0]?.match(/\bhref=["'](https?:\/\/[^"']+)/i)?.[1]; const title = clean(anchor?.[0] || card.match(/<h[234][^>]*>([\s\S]*?)<\/h[234]>/i)?.[1] || ''); const snippet = clean(card.match(/<(?:p|div|span)[^>]*class=["'][^"']*(?:text|content|snippet|description|body|s)[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1] || ''); if (title && /^https?:\/\//i.test(href || '')) records.push({ title, url: href, snippet, rank: records.length + 1 }); } return { records }; }

function clean(value) { return String(value || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim(); }
import { createProviderSession } from './session.js';
