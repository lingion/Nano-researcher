import type {
  AccessSignal,
  FreshnessStatus,
  FetchedPageRecord,
  PageRenderMode,
} from './types.js';
import { assertSafeNetworkTarget, assertSafeResolvedNetworkTarget, type NetworkLookup } from './network-safety.js';

export interface BrowserRenderResult {
  finalUrl?: string;
  title?: string;
  text: string;
  html?: string;
}

export interface BrowserAdapter {
  render(url: string, options: { timeoutMs: number; maxChars: number; signal?: AbortSignal }): Promise<BrowserRenderResult>;
  close(): Promise<void>;
}

interface PlaywrightPage {
  route(pattern: string, handler: (route: any) => Promise<unknown>): Promise<unknown>;
  goto(url: string, options: { waitUntil: string; timeout: number }): Promise<unknown>;
  url(): string;
  locator(selector: string): { innerText(): Promise<string> };
  title(): Promise<string>;
}

interface PlaywrightBrowserContext {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<unknown>;
}

export interface PlaywrightBrowser {
  isConnected(): boolean;
  once?(event: 'disconnected', listener: () => void): void;
  newContext(): Promise<PlaywrightBrowserContext>;
  close(): Promise<unknown>;
}

interface PermitWaiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

function browserError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function signalReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function configuredPositiveInteger(value: number | string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

class ContextPermitPool {
  private active = 0;
  private readonly queue: PermitWaiter[] = [];

  constructor(
    private readonly limit: number,
    private readonly maxQueue: number,
  ) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signalReason(signal));
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(browserError(
        'BROWSER_CONTEXT_QUEUE_FULL',
        `Browser context queue is full (${this.maxQueue}).`,
      ));
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: PermitWaiter = { resolve, reject, signal };
      waiter.abortListener = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signalReason(signal));
      };
      signal?.addEventListener('abort', waiter.abortListener, { once: true });
      this.queue.push(waiter);
    });
  }

  rejectQueued(error: unknown): void {
    for (const waiter of this.queue.splice(0)) {
      waiter.signal?.removeEventListener('abort', waiter.abortListener!);
      waiter.reject(error);
    }
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.dispatch();
    };
  }

  private dispatch(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      waiter.signal?.removeEventListener('abort', waiter.abortListener!);
      if (waiter.signal?.aborted) {
        waiter.reject(signalReason(waiter.signal));
        continue;
      }
      this.active += 1;
      waiter.resolve(this.createRelease());
    }
  }
}

class SharedBrowserManager {
  private browser?: PlaywrightBrowser;
  private browserPromise?: Promise<PlaywrightBrowser>;
  private generation = 0;
  private closePromise?: Promise<void>;
  private readonly contexts = new Set<PlaywrightBrowserContext>();
  private readonly permits: ContextPermitPool;

  constructor(
    private readonly launch: () => Promise<PlaywrightBrowser>,
    maxConcurrentContexts: number,
    maxQueuedContexts: number,
    private readonly networkLookup?: NetworkLookup,
  ) {
    this.permits = new ContextPermitPool(maxConcurrentContexts, maxQueuedContexts);
  }

