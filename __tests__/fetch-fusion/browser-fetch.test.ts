import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  createPlaywrightBrowserAdapter,
  fetchWithBrowserFallback,
  type PlaywrightBrowser,
} from '../../src/fetch-fusion/browser-fetch.ts';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

function createFakeBrowser(options: {
  goto?: () => Promise<void>;
  innerText?: () => Promise<string>;
  onContextOpen?: () => void;
  onContextClose?: () => void;
  routeUrls?: string[];
  onRouteDecision?: (url: string, decision: 'continue' | 'abort') => void;
} = {}): PlaywrightBrowser & { disconnect(): void; closeCalls: number; contextCount: number } {
  const events = new EventEmitter();
  let connected = true;
  let contextCount = 0;
  const browser = {
    closeCalls: 0,
    get contextCount() { return contextCount; },
    isConnected: () => connected,
    once: (event: string, listener: () => void) => { events.once(event, listener); },
    async newContext() {
      contextCount += 1;
      options.onContextOpen?.();
      let closed = false;
      return {
        async newPage() {
          let routeHandler: ((route: any) => Promise<unknown>) | undefined;
          return {
            route: async (_pattern: string, handler: (route: any) => Promise<unknown>) => { routeHandler = handler; },
            goto: async () => {
              for (const url of options.routeUrls ?? []) {
                await routeHandler?.({
                  request: () => ({ resourceType: () => 'script', url: () => url }),
                  continue: async () => { options.onRouteDecision?.(url, 'continue'); },
                  abort: async () => { options.onRouteDecision?.(url, 'abort'); },
                });
              }
              await options.goto?.();
            },
            url: () => 'https://example.cn/rendered',
            locator: () => ({ innerText: options.innerText ?? (async () => 'rendered body') }),
            title: async () => 'rendered title',
          };
        },
        async close() {
          if (closed) return;
          closed = true;
          options.onContextClose?.();
        },
      };
    },
    async close() {
      browser.closeCalls += 1;
      if (!connected) return;
      connected = false;
      events.emit('disconnected');
    },
    disconnect() {
      connected = false;
      events.emit('disconnected');
    },
  };
  return browser;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

test('browser fetch extracts rendered beta page metadata', async () => {
  const result = await fetchWithBrowserFallback('https://example.cn/beta', {
    staticFetch: async () => ({ title: 'App', content: 'enable javascript' }),
    browser: {
      render: async () => ({
        title: '灰度招募',
        text: '2026-07-20 限量邀请体验，加入候补名单',
        finalUrl: 'https://example.cn/beta',
      }),
    },
    now: '2026-07-24T00:00:00.000Z',
  });
  assert.equal(result.pageRenderMode, 'playwright');
  assert.equal(result.publishedAt, '2026-07-20');
  assert.deepEqual(result.accessSignals, ['gray_release', 'waitlist', 'invite_only']);
});

test('playwright blocks unsafe literal and DNS-resolved subresources before route continuation', async () => {
  const decisions: Array<[string, string]> = [];
  const browser = createFakeBrowser({
    routeUrls: ['http://127.0.0.1/internal.js', 'https://private.example/internal.js', 'https://public.example/app.js'],
    onRouteDecision: (url, decision) => decisions.push([url, decision]),
  });
  const adapter = createPlaywrightBrowserAdapter({
    launch: async () => browser,
    managerKey: 'subresource-network-safety',
    networkLookup: async (hostname) => [{ address: hostname === 'private.example' ? '10.0.0.9' : '93.184.216.34', family: 4 }],
  });
  try {
    await adapter.render('https://public.example/page', { timeoutMs: 1_000, maxChars: 1_000 });
    assert.deepEqual(decisions, [
      ['http://127.0.0.1/internal.js', 'abort'],
      ['https://private.example/internal.js', 'abort'],
      ['https://public.example/app.js', 'continue'],
    ]);
  } finally {
    await adapter.close();
  }
});

test('browser fetch honors the caller date window instead of a hard-coded freshness range', async () => {
  const result = await fetchWithBrowserFallback('https://example.cn/beta', {
    staticFetch: async () => ({ title: 'App', content: 'enable javascript' }),
    browser: {
      render: async () => ({
        title: '灰度招募',
        text: '2026-02-20 限量邀请体验，加入候补名单',
        finalUrl: 'https://example.cn/beta',
      }),
    },
    now: '2026-07-24T00:00:00.000Z',
    dateWindow: { start: '2026-01-01', end: '2026-03-01' },
  });
  assert.equal(result.freshnessStatus, 'in_window');
});

test('browser fetch propagates abort signal to static and browser fetches', async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const pending = fetchWithBrowserFallback('https://example.cn/beta', {
    signal: controller.signal,
    staticFetch: async (_url, signal) => {
      observedSignal = signal;
      return { title: 'App', content: 'enable javascript' };
    },
    browser: {
      render: async (_url, options) => {
        assert.equal(options.signal, controller.signal);
        return await new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        });
      },
    },
    now: '2026-07-24T00:00:00.000Z',
  });

  controller.abort(new Error('run timed out'));
  await assert.rejects(pending, /run timed out/);
  assert.equal(observedSignal, controller.signal);
});

