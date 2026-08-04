import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';

import {
  createHtmlExtractionPool,
  normalizeFetchedPage,
  type HtmlExtractionWorker,
} from '../../src/fetch-fusion/local-fetch-primary.ts';

class ControlledExtractionWorker extends EventEmitter implements HtmlExtractionWorker {
  readonly posted: Array<{ id: number; html: string; url: string }> = [];
  terminateCalls = 0;
  referenced = false;

  postMessage(message: { id: number; html: string; url: string }): void {
    this.posted.push(message);
  }

  ref(): void {
    this.referenced = true;
  }

  unref(): void {
    this.referenced = false;
  }

  async terminate(): Promise<number> {
    this.terminateCalls += 1;
    this.emit('exit', 1);
    return 1;
  }

  succeed(index = 0): void {
    const job = this.posted[index];
    assert.ok(job);
    this.emit('message', {
      id: job.id,
      result: { title: job.html, content: `content:${job.html}`, officialUrls: [] },
    });
  }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('fetch fusion normalizes page evidence records', () => {
  const page = normalizeFetchedPage({
    requestedUrl: 'https://example.gov.cn/policy',
    finalUrl: 'https://example.gov.cn/policy?id=1',
    title: '政策全文',
    content: '正文内容',
    backend: 'local-fetch-primary',
  });

  assert.deepEqual(page, {
    requestedUrl: 'https://example.gov.cn/policy',
    finalUrl: 'https://example.gov.cn/policy?id=1',
    title: '政策全文',
    content: '正文内容',
    backend: 'local-fetch-primary',
    evidence_clues: {
      is_suspected_reprint: false,
      extracted_doc_no: null,
      potential_official_urls: [],
    },
  });
});

test('fetch fusion preserves optional provenance and validation fields during normalization', () => {
  const page = normalizeFetchedPage({
    requestedUrl: 'https://example.gov.cn/policy',
    finalUrl: 'https://example.gov.cn/policy?view=full',
    title: '政策全文',
    content: '正文内容',
    backend: 'browser-fallback',
    publishedAt: '2026-07-20',
    updatedAt: '2026-07-21',
    lastVerifiedAt: '2026-07-22T10:00:00.000Z',
    pageRenderMode: 'playwright',
    accessSignals: ['developer_preview'],
    freshnessStatus: 'in_window',
    dateEvidence: ['发布日期：2026年7月20日'],
    extractionWarnings: ['partial-content'],
    qualityCategory: 'GOLD_STANDARD',
    validationReason: 'official source with explicit access signal',
  });

  assert.deepEqual(page, {
    requestedUrl: 'https://example.gov.cn/policy',
    finalUrl: 'https://example.gov.cn/policy?view=full',
    title: '政策全文',
    content: '正文内容',
    backend: 'browser-fallback',
    publishedAt: '2026-07-20',
    updatedAt: '2026-07-21',
    lastVerifiedAt: '2026-07-22T10:00:00.000Z',
    pageRenderMode: 'playwright',
    accessSignals: ['developer_preview'],
    freshnessStatus: 'in_window',
    dateEvidence: ['发布日期：2026年7月20日'],
    extractionWarnings: ['partial-content'],
    qualityCategory: 'GOLD_STANDARD',
    validationReason: 'official source with explicit access signal',
    evidence_clues: {
      is_suspected_reprint: false,
      extracted_doc_no: null,
      potential_official_urls: [],
    },
  });
});

test('local fetch primary rejects loopback targets before invoking network clients', async () => {
  const original = (globalThis as { WebFetch?: unknown }).WebFetch;
  let webFetchCalls = 0;
  (globalThis as { WebFetch?: unknown }).WebFetch = async () => {
    webFetchCalls += 1;
    return { content: 'must not fetch' };
  };
  try {
    const { fetchWithLocalPrimary } = await import('../../src/fetch-fusion/local-fetch-primary.ts');
    await assert.rejects(
      fetchWithLocalPrimary('http://127.0.0.1:8080/health'),
      /blocked unsafe network target/i,
    );
    assert.equal(webFetchCalls, 0);
  } finally {
    if (original === undefined) delete (globalThis as { WebFetch?: unknown }).WebFetch;
    else (globalThis as { WebFetch?: unknown }).WebFetch = original;
  }
});

test('local fetch primary rejects private IPv4 targets before fallback fetch', async () => {
  const original = (globalThis as { WebFetch?: unknown }).WebFetch;
  delete (globalThis as { WebFetch?: unknown }).WebFetch;
  let fetchCalls = 0;
  try {
    const { fetchWithLocalPrimary } = await import('../../src/fetch-fusion/local-fetch-primary.ts');
    await assert.rejects(
      fetchWithLocalPrimary('http://169.254.169.254/latest/meta-data', 20000, {
        fetchImpl: async () => {
          fetchCalls += 1;
          return { text: async () => '' };
        },
      }),
      /blocked unsafe network target/i,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    if (original !== undefined) (globalThis as { WebFetch?: unknown }).WebFetch = original;
  }
});

test('local fetch primary rejects non-http protocols', async () => {
  await assert.rejects(
    import('../../src/fetch-fusion/local-fetch-primary.ts').then(({ fetchWithLocalPrimary }) =>
      fetchWithLocalPrimary('file:///etc/passwd')),
    /blocked unsafe network target/i,
  );
});

test('local fetch primary wrapper uses global WebFetch when available', async () => {
  const original = (globalThis as { WebFetch?: unknown }).WebFetch;
  const calls: Array<{ url: string; prompt: string }> = [];

  (globalThis as { WebFetch?: (input: { url: string; prompt: string }) => Promise<{ content: string; finalUrl?: string; title?: string }> }).WebFetch = async ({ url, prompt }) => {
    calls.push({ url, prompt });
    return {
      content: '正文内容',
      finalUrl: `${url}?final=1`,
      title: '政策全文',
    };
  };

  try {
    const { fetchWithLocalPrimary } = await import('../../src/fetch-fusion/local-fetch-primary.ts');
    const result = await fetchWithLocalPrimary('https://example.gov.cn/policy');

    assert.equal(calls[0]?.url, 'https://example.gov.cn/policy');
    assert.match(calls[0]?.prompt ?? '', /main policy text|正文/);
    assert.equal(result.finalUrl, 'https://example.gov.cn/policy?final=1');
    assert.equal(result.content, '正文内容');
  } finally {
    if (original === undefined) {
      delete (globalThis as { WebFetch?: unknown }).WebFetch;
    } else {
      (globalThis as { WebFetch?: unknown }).WebFetch = original;
    }
  }
});



test('local fetch primary wrapper falls back from WebFetch to raw fetch with browser-like headers when WebFetch fails', async () => {
  const original = (globalThis as { WebFetch?: unknown }).WebFetch;
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];

  (globalThis as { WebFetch?: (input: { url: string; prompt: string }) => Promise<unknown> }).WebFetch = async () => {
    throw new Error('blocked by anti bot');
  };

  try {
    const { fetchWithLocalPrimary } = await import('../../src/fetch-fusion/local-fetch-primary.ts');
    const result = await fetchWithLocalPrimary('https://example.gov.cn/policy', 20000, {
      fetchImpl: async (url, init) => {
        calls.push({
          url,
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return {
          text: async () => '首页导航\n政策正文第一段\n政策正文第二段\n上一篇 下一篇',
          url: `${url}?raw=1`,
        };
      },
    });

    assert.equal(calls[0]?.url, 'https://example.gov.cn/policy');
    assert.match(calls[0]?.headers['user-agent'] ?? '', /Mozilla/i);
    assert.equal(result.finalUrl, 'https://example.gov.cn/policy?raw=1');
    assert.equal(result.content, '政策正文第一段\n政策正文第二段');
  } finally {
    if (original === undefined) {
      delete (globalThis as { WebFetch?: unknown }).WebFetch;
    } else {
      (globalThis as { WebFetch?: unknown }).WebFetch = original;
    }
  }
});

test('local fetch primary propagates abort signal to raw fetch fallback', async () => {
  const original = (globalThis as { WebFetch?: unknown }).WebFetch;
  delete (globalThis as { WebFetch?: unknown }).WebFetch;
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;

  try {
    const { fetchWithLocalPrimary } = await import('../../src/fetch-fusion/local-fetch-primary.ts');
    const pending = fetchWithLocalPrimary('https://example.gov.cn/policy', 20000, {
      signal: controller.signal,
      fetchImpl: async (_url, init) => {
        observedSignal = init?.signal;
        return await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      },
    });
    controller.abort(new Error('fetch aborted'));
    await assert.rejects(pending, /fetch aborted/);
    assert.equal(observedSignal, controller.signal);
  } finally {
    if (original !== undefined) (globalThis as { WebFetch?: unknown }).WebFetch = original;
  }
});
test('local fetch primary wrapper extracts main article body from noisy government html fallback', async () => {
  const original = (globalThis as { WebFetch?: unknown }).WebFetch;
  delete (globalThis as { WebFetch?: unknown }).WebFetch;

  try {
    const { fetchWithLocalPrimary } = await import('../../src/fetch-fusion/local-fetch-primary.ts');
    const result = await fetchWithLocalPrimary('https://example.gov.cn/policy', 20000, {
      fetchImpl: async () => ({
        url: 'https://example.gov.cn/policy?view=full',
        text: async () => `
          <html>
            <head><title>绥化市人民政府关于科技招商的通知</title></head>
            <body><header>首页导航 登录</header><aside>热门解读 相关推荐</aside>
              <main><article><h1>绥化市人民政府关于科技招商的通知</h1>
                <p>为进一步促进科技招商，现提出如下措施。</p><p>第二条：支持重点项目落地。</p>
              </article></main><footer>上一篇 下一篇</footer>
            </body>
          </html>`,
      }),
    });
    assert.equal(result.title, '绥化市人民政府关于科技招商的通知');
    assert.equal(result.finalUrl, 'https://example.gov.cn/policy?view=full');
    assert.match(result.content, /为进一步促进科技招商/);
    assert.match(result.content, /支持重点项目落地/);
    assert.doesNotMatch(result.content, /热门解读|首页导航|上一篇/);
  } finally {
    if (original !== undefined) (globalThis as { WebFetch?: unknown }).WebFetch = original;
  }
});

test('local fetch primary marks short static extraction as weak evidence', async () => {
  const original = (globalThis as { WebFetch?: unknown }).WebFetch;
  delete (globalThis as { WebFetch?: unknown }).WebFetch;

  try {
    const { fetchWithLocalPrimary } = await import('../../src/fetch-fusion/local-fetch-primary.ts');
    const result = await fetchWithLocalPrimary('https://www.gov.cn/', 20000, {
      fetchImpl: async () => ({
        url: 'https://www.gov.cn/',
        text: async () => '<html><head><title>中国政府网</title></head><body><footer>版权所有 中国政府网</footer></body></html>',
      }),
    });

    assert.match(result.content, /版权所有 中国政府网/);
    assert.deepEqual(result.extractionWarnings, [
      'static_extraction_weak: extracted content is too short for reliable evidence',
    ]);
  } finally {
    if (original !== undefined) (globalThis as { WebFetch?: unknown }).WebFetch = original;
  }
});

test('local fetch primary wrapper extracts evidence clues from a suspected reprint page', async () => {
  const original = (globalThis as { WebFetch?: unknown }).WebFetch;
  delete (globalThis as { WebFetch?: unknown }).WebFetch;

  try {
    const { fetchWithLocalPrimary } = await import('../../src/fetch-fusion/local-fetch-primary.ts');
    const result = await fetchWithLocalPrimary('https://news.example.com/reprint', 20000, {
      fetchImpl: async () => ({
        url: 'https://news.example.com/reprint?id=1',
        text: async () => `
          <html>
            <head>
              <title>绥化日报转载：绥化市人民政府关于科技招商的通知</title>
            </head>
            <body>
              <article>
                <h1>绥化日报转载：绥化市人民政府关于科技招商的通知</h1>
                <p>根据《绥政发〔2026〕7号》文件要求，现转载如下。</p>
                <p><a href="https://www.suihua.gov.cn/zcwj/202601/t20260120_123456.html">点击查看原文</a></p>
              </article>
            </body>
          </html>
        `,
      }),
    });

    assert.equal(result.evidence_clues?.is_suspected_reprint, true);
    assert.equal(result.evidence_clues?.extracted_doc_no, '绥政发〔2026〕7号');
    assert.deepEqual(result.evidence_clues?.potential_official_urls, [
      'https://www.suihua.gov.cn/zcwj/202601/t20260120_123456.html',
    ]);
    assert.match(result.content, /绥政发〔2026〕7号/);
  } finally {
    if (original !== undefined) {
      (globalThis as { WebFetch?: unknown }).WebFetch = original;
    }
  }
});

test('local fetch primary wrapper falls back to the document title when Readability cannot extract an article', async () => {
  const original = (globalThis as { WebFetch?: unknown }).WebFetch;
  delete (globalThis as { WebFetch?: unknown }).WebFetch;

  try {
    const { fetchWithLocalPrimary } = await import('../../src/fetch-fusion/local-fetch-primary.ts');
    const result = await fetchWithLocalPrimary('https://example.gov.cn/policy', 20000, {
      fetchImpl: async () => ({
        url: 'https://example.gov.cn/policy?plain=1',
        text: async () => `
          <html>
            <head>
              <title>绥化市人民政府科技招商政策</title>
            </head>
            <body>
              <div>绥化市人民政府科技招商政策</div>
              <div>第一条：支持科技企业发展。</div>
              <div>第二条：支持招商项目落地。</div>
            </body>
          </html>
        `,
      }),
    });

    assert.equal(result.title, '绥化市人民政府科技招商政策');
    assert.match(result.content, /支持科技企业发展/);
    assert.match(result.content, /支持招商项目落地/);
    assert.equal(result.evidence_clues?.is_suspected_reprint, false);
    assert.equal(result.evidence_clues?.extracted_doc_no, null);
    assert.deepEqual(result.evidence_clues?.potential_official_urls, []);
  } finally {
    if (original !== undefined) {
      (globalThis as { WebFetch?: unknown }).WebFetch = original;
    }
  }
});

test('html extraction pool bounds workers and queue while preserving result association across out-of-order completion', async () => {
  const workers: ControlledExtractionWorker[] = [];
  const pool = createHtmlExtractionPool({
    size: 2,
    maxQueue: 2,
    timeoutMs: 5_000,
    workerFactory: () => {
      const worker = new ControlledExtractionWorker();
      workers.push(worker);
      return worker;
    },
  });

  try {
    const results = ['first', 'second', 'third', 'fourth'].map((html) =>
      pool.extract(html, `https://example.gov.cn/${html}`));
    const overflow = pool.extract('overflow', 'https://example.gov.cn/overflow');

    assert.equal(workers.length, 2);
    assert.equal(workers.flatMap((worker) => worker.posted).length, 2);
    await assert.rejects(overflow, (error: unknown) =>
      (error as { code?: string }).code === 'HTML_EXTRACTION_QUEUE_FULL');

    workers[1].succeed();
    await nextTurn();
    workers[0].succeed();
    await nextTurn();
    workers[0].succeed(1);
    workers[1].succeed(1);

    assert.deepEqual((await Promise.all(results)).map((result) => result.title), [
      'first',
      'second',
      'third',
      'fourth',
    ]);
    assert.equal(workers.length, 2);
  } finally {
    await pool.close();
  }
});

test('html extraction pool removes queued cancellation without assigning it to a worker', async () => {
  const worker = new ControlledExtractionWorker();
  const pool = createHtmlExtractionPool({ size: 1, maxQueue: 1, timeoutMs: 5_000, workerFactory: () => worker });
  const controller = new AbortController();

  try {
    const active = pool.extract('active', 'https://example.gov.cn/active');
    const queued = pool.extract('queued', 'https://example.gov.cn/queued', { signal: controller.signal });
    controller.abort(new Error('queued cancelled'));

    await assert.rejects(queued, /queued cancelled/);
    assert.equal(worker.posted.length, 1);
    worker.succeed();
    await active;
    assert.equal(worker.posted.length, 1);
  } finally {
    await pool.close();
  }
});

test('html extraction pool terminates the responsible worker when active extraction is cancelled', async () => {
  const workers: ControlledExtractionWorker[] = [];
  const pool = createHtmlExtractionPool({
    size: 1,
    maxQueue: 1,
    timeoutMs: 5_000,
    workerFactory: () => {
      const worker = new ControlledExtractionWorker();
      workers.push(worker);
      return worker;
    },
  });
  const controller = new AbortController();

  try {
    const active = pool.extract('active', 'https://example.gov.cn/active', { signal: controller.signal });
    controller.abort(new Error('active extraction cancelled'));
    await assert.rejects(active, /active extraction cancelled/);
    assert.equal(workers[0]?.terminateCalls, 1);
  } finally {
    await pool.close();
  }
});

test('html extraction pool terminates an active worker on timeout and continues queued work on a replacement', async () => {
  const workers: ControlledExtractionWorker[] = [];
  const pool = createHtmlExtractionPool({
    size: 1,
    maxQueue: 1,
    timeoutMs: 25,
    workerFactory: () => {
      const worker = new ControlledExtractionWorker();
      workers.push(worker);
      return worker;
    },
  });

  try {
    const timedOut = pool.extract('slow', 'https://example.gov.cn/slow');
    const queued = pool.extract('next', 'https://example.gov.cn/next', { timeoutMs: 1_000 });
    await assert.rejects(timedOut, (error: unknown) =>
      (error as { code?: string }).code === 'HTML_EXTRACTION_TIMEOUT');
    assert.equal(workers[0]?.terminateCalls, 1);
    await nextTurn();
    assert.equal(workers.length, 2);
    workers[1].succeed();
    assert.equal((await queued).title, 'next');
  } finally {
    await pool.close();
  }
});

test('html extraction pool replaces a worker after unexpected exit and does not run failed extraction on the main thread', async () => {
  const workers: ControlledExtractionWorker[] = [];
  const pool = createHtmlExtractionPool({
    size: 1,
    maxQueue: 1,
    timeoutMs: 5_000,
    workerFactory: () => {
      const worker = new ControlledExtractionWorker();
      workers.push(worker);
      return worker;
    },
  });

  try {
    const failed = pool.extract('<title>must not synchronously recover</title>', 'https://example.gov.cn/fail');
    const queued = pool.extract('replacement', 'https://example.gov.cn/replacement');
    workers[0].emit('exit', 9);
    await assert.rejects(failed, (error: unknown) =>
      (error as { code?: string }).code === 'HTML_EXTRACTION_WORKER_EXIT');
    await nextTurn();
    assert.equal(workers.length, 2);
    workers[1].succeed();
    assert.equal((await queued).title, 'replacement');
  } finally {
    await pool.close();
  }
});

test('html extraction pool terminates and replaces a worker after an error event', async () => {
  const workers: ControlledExtractionWorker[] = [];
  const pool = createHtmlExtractionPool({
    size: 1,
    maxQueue: 1,
    timeoutMs: 5_000,
    workerFactory: () => {
      const worker = new ControlledExtractionWorker();
      workers.push(worker);
      return worker;
    },
  });

  try {
    const failed = pool.extract('failed', 'https://example.gov.cn/failed');
    const queued = pool.extract('after-error', 'https://example.gov.cn/after-error');
    workers[0].emit('error', new Error('worker crashed'));
    await assert.rejects(failed, (error: unknown) =>
      (error as { code?: string }).code === 'HTML_EXTRACTION_WORKER_ERROR');
    assert.equal(workers[0].terminateCalls, 1);
    await nextTurn();
    assert.equal(workers.length, 2);
    workers[1].succeed();
    assert.equal((await queued).title, 'after-error');
  } finally {
    await pool.close();
  }
});

test('html extraction queue timeout expires before assignment without terminating the active worker', async () => {
  const worker = new ControlledExtractionWorker();
  const pool = createHtmlExtractionPool({ size: 1, maxQueue: 1, timeoutMs: 5_000, workerFactory: () => worker });

  try {
    const active = pool.extract('active', 'https://example.gov.cn/active');
    const queued = pool.extract('queued-timeout', 'https://example.gov.cn/queued-timeout', { timeoutMs: 25 });
    await assert.rejects(queued, (error: unknown) =>
      (error as { code?: string }).code === 'HTML_EXTRACTION_TIMEOUT');
    assert.equal(worker.terminateCalls, 0);
    assert.equal(worker.posted.length, 1);
    worker.succeed();
    await active;
  } finally {
    await pool.close();
  }
});

test('html extraction pool close rejects active and queued jobs and terminates every worker', async () => {
  const workers: ControlledExtractionWorker[] = [];
  const pool = createHtmlExtractionPool({
    size: 2,
    maxQueue: 1,
    timeoutMs: 5_000,
    workerFactory: () => {
      const worker = new ControlledExtractionWorker();
      workers.push(worker);
      return worker;
    },
  });
  const active = pool.extract('one', 'https://example.gov.cn/one');
  const activeTwo = pool.extract('two', 'https://example.gov.cn/two');
  const queued = pool.extract('three', 'https://example.gov.cn/three');

  const rejections = Promise.all([
    assert.rejects(active, (error: unknown) => (error as { code?: string }).code === 'HTML_EXTRACTION_POOL_CLOSED'),
    assert.rejects(activeTwo, (error: unknown) => (error as { code?: string }).code === 'HTML_EXTRACTION_POOL_CLOSED'),
    assert.rejects(queued, (error: unknown) => (error as { code?: string }).code === 'HTML_EXTRACTION_POOL_CLOSED'),
  ]);
  await pool.close();
  await rejections;
  assert.deepEqual(workers.map((worker) => worker.terminateCalls), [1, 1]);
});

test('real worker extraction preserves article order and keeps one-megabyte parsing off the event loop', { timeout: 15_000 }, async () => {
  const pool = createHtmlExtractionPool({ size: 1, maxQueue: 1, timeoutMs: 10_000 });
  const payload = `<html><head><title>大型政策正文</title></head><body><article><h1>大型政策正文</h1><p>第一段</p><p>${'政策内容'.repeat(135_000)}</p><p>最后一段</p><a href="https://www.gov.cn/source">原文</a></article></body></html>`;
  let maximumLagMs = 0;
  let expected = performance.now() + 10;
  const timer = setInterval(() => {
    const now = performance.now();
    maximumLagMs = Math.max(maximumLagMs, now - expected);
    expected = now + 10;
  }, 10);

  try {
    const result = await pool.extract(payload, 'https://example.gov.cn/large');
    assert.equal(result.title, '大型政策正文');
    assert.ok(result.content.indexOf('第一段') < result.content.indexOf('最后一段'));
    assert.deepEqual(result.officialUrls, ['https://www.gov.cn/source']);
    assert.ok(maximumLagMs < 150, `main-thread timer lag was ${maximumLagMs.toFixed(1)} ms`);
  } finally {
    clearInterval(timer);
    await pool.close();
  }
});