  async render(url: string, options: { timeoutMs: number; maxChars: number; signal?: AbortSignal }): Promise<BrowserRenderResult> {
    if (this.closePromise) {
      throw browserError('BROWSER_CONTEXT_POOL_CLOSED', 'Browser context pool is closing.');
    }
    const release = await this.permits.acquire(options.signal);
    let context: PlaywrightBrowserContext | undefined;
    let abortContext: (() => void) | undefined;
    try {
      if (options.signal?.aborted) throw signalReason(options.signal);
      const browser = await this.getBrowser();
      if (options.signal?.aborted) throw signalReason(options.signal);
      context = await browser.newContext();
      this.contexts.add(context);
      abortContext = () => { void context?.close().catch(() => undefined); };
      options.signal?.addEventListener('abort', abortContext, { once: true });
      if (options.signal?.aborted) throw signalReason(options.signal);

      const page = await context.newPage();
      await page.route('**/*', async (route: any) => {
        const type = route.request().resourceType();
        if (type === 'image' || type === 'font' || type === 'media') return route.abort();
        try {
          await assertSafeResolvedNetworkTarget(route.request().url(), this.networkLookup);
          return route.continue();
        } catch {
          return route.abort();
        }
      });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
      if (options.signal?.aborted) throw signalReason(options.signal);
      const finalUrl = page.url();
      assertSafeNetworkTarget(finalUrl);
      const text = (await page.locator('body').innerText()).slice(0, options.maxChars);
      if (options.signal?.aborted) throw signalReason(options.signal);
      return { finalUrl, title: await page.title(), text };
    } finally {
      if (abortContext) options.signal?.removeEventListener('abort', abortContext);
      if (context) {
        this.contexts.delete(context);
        await context.close().catch(() => undefined);
      }
      release();
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const error = browserError('BROWSER_CONTEXT_POOL_CLOSED', 'Browser context pool was closed.');
    this.permits.rejectQueued(error);
    this.generation += 1;
    const current = this.browser;
    const launching = this.browserPromise;
    this.browser = undefined;
    this.browserPromise = undefined;
    const contexts = Array.from(this.contexts);

    this.closePromise = (async () => {
      await Promise.all(contexts.map(async (context) => { await context.close().catch(() => undefined); }));
      const pending = await launching?.catch(() => undefined);
      const browsers = new Set([current, pending].filter((browser): browser is PlaywrightBrowser => Boolean(browser)));
      await Promise.all(Array.from(browsers, async (browser) => { await browser.close().catch(() => undefined); }));
    })().finally(() => {
      this.closePromise = undefined;
    });
    return this.closePromise;
  }

  private async getBrowser(): Promise<PlaywrightBrowser> {
    if (this.closePromise) {
      throw browserError('BROWSER_CONTEXT_POOL_CLOSED', 'Browser context pool is closing.');
    }
    if (this.browser?.isConnected()) return this.browser;
    if (this.browserPromise) return await this.browserPromise;
    const launchGeneration = this.generation;
    let pending!: Promise<PlaywrightBrowser>;
    pending = this.launch().then(async (browser) => {
      if (launchGeneration !== this.generation) {
        await browser.close().catch(() => undefined);
        throw browserError('BROWSER_LAUNCH_INVALIDATED', 'Browser launch was invalidated by close.');
      }
      this.browser = browser;
      browser.once?.('disconnected', () => {
        if (this.browser === browser) this.browser = undefined;
      });
      return browser;
    }).finally(() => {
      if (this.browserPromise === pending) this.browserPromise = undefined;
    });
    this.browserPromise = pending;
    return await pending;
  }
}

export interface BrowserFetchOptions {
  staticFetch(url: string, signal?: AbortSignal): Promise<{ title?: string; content?: string; finalUrl?: string }>;
  browser?: BrowserAdapter;
  now: string;
  dateWindow?: { start: string; end: string };
  maxChars?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const MIN_STATIC_CONTENT = 400;
const DEFAULT_MAX_CONTEXTS = 2;
const DEFAULT_CONTEXT_QUEUE_SIZE = 16;

const managerRegistry = new Map<string, SharedBrowserManager>();
const launchIdentities = new WeakMap<Function, number>();
let nextLaunchIdentity = 1;

async function launchDefaultBrowser(executablePath?: string): Promise<PlaywrightBrowser> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
  const playwright = await dynamicImport('playwright');
  return await playwright.chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  }) as PlaywrightBrowser;
}

function launchIdentity(launch?: Function): string {
  if (!launch) return 'default';
  let identity = launchIdentities.get(launch);
  if (!identity) {
    identity = nextLaunchIdentity++;
    launchIdentities.set(launch, identity);
  }
  return `injected-${identity}`;
}

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

function freshness(date: string | undefined, now: string, dateWindow?: { start: string; end: string }): FreshnessStatus {
  if (!date) return 'date_unknown';
  const today = now.slice(0, 10);
  const start = dateWindow?.start ?? '2026-04-01';
  const end = dateWindow?.end ?? today;
  return date >= start && date <= end ? 'in_window' : 'out_of_window';
}

