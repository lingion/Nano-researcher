import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSearchDiscovery } from '../../src/search-fusion/cloudflare-search-local.ts';

test('search fusion normalizes discovery-only records', () => {
  const result = normalizeSearchDiscovery({
    query: '科技招商政策',
    results: [
      { title: '政策标题', url: 'https://example.gov.cn/policy', snippet: '正文摘要', source: 'cloudflare-search-local' },
    ],
  });

  assert.deepEqual(result, [
    {
      query: '科技招商政策',
      title: '政策标题',
      url: 'https://example.gov.cn/policy',
      snippet: '正文摘要',
      source: 'cloudflare-search-local',
    },
  ]);
});

test('cloudflare local search returns the standard four-layer aligned response while preserving aggregate search metadata on results', async () => {
  const original = (globalThis as { WebSearch?: unknown }).WebSearch;

  (globalThis as {
    WebSearch?: (input: { query: string; auto_mode?: string; engines?: string[] }) => Promise<Array<{
      title?: string;
      url?: string;
      snippet?: string;
      source?: string;
    }>>;
  }).WebSearch = async () => [
    {
      title: '阿里云百炼开发者预览内测资格申请入口 Beta',
      url: 'https://bailian.aliyun.com/preview/access',
      snippet: '中国大陆官方开发者预览和内测资格申请入口',
      source: 'search_auto',
    },
    {
      title: '无效结果',
      url: '',
      snippet: '应该被过滤',
      source: 'search_auto',
    },
  ];

  try {
    const { searchWithCloudflareLocal } = await import('../../src/search-fusion/cloudflare-search-local.ts');
    const response = await searchWithCloudflareLocal('latest AI developer preview access', {
      providerSearches: [
        async (query) => [
          {
            query,
            title: '阿里云百炼开发者预览内测资格申请入口 Beta',
            url: 'https://bailian.aliyun.com/preview/access',
            snippet: '中国大陆官方开发者预览和内测资格申请入口',
            source: 'aliyun-official',
          },
        ],
      ],
      webSearchArgs: {
        auto_mode: 'full',
        engines: ['baidu', 'sogou', 'bing'],
      },
    });

    assert.equal(response.task_context.target_query, 'latest AI developer preview access');
    assert.equal(response.task_context.current_attempt_round, 1);
    assert.equal(response.task_context.category_bundle_routed, 'general');
    assert.deepEqual(response.task_context.targeted_official_domains, []);
    assert.equal(response.metrics.total_raw_found, 2);
    assert.equal(response.metrics.fallback_used, false);
    assert.equal(response.metrics.merged_count, 2);
    assert.equal(response.metrics.deduped_count, 1);
    assert.equal(response.metrics.filtered_count, 1);
    assert.equal(response.quality_state.status, 'green');
    assert.equal(response.results.length, 1);
    assert.equal(response.results[0]?.fallback_used, false);
    assert.equal(response.results[0]?.merged_count, 2);
    assert.equal(response.results[0]?.deduped_count, 1);
    assert.equal(response.results[0]?.filtered_count, 1);
    assert.equal(response.results[0]?.access_source_grade, 'official_access');
    assert.equal(response.results[0]?.kerry_quality_status, 'usable_results');
    assert.equal(response.results[0]?.kerry_quality_reason, 'Search result quality verified.');
  } finally {
    if (original === undefined) {
      delete (globalThis as { WebSearch?: unknown }).WebSearch;
    } else {
      (globalThis as { WebSearch?: unknown }).WebSearch = original;
    }
  }
});




test('cloudflare local search retries a transient provider failure with a bounded delay', async () => {
  const original = (globalThis as { WebSearch?: unknown }).WebSearch;
  delete (globalThis as { WebSearch?: unknown }).WebSearch;
  let attempts = 0;

  try {
    const { searchWithCloudflareLocal } = await import('../../src/search-fusion/cloudflare-search-local.ts');
    const result = await searchWithCloudflareLocal('政策', {
      providerRetryAttempts: 2,
      providerRetryDelayMs: 1,
      providerSearches: [async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('network timeout');
        return [{
          title: '官方政策正文',
          url: 'https://www.example.gov.cn/policy',
          snippet: '政策摘要',
          source: 'provider',
        }];
      }],
    });

    assert.equal(attempts, 2);
    assert.equal(result.results[0]?.url, 'https://www.example.gov.cn/policy');
  } finally {
    if (original !== undefined) {
      (globalThis as { WebSearch?: unknown }).WebSearch = original;
    }
  }
});

