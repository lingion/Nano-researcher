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
      title: '国家发展改革委招商政策解读',
      url: 'https://www.ndrc.gov.cn/xxgk/jd/jd/202601/t20260112_1403201.html?from=auto',
      snippet: '招商政策线索',
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
    const response = await searchWithCloudflareLocal('科技招商政策', {
      providerSearches: [
        async (query) => [
          {
            query,
            title: '国家发展改革委招商政策解读',
            url: 'https://www.ndrc.gov.cn/xxgk/jd/jd/202601/t20260112_1403201.html',
            snippet: '招商政策线索',
            source: 'ndrc-policy-search',
          },
        ],
      ],
      webSearchArgs: {
        auto_mode: 'full',
        engines: ['baidu', 'sogou', 'bing'],
      },
    });

    assert.equal(response.task_context.target_query, '科技招商政策');
    assert.equal(response.task_context.current_attempt_round, 1);
    assert.equal(response.task_context.category_bundle_routed, 'policy');
    assert.deepEqual(response.task_context.targeted_official_domains, ['gov.cn']);
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
    assert.equal(response.results[0]?.policy_grade, 'official_interpretation');
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




test('cloudflare local search falls back to a second HTML engine when the first one times out', async () => {
  const original = (globalThis as { WebSearch?: unknown }).WebSearch;
  delete (globalThis as { WebSearch?: unknown }).WebSearch;
  const calls: string[] = [];

  try {
    const { searchWithCloudflareLocal } = await import('../../src/search-fusion/cloudflare-search-local.ts');
    const result = await searchWithCloudflareLocal('绥化市科技招商政策', {
      fetchImpl: async (url) => {
        calls.push(url);
        if (calls.length === 1) {
          throw new Error('connect timeout');
        }
        return {
          text: async () => `
            <html>
              <body>
                <a class="result__a" href="https://www.example.gov.cn/zwgk/policy/123.html">市政府政策正文</a>
                <a class="result__snippet">官方摘要</a>
              </body>
            </html>
          `,
        };
      },
    });

    assert.equal(calls.length, 2);
    assert.equal(result.results[0]?.url, 'https://www.example.gov.cn/zwgk/policy/123.html');
    assert.equal(result.metrics.fallback_used, true);
  } finally {
    if (original !== undefined) {
      (globalThis as { WebSearch?: unknown }).WebSearch = original;
    }
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



test('cloudflare local search logs layered diagnostics and throws a zero-results error when all three layers return nothing', async (t) => {
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

    await assert.rejects(
      () => searchWithCloudflareLocal('2026年黑龙江省高新技术企业租金减免及研发投入补贴政策最新规定', {
        providerSearches: [
          async () => [],
          async () => [],
          async () => [],
        ],
        fetchImpl: async () => ({
          text: async () => '<html><body><div>blocked</div></body></html>',
        }),
      }),
      /\[Search Fatal\] Zero search results collected across all 3 layers/,
    );
  } finally {
    if (original === undefined) {
      delete (globalThis as { WebSearch?: unknown }).WebSearch;
    } else {
      (globalThis as { WebSearch?: unknown }).WebSearch = original;
    }
    if (originalDebug === undefined) delete process.env.LIVE_AUDIT_DEBUG;
    else process.env.LIVE_AUDIT_DEBUG = originalDebug;
  }

  assert.equal(logs.some((line) => line.includes('=== [SEARCH LAYERED DIAGNOSTICS] ===')), true);
  assert.equal(logs.some((line) => line.includes('Layer 1 - Official Providers') && line.includes('Output count = 0')), true);
  assert.equal(logs.some((line) => line.includes('Layer 2 - globalThis.WebSearch') && line.includes('SKIPPED_OR_UNDEFINED')), true);
  assert.equal(logs.some((line) => line.includes('Layer 3 - HTML Fallback') && line.includes('Extracted total = 0')), true);
});