test('browser failure preserves static result and warning', async () => {
  const result = await fetchWithBrowserFallback('https://example.cn/beta', {
    staticFetch: async () => ({ title: '静态页', content: '正文内容' }),
    browser: { render: async () => { throw new Error('browser unavailable'); } },
    now: '2026-07-24T00:00:00.000Z',
  });
  assert.equal(result.pageRenderMode, 'static');
  assert.equal(result.content, '正文内容');
  assert.match(result.extractionWarnings?.[0] ?? '', /browser unavailable/);
});

test('browser fetch rejects unsafe rendered final URLs', async () => {
  await assert.rejects(
    fetchWithBrowserFallback('https://example.cn/beta', {
      staticFetch: async () => ({ title: 'App', content: 'enable javascript' }),
      browser: {
        render: async () => ({
          title: 'redirected',
          text: 'content',
          finalUrl: 'http://127.0.0.1:8080/internal',
        }),
      },
      now: '2026-07-24T00:00:00.000Z',
    }),
    /blocked unsafe network target/i,
  );
});

test('adequate static content does not invoke browser', async () => {
  let rendered = false;
  const result = await fetchWithBrowserFallback('https://example.cn/page', {
    staticFetch: async () => ({ title: '标题', content: '这是足够长的正文。'.repeat(60) }),
    browser: { render: async () => { rendered = true; return { text: '不应调用' }; } },
    now: '2026-07-24T00:00:00.000Z',
  });
  assert.equal(result.pageRenderMode, 'static');
  assert.equal(rendered, false);
});

test('playwright adapters share one browser and isolate every render in its own bounded context', async () => {
  let launches = 0;
  let activeContexts = 0;
  let maxActiveContexts = 0;
  const contexts = new Set<number>();
  let nextContext = 0;
  const browser = createFakeBrowser({
    goto: async () => { await new Promise<void>((resolve) => setTimeout(resolve, 15)); },
    onContextOpen: () => {
      activeContexts += 1;
      maxActiveContexts = Math.max(maxActiveContexts, activeContexts);
      contexts.add(nextContext++);
    },
    onContextClose: () => { activeContexts -= 1; },
  });
  const launch = async () => { launches += 1; return browser; };
  const first = createPlaywrightBrowserAdapter({ launch, networkLookup: publicLookup, maxConcurrentContexts: 2, maxQueuedContexts: 8 });
  const second = createPlaywrightBrowserAdapter({ launch, networkLookup: publicLookup, maxConcurrentContexts: 2, maxQueuedContexts: 8 });

  try {
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      (index % 2 === 0 ? first : second).render(`https://example.cn/${index}`, { timeoutMs: 1_000, maxChars: 1_000 })));
    assert.equal(results.length, 8);
    assert.equal(launches, 1);
    assert.equal(browser.contextCount, 8);
    assert.equal(contexts.size, 8);
    assert.equal(maxActiveContexts, 2);
    assert.equal(activeContexts, 0);
  } finally {
    await first.close();
  }
});

test('playwright adapter cancels a queued render before creating its context', async () => {
  let releaseFirst!: () => void;
  const firstNavigation = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const browser = createFakeBrowser({ goto: async () => { await firstNavigation; } });
  const adapter = createPlaywrightBrowserAdapter({
    launch: async () => browser,
    networkLookup: publicLookup,
    maxConcurrentContexts: 1,
    maxQueuedContexts: 1,
  });
  const controller = new AbortController();

  try {
    const active = adapter.render('https://example.cn/active', { timeoutMs: 1_000, maxChars: 1_000 });
    await waitUntil(() => browser.contextCount === 1);
    const queued = adapter.render('https://example.cn/queued', {
      timeoutMs: 1_000,
      maxChars: 1_000,
      signal: controller.signal,
    });
    controller.abort(new Error('queued browser fetch cancelled'));
    await assert.rejects(queued, /queued browser fetch cancelled/);
    assert.equal(browser.contextCount, 1);
    releaseFirst();
    await active;
    assert.equal(browser.contextCount, 1);
  } finally {
    releaseFirst();
    await adapter.close();
  }
});