test('cloudflare local search does not retry a non-retryable provider failure', async () => {
  const original = (globalThis as { WebSearch?: unknown }).WebSearch;
  delete (globalThis as { WebSearch?: unknown }).WebSearch;
  let attempts = 0;

  try {
    const { searchWithCloudflareLocal } = await import('../../src/search-fusion/cloudflare-search-local.ts');
    const result = await searchWithCloudflareLocal('政策', {
      providerRetryAttempts: 3,
      providerRetryDelayMs: 1,
      providerSearches: [async () => {
        attempts += 1;
        throw new Error('invalid response');
      }],
    });

    assert.equal(attempts, 1);
    assert.deepEqual(result.results, []);
  } finally {
    if (original !== undefined) (globalThis as { WebSearch?: unknown }).WebSearch = original;
  }
});


test('cloudflare local search continues to later providers when an earlier provider fails', async () => {
  const original = (globalThis as { WebSearch?: unknown }).WebSearch;
  delete (globalThis as { WebSearch?: unknown }).WebSearch;
  const calls: string[] = [];

  try {
    const { searchWithCloudflareLocal } = await import('../../src/search-fusion/cloudflare-search-local.ts');
    const result = await searchWithCloudflareLocal('政策', {
      providerSearches: [
        async () => {
          calls.push('failed');
          throw new Error('provider unavailable');
        },
        async () => {
          calls.push('successful');
          return [{
            title: '官方政策正文',
            url: 'https://www.example.gov.cn/policy',
            snippet: '政策摘要',
            source: 'second-provider',
          }];
        },
      ],
    });

    assert.deepEqual(calls, ['failed', 'successful']);
    assert.equal(result.results[0]?.url, 'https://www.example.gov.cn/policy');
  } finally {
    if (original !== undefined) {
      (globalThis as { WebSearch?: unknown }).WebSearch = original;
    }
  }
});

test('cloudflare local search continues after retry exhaustion', async () => {
  const original = (globalThis as { WebSearch?: unknown }).WebSearch;
  delete (globalThis as { WebSearch?: unknown }).WebSearch;
  let failedAttempts = 0;

  try {
    const { searchWithCloudflareLocal } = await import('../../src/search-fusion/cloudflare-search-local.ts');
    const result = await searchWithCloudflareLocal('政策', {
      providerRetryAttempts: 2,
      providerRetryDelayMs: 1,
      providerSearches: [
        async () => {
          failedAttempts += 1;
          throw new Error('network timeout');
        },
        async () => [{
          title: '后续 provider 政策正文',
          url: 'https://www.example.gov.cn/second-provider-policy',
          snippet: '政策摘要',
          source: 'second-provider',
        }],
      ],
    });

    assert.equal(failedAttempts, 2);
    assert.equal(result.results[0]?.url, 'https://www.example.gov.cn/second-provider-policy');
  } finally {
    if (original !== undefined) {
      (globalThis as { WebSearch?: unknown }).WebSearch = original;
    }
  }
});

test('cloudflare local search aborts during retry backoff', async () => {
  const original = (globalThis as { WebSearch?: unknown }).WebSearch;
  delete (globalThis as { WebSearch?: unknown }).WebSearch;
  const controller = new AbortController();
  let attempts = 0;

  try {
    const { searchWithCloudflareLocal } = await import('../../src/search-fusion/cloudflare-search-local.ts');
    const pending = searchWithCloudflareLocal('政策', {
      providerRetryAttempts: 3,
      providerRetryDelayMs: 1000,
      signal: controller.signal,
      providerSearches: [async () => {
        attempts += 1;
        throw new Error('network timeout');
      }],
    });

    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('search aborted during retry'));
    await assert.rejects(pending, /search aborted during retry/);
    assert.equal(attempts, 1);
  } finally {
    if (original !== undefined) {
      (globalThis as { WebSearch?: unknown }).WebSearch = original;
    }
  }
});

