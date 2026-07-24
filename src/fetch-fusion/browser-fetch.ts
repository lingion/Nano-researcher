import type {
  AccessSignal,
  FreshnessStatus,
  FetchedPageRecord,
  PageRenderMode,
} from './types.js';

export interface BrowserRenderResult {
  finalUrl?: string;
  title?: string;
  text: string;
  html?: string;
}

export interface BrowserAdapter {
  render(url: string, options: { timeoutMs: number; maxChars: number }): Promise<BrowserRenderResult>;
}

export interface BrowserFetchOptions {
  staticFetch(url: string): Promise<{ title?: string; content?: string; finalUrl?: string }>;
  browser?: BrowserAdapter;
  now: string;
  maxChars?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const MIN_STATIC_CONTENT = 400;

const SIGNAL_PATTERNS: Array<[AccessSignal, RegExp]> = [
  ['gray_release', /灰度|灰度测试|灰度开放|gray[ -]?release|beta test/i],
  ['small_batch', /小范围|小批量|small[ -]?batch/i],
  ['waitlist', /候补|候补名单|等待名单|waitlist|waiting list/i],
  ['invite_only', /邀请制|邀请体验|邀请码|invite[- ]?only|invitation code/i],
  ['application_open', /申请体验|开放申请|申请报名|apply now|application open/i],
  ['developer_preview', /开发者预览|开发者体验|developer preview/i],
  ['limited_rollout', /有限 rollout|limited rollout|逐步开放|逐步推出/i],
  ['closed', /已关闭|关闭申请|closed/i],
  ['public_release', /正式发布|全面上线|公开发布|public release|一般可用/i],
];

function extractDate(text: string): string | undefined {
  const iso = text.match(/\b(20\d{2}-\d{1,2}-\d{1,2})\b/);
  if (iso) return normalizeDate(iso[1]);
  const chinese = text.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日?/);
  return chinese ? `${chinese[1]}-${chinese[2].padStart(2, '0')}-${chinese[3].padStart(2, '0')}` : undefined;
}

function normalizeDate(value: string): string {
  const [year, month, day] = value.split('-');
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function extractSignals(text: string): AccessSignal[] {
  return SIGNAL_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([signal]) => signal);
}

function freshness(date: string | undefined, now: string): FreshnessStatus {
  if (!date) return 'date_unknown';
  const today = now.slice(0, 10);
  return date >= '2026-04-01' && date <= today ? 'in_window' : 'out_of_window';
}

function staticNeedsBrowser(content: string): boolean {
  const readableChars = (content.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return content.length < MIN_STATIC_CONTENT
    || /enable javascript|javascript required|请启用 javascript|正在加载|loading\.\.\./i.test(content)
    || readableChars < 80;
}

export function createPlaywrightBrowserAdapter(): BrowserAdapter {
  return {
    async render(url, options) {
      const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
      const playwright = await dynamicImport('playwright');
      const browser = await playwright.chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.route('**/*', async (route: any) => {
          const type = route.request().resourceType();
          if (type === 'image' || type === 'font' || type === 'media') return route.abort();
          return route.continue();
        });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
        const text = (await page.locator('body').innerText()).slice(0, options.maxChars);
        return { finalUrl: page.url(), title: await page.title(), text };
      } finally {
        await browser.close();
      }
    },
  };
}

export async function fetchWithBrowserFallback(url: string, options: BrowserFetchOptions): Promise<FetchedPageRecord> {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const staticResult = await options.staticFetch(url);
  const staticContent = (staticResult.content ?? '').slice(0, maxChars);
  const base: FetchedPageRecord = {
    requestedUrl: url,
    finalUrl: staticResult.finalUrl ?? url,
    title: staticResult.title ?? '',
    content: staticContent,
    backend: 'static-fetch',
    pageRenderMode: 'static',
    lastVerifiedAt: options.now,
    freshnessStatus: freshness(extractDate(staticContent), options.now),
    accessSignals: extractSignals(`${staticResult.title ?? ''}\n${staticContent}`),
    dateEvidence: extractDate(staticContent) ? [extractDate(staticContent)!] : [],
    extractionWarnings: [],
  };

  if (!staticNeedsBrowser(staticContent)) return base;
  const browser = options.browser ?? createPlaywrightBrowserAdapter();
  try {
    const rendered = await browser.render(url, { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxChars });
    const text = rendered.text.slice(0, maxChars);
    const combined = `${rendered.title ?? ''}\n${text}`;
    const publishedAt = extractDate(combined);
    const signals = extractSignals(combined);
    return {
      ...base,
      finalUrl: rendered.finalUrl ?? base.finalUrl,
      title: rendered.title ?? base.title,
      content: text,
      backend: 'playwright',
      pageRenderMode: 'playwright' as PageRenderMode,
      publishedAt,
      accessSignals: signals,
      freshnessStatus: freshness(publishedAt, options.now),
      dateEvidence: publishedAt ? [publishedAt] : [],
      extractionWarnings: [],
    };
  } catch (error) {
    return {
      ...base,
      extractionWarnings: [`${error instanceof Error ? error.message : String(error)}`],
    };
  }
}