test('playwright adapter closes each context after success, navigation failure, extraction failure, and active cancellation', async () => {
  const cases: Array<'success' | 'navigation' | 'failure' | 'cancel'> = ['success', 'navigation', 'failure', 'cancel'];
  for (const scenario of cases) {
    let closed = 0;
    let release!: () => void;
    const navigation = new Promise<void>((resolve) => { release = resolve; });
    const browser = createFakeBrowser({
      goto: scenario === 'cancel'
        ? async () => { await navigation; }
        : scenario === 'navigation'
          ? async () => { throw new Error('navigation failed'); }
          : undefined,
      innerText: scenario === 'failure' ? async () => { throw new Error('extract failed'); } : undefined,
      onContextClose: () => { closed += 1; release?.(); },
    });
    const adapter = createPlaywrightBrowserAdapter({ launch: async () => browser, managerKey: scenario, networkLookup: publicLookup });
    const controller = new AbortController();
    const rendered = adapter.render('https://example.cn/page', {
      timeoutMs: 1_000,
      maxChars: 1_000,
      signal: scenario === 'cancel' ? controller.signal : undefined,
    });
    if (scenario === 'cancel') {
      await waitUntil(() => browser.contextCount === 1);
      controller.abort(new Error('active browser fetch cancelled'));
    }
    if (scenario === 'success') await rendered;
    else await assert.rejects(
      rendered,
      scenario === 'failure'
        ? /extract failed/
        : scenario === 'navigation'
          ? /navigation failed/
          : /active browser fetch cancelled/,
    );
    assert.equal(closed, 1, `${scenario} context was not closed exactly once`);
    await adapter.close();
  }
});

test('playwright adapter rejects work beyond its bounded context queue', async () => {
  let release!: () => void;
  const navigation = new Promise<void>((resolve) => { release = resolve; });
  const browser = createFakeBrowser({ goto: async () => { await navigation; } });
  const adapter = createPlaywrightBrowserAdapter({
    launch: async () => browser,
    networkLookup: publicLookup,
    maxConcurrentContexts: 1,
    maxQueuedContexts: 1,
  });

  try {
    const active = adapter.render('https://example.cn/active', { timeoutMs: 1_000, maxChars: 1_000 });
    await waitUntil(() => browser.contextCount === 1);
    const queued = adapter.render('https://example.cn/queued', { timeoutMs: 1_000, maxChars: 1_000 });
    const overflow = adapter.render('https://example.cn/overflow', { timeoutMs: 1_000, maxChars: 1_000 });
    await assert.rejects(overflow, (error: unknown) =>
      (error as { code?: string }).code === 'BROWSER_CONTEXT_QUEUE_FULL');
    assert.equal(browser.contextCount, 1);
    release();
    await Promise.all([active, queued]);
  } finally {
    release();
    await adapter.close();
  }
});

test('playwright adapter close invalidates an in-flight launch without leaking the launched browser', async () => {
  let finishLaunch!: (browser: PlaywrightBrowser) => void;
  const browser = createFakeBrowser();
  const adapter = createPlaywrightBrowserAdapter({
    launch: async () => await new Promise<PlaywrightBrowser>((resolve) => { finishLaunch = resolve; }),
    managerKey: 'in-flight-close',
    networkLookup: publicLookup,
  });
  const rendered = adapter.render('https://example.cn/page', { timeoutMs: 1_000, maxChars: 1_000 });
  await waitUntil(() => Boolean(finishLaunch));
  const closing = adapter.close();
  finishLaunch(browser);

  await assert.rejects(rendered, (error: unknown) =>
    (error as { code?: string }).code === 'BROWSER_LAUNCH_INVALIDATED');
  await closing;
  assert.equal(browser.closeCalls, 1);
});

test('playwright adapter lazily relaunches once after disconnect for concurrent renders', async () => {
  const browsers = [createFakeBrowser(), createFakeBrowser()];
  let launches = 0;
  const adapter = createPlaywrightBrowserAdapter({
    launch: async () => browsers[launches++]!,
    networkLookup: publicLookup,
    maxConcurrentContexts: 2,
    maxQueuedContexts: 2,
  });

  try {
    await adapter.render('https://example.cn/initial', { timeoutMs: 1_000, maxChars: 1_000 });
    browsers[0].disconnect();
    await Promise.all([
      adapter.render('https://example.cn/after-1', { timeoutMs: 1_000, maxChars: 1_000 }),
      adapter.render('https://example.cn/after-2', { timeoutMs: 1_000, maxChars: 1_000 }),
    ]);
    assert.equal(launches, 2);
    assert.equal(browsers[1].contextCount, 2);
  } finally {
    await adapter.close();
  }
});

test('playwright adapter close closes the shared browser once and rejects queued renders', async () => {
  let release!: () => void;
  const navigation = new Promise<void>((resolve) => { release = resolve; });
  const browser = createFakeBrowser({ goto: async () => { await navigation; } });
  const adapter = createPlaywrightBrowserAdapter({
    launch: async () => browser,
    networkLookup: publicLookup,
    maxConcurrentContexts: 1,
    maxQueuedContexts: 1,
  });
  const active = adapter.render('https://example.cn/active', { timeoutMs: 1_000, maxChars: 1_000 });
  await waitUntil(() => browser.contextCount === 1);
  const queued = adapter.render('https://example.cn/queued', { timeoutMs: 1_000, maxChars: 1_000 });
  const closing = adapter.close();
  release();

  await assert.rejects(queued, (error: unknown) =>
    (error as { code?: string }).code === 'BROWSER_CONTEXT_POOL_CLOSED');
  await Promise.allSettled([active]);
  await closing;
  await adapter.close();
  assert.equal(browser.closeCalls, 1);
});