test('cloudflare local search propagates abort to providers and does not continue to HTML fallback', async () => {
  const controller = new AbortController();
  let fallbackCalls = 0;
  const { searchWithCloudflareLocal } = await import('../../src/search-fusion/cloudflare-search-local.ts');
  const pending = searchWithCloudflareLocal('政策', {
    signal: controller.signal,
    providerSearches: [async (_query, signal) => {
      assert.equal(signal, controller.signal);
      return await new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }],
    fetchImpl: async () => {
      fallbackCalls += 1;
      return { text: async () => '' };
    },
  });

  controller.abort(new Error('search aborted'));
  await assert.rejects(pending, /search aborted/);
  assert.equal(fallbackCalls, 0);
});
test('cloudflare local search falls back to a second HTML engine when the first one times out', async () => {
  const original = (globalThis as { WebSearch?: unknown }).WebSearch;
  delete (globalThis as { WebSearch?: unknown }).WebSearch;
  const calls: string[] = [];

  try {
    const { searchWithCloudflareLocal } = await import('../../src/search-fusion/cloudflare-search-local.ts');
    const result = await searchWithCloudflareLocal('绥化市科技招商政策', {
      fetchImpl: async (url) => {
        calls.push(url);
        if (calls.length === 1) throw new Error('connect timeout');
        return { text: async () => '<a class="result__a" href="https://www.example.gov.cn/zwgk/policy/123.html">市政府政策正文</a><a class="result__snippet">官方摘要</a>' };
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(result.results[0]?.url, 'https://www.example.gov.cn/zwgk/policy/123.html');
    assert.equal(result.metrics.fallback_used, true);
  } finally {
    if (original !== undefined) (globalThis as { WebSearch?: unknown }).WebSearch = original;
  }
});

test('cloudflare local search parses baidu-style result blocks for Chinese government queries', async () => {
  const original = (globalThis as { WebSearch?: unknown }).WebSearch;
  delete (globalThis as { WebSearch?: unknown }).WebSearch;

  try {
    const { searchWithCloudflareLocal } = await import('../../src/search-fusion/cloudflare-search-local.ts');
    const result = await searchWithCloudflareLocal('绥化市科技招商政策', {
      fetchImpl: async () => ({
        text: async () => `
          <html>
            <body>
              <div class="result c-container">
                <h3><a href="https://www.example.gov.cn/zcwj/456.html">绥化市人民政府关于科技招商的通知</a></h3>
                <div class="c-abstract">官方政策摘要</div>
              </div>
            </body>
          </html>
        `,
      }),
    });

    assert.equal(result.results[0]?.title, '绥化市人民政府关于科技招商的通知');
    assert.equal(result.results[0]?.url, 'https://www.example.gov.cn/zcwj/456.html');
    assert.equal(result.results[0]?.snippet, '官方政策摘要');
  } finally {
    if (original !== undefined) {
      (globalThis as { WebSearch?: unknown }).WebSearch = original;
    }
  }
});

test('cloudflare local search merges near-duplicate policy results from multiple engines under one canonical record', async () => {
  const original = (globalThis as { WebSearch?: unknown }).WebSearch;

  (globalThis as { WebSearch?: (input: { query: string }) => Promise<Array<{ title: string; url: string; snippet: string; source: string }>> }).WebSearch = async () => [
    {
      title: '绥化市人民政府关于科技招商的通知',
      url: 'https://www.example.gov.cn/zcwj/456.html?from=websearch',
      snippet: '官方政策摘要A',
      source: 'websearch',
    },
  ];

  try {
    const { searchWithCloudflareLocal } = await import('../../src/search-fusion/cloudflare-search-local.ts');
    const result = await searchWithCloudflareLocal('绥化市科技招商政策', {
      fetchImpl: async () => ({
        text: async () => `
          <html>
            <body>
              <div class="result c-container">
                <h3><a href="https://www.example.gov.cn/zcwj/456.html">绥化市人民政府关于科技招商的通知</a></h3>
                <div class="c-abstract">官方政策摘要B</div>
              </div>
            </body>
          </html>
        `,
      }),
    });

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.url, 'https://www.example.gov.cn/zcwj/456.html');
    assert.match(result.results[0]?.snippet ?? '', /官方政策摘要/);
  } finally {
    if (original === undefined) {
      delete (globalThis as { WebSearch?: unknown }).WebSearch;
    } else {
      (globalThis as { WebSearch?: unknown }).WebSearch = original;
    }
  }
});



test('cloudflare local search preserves an empty quality state when all three layers return nothing', async (t) => {
  const original = (globalThis as { WebSearch?: unknown }).WebSearch;
  delete (globalThis as { WebSearch?: unknown }).WebSearch;
  const originalDebug = process.env.LIVE_AUDIT_DEBUG;
  process.env.LIVE_AUDIT_DEBUG = '1';
  const logs: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });

  try {
    const { searchWithCloudflareLocal } = await import('../../src/search-fusion/cloudflare-search-local.ts');

    const result = await searchWithCloudflareLocal('2026年黑龙江省高新技术企业租金减免及研发投入补贴政策最新规定', {
      providerSearches: [
        async () => [],
        async () => [],
        async () => [],
      ],
      fetchImpl: async () => ({
        text: async () => '<html><body><div>blocked</div></body></html>',
      }),
    });
    assert.deepEqual(result.results, []);
    assert.equal(result.quality_state.status, 'empty');
  } finally {
    if (original === undefined) {
      delete (globalThis as { WebSearch?: unknown }).WebSearch;
    } else {
      (globalThis as { WebSearch?: unknown }).WebSearch = original;
    }
    if (originalDebug === undefined) delete process.env.LIVE_AUDIT_DEBUG;
    else process.env.LIVE_AUDIT_DEBUG = originalDebug;
  }

  const diagnosticsLine = logs.find((line) => line.includes('[SEARCH_LAYERED_DIAGNOSTICS]'));
  assert.ok(diagnosticsLine);
  const diagnostics = JSON.parse(diagnosticsLine.slice(diagnosticsLine.indexOf('{')));
  assert.deepEqual(diagnostics, {
    providerResultCount: 0,
    globalSearchStatus: 'SKIPPED_OR_UNDEFINED',
    fallbackResultCount: 0,
    fallbackEmpty: true,
  });
});