function staticNeedsBrowser(content: string): boolean {
  const readableChars = (content.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return content.length < MIN_STATIC_CONTENT
    || /enable javascript|javascript required|请启用 javascript|正在加载|loading\.\.\./i.test(content)
    || readableChars < 80;
}

export function createPlaywrightBrowserAdapter(adapterOptions: {
  executablePath?: string;
  maxConcurrentContexts?: number;
  maxQueuedContexts?: number;
  launch?: () => Promise<PlaywrightBrowser>;
  managerKey?: string;
  networkLookup?: NetworkLookup;
} = {}): BrowserAdapter {
  const maxConcurrentContexts = configuredPositiveInteger(
    adapterOptions.maxConcurrentContexts ?? process.env.PLAYWRIGHT_MAX_CONTEXTS,
    DEFAULT_MAX_CONTEXTS,
  );
  const maxQueuedContexts = configuredPositiveInteger(
    adapterOptions.maxQueuedContexts ?? process.env.PLAYWRIGHT_CONTEXT_QUEUE_CAPACITY,
    DEFAULT_CONTEXT_QUEUE_SIZE,
  );
  const launch = adapterOptions.launch ?? (() => launchDefaultBrowser(adapterOptions.executablePath));
  const key = adapterOptions.managerKey ?? [
    launchIdentity(adapterOptions.launch),
    adapterOptions.executablePath ?? 'bundled',
    maxConcurrentContexts,
    maxQueuedContexts,
  ].join('|');
  let manager = managerRegistry.get(key);
  if (!manager) {
    manager = new SharedBrowserManager(launch, maxConcurrentContexts, maxQueuedContexts, adapterOptions.networkLookup);
    managerRegistry.set(key, manager);
  }
  return {
    render(url, options) {
      assertSafeNetworkTarget(url);
      return manager!.render(url, options);
    },
    close() { return manager!.close(); },
  };
}

export async function fetchWithBrowserFallback(url: string, options: BrowserFetchOptions): Promise<FetchedPageRecord> {
  assertSafeNetworkTarget(url);
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
  }
  const staticResult = await options.staticFetch(url, options.signal);
  const staticContent = (staticResult.content ?? '').slice(0, maxChars);
  const base: FetchedPageRecord = {
    requestedUrl: url,
    finalUrl: staticResult.finalUrl ?? url,
    title: staticResult.title ?? '',
    content: staticContent,
    backend: 'static-fetch',
    pageRenderMode: 'static',
    lastVerifiedAt: options.now,
    freshnessStatus: freshness(extractDate(staticContent), options.now, options.dateWindow),
    accessSignals: extractSignals(`${staticResult.title ?? ''}\n${staticContent}`),
    dateEvidence: extractDate(staticContent) ? [extractDate(staticContent)!] : [],
    extractionWarnings: [],
  };

  if (!staticNeedsBrowser(staticContent)) return base;
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
  }
  const browser = options.browser ?? createPlaywrightBrowserAdapter();
  try {
    const rendered = await browser.render(url, {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxChars,
      signal: options.signal,
    });
    const finalUrl = rendered.finalUrl ?? base.finalUrl;
    assertSafeNetworkTarget(finalUrl);
    const text = rendered.text.slice(0, maxChars);
    const combined = `${rendered.title ?? ''}\n${text}`;
    const publishedAt = extractDate(combined);
    const signals = extractSignals(combined);
    return {
      ...base,
      finalUrl,
      title: rendered.title ?? base.title,
      content: text,
      backend: 'playwright',
      pageRenderMode: 'playwright' as PageRenderMode,
      publishedAt,
      accessSignals: signals,
      freshnessStatus: freshness(publishedAt, options.now, options.dateWindow),
      dateEvidence: publishedAt ? [publishedAt] : [],
      extractionWarnings: [],
    };
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? error;
    }
    if (error instanceof Error && /blocked unsafe network target/i.test(error.message)) {
      throw error;
    }
    return {
      ...base,
      extractionWarnings: [`${error instanceof Error ? error.message : String(error)}`],
    };
  }
}
