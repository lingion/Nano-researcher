import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFetchedPage } from '../../src/fetch-fusion/local-fetch-primary.ts';

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
            <head>
              <title>绥化市人民政府关于科技招商的通知</title>
            </head>
            <body>
              <header>首页导航 登录</header>
              <aside>热门解读 相关推荐</aside>
              <main>
                <article>
                  <h1>绥化市人民政府关于科技招商的通知</h1>
                  <p>为进一步促进科技招商，现提出如下措施。</p>
                  <p>第二条：支持重点项目落地。</p>
                </article>
              </main>
              <footer>上一篇 下一篇</footer>
            </body>
          </html>
        `,
      }),
    });

    assert.equal(result.title, '绥化市人民政府关于科技招商的通知');
    assert.equal(result.finalUrl, 'https://example.gov.cn/policy?view=full');
    assert.match(result.content, /为进一步促进科技招商/);
    assert.match(result.content, /支持重点项目落地/);
    assert.doesNotMatch(result.content, /热门解读|首页导航|上一篇/);
  } finally {
    if (original !== undefined) {
      (globalThis as { WebFetch?: unknown }).WebFetch = original;
    }
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
