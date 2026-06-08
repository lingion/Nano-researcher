import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildPolicyPrompt } from '../../src/policy-task/prompt-builder.ts';
import { runPolicyTask } from '../../src/app/run-policy-task.ts';
import { searchWithCloudflareLocal } from '../../src/search-fusion/cloudflare-search-local.ts';
import { createNdrcPolicySearchProvider, createMiitPolicySearchProvider, createGovCnPolicyLibraryProvider } from '../../src/search-fusion/official-policy-entrances.ts';
import type { SearchTool, FetchTool } from '../../src/runtime/tool-registry.ts';

test('thin host runtime files exist', () => {
  const files = [
    'src/runtime/session-db.ts',
    'src/runtime/session-manager.ts',
    'src/runtime/delivery.ts',
    'src/runtime/log.ts',
  ];

  for (const file of files) {
    assert.equal(fs.existsSync(new URL(`../../${file}`, import.meta.url)), true, `${file} should exist`);
  }
});

test('policy prompt forbids code-side business judgment', () => {
  const prompt = buildPolicyPrompt();
  assert.match(prompt, /All business judgment must come from you/i);
  assert.match(prompt, /The runtime only executes, records, persists, deduplicates, and renders artifacts/i);
  assert.match(prompt, /Search discovers candidate URLs only/i);
  assert.match(prompt, /Fetch extracts page evidence only/i);
});

test('runPolicyTask feeds official nationwide providers into the default auto search layer for policy discovery', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-official-default-'));
  const original = (globalThis as { WebSearch?: unknown }).WebSearch;
  const calls: Array<{ query: string; auto_mode?: string; engines?: string[] }> = [];

  (globalThis as {
    WebSearch?: (input: { query: string; auto_mode?: string; engines?: string[] }) => Promise<Array<{
      title: string;
      url: string;
      snippet: string;
      source: string;
    }>>;
  }).WebSearch = async (input) => {
    calls.push(input);
    return [
      {
        title: '一般搜索结果',
        url: 'https://example.gov.cn/policy',
        snippet: '政策摘要',
        source: 'search_auto',
      },
    ];
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);

    if (url.includes('fwfx.ndrc.gov.cn/api/query')) {
      return new Response(JSON.stringify({
        ok: true,
        data: {
          resultList: [
            {
              title: '国家发展改革委招商政策解读',
              url: 'https://www.ndrc.gov.cn/xxgk/jd/jd/202601/t20260112_1403201.html',
              summary: '招商政策线索',
              docDate: '2026-01-12',
            },
          ],
        },
      }));
    }

    if (url.includes('www.miit.gov.cn/search-front-server/api/search/info')) {
      return new Response(JSON.stringify({
        success: true,
        data: {
          searchResult: {
            dataResults: [
              {
                groupData: [
                  {
                    data: {
                      title_text: '工业和信息化部高新区政策发布会',
                      url: '/xwfb/xwfbh/bxwfbh/art/2026/art_1645f32c491a452489025bdb9430f490.html',
                      content: '高新区和科技创新政策内容',
                      deploytime: '2026-05-29 09:00:00',
                    },
                  },
                ],
              },
            ],
          },
        },
      }));
    }

    if (url.includes('sousuoht.www.gov.cn/athena/forward/2B22E8E39E850E17F95A016A74FCB6B673336FA8B6FEC0E2955907EF9AEE06BE')) {
      return new Response(JSON.stringify({
        resultCode: { code: 200 },
        result: {
          data: {
            middle: {
              list: [
                {
                  title: '国务院关于上海市城市总体规划的批复',
                  title_no_tag: '国务院关于上海市城市总体规划的批复',
                  url: 'http://www.gov.cn/zhengce/content/2017-12/25/content_5250134.htm',
                  summary: '国务院原则同意《上海市城市总体规划（2017—2035年）》。',
                  pubcode: '国函〔2017〕147号',
                  time: '2017-12-25 16:53:00',
                },
              ],
            },
          },
        },
      }));
    }

    return new Response('<html><body></body></html>');
  };

  try {
    const cloudflareSearchTool: SearchTool = {
      search: async (query) => {
        const fetchImpl = async (url: string) => {
          const response = await globalThis.fetch(url);
          return { text: async () => response.text() };
        };
        const result = await searchWithCloudflareLocal(query, {
          webSearchArgs: { auto_mode: 'full', engines: ['baidu', 'sogou', 'bing', 'bing_news', 'sina_news', '163_news'] },
          providerSearches: [
            createNdrcPolicySearchProvider({ fetchImpl }),
            createMiitPolicySearchProvider({ fetchImpl }),
            createGovCnPolicyLibraryProvider({ fetchImpl }),
          ],
        });
        return result.results;
      },
    };
    const localFetchTool: FetchTool = {
      fetch: async (url) => ({
        requestedUrl: url,
        finalUrl: url,
        title: url,
        content: '',
        backend: 'mock-fetch',
      }),
    };
    const result = await runPolicyTask(
      { topic: '科技招商政策' },
      {
        outputDir,
        searchTool: cloudflareSearchTool,
        fetchTool: localFetchTool,
        callModel: async () => JSON.stringify({
          decision: 'continue_search',
          reasoning: 'Need official candidate URLs first.',
          searchActions: [{ query: '科技招商政策 site:gov.cn', why: 'find official policy pages' }],
          fetchActions: [],
          discardedLeads: [],
          uncertainties: ['No fetched evidence yet'],
        }),
      },
    );

    const audit = JSON.parse(await readFile(result.resultAuditPath, 'utf8')) as {
      candidates?: Array<{ source?: string }>;
    };

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      query: '科技招商政策 site:gov.cn',
      auto_mode: 'full',
      engines: ['baidu', 'sogou', 'bing', 'bing_news', 'sina_news', '163_news'],
    });
    assert.equal(audit.candidates?.some((item) => item.source === 'ndrc-policy-search'), true);
    assert.equal(audit.candidates?.some((item) => item.source === 'miit-policy-search'), true);
    assert.equal(audit.candidates?.some((item) => item.source === 'gov-cn-policy-library-search'), true);
    assert.equal(audit.candidates?.some((item) => item.source === 'search_auto'), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (original === undefined) {
      delete (globalThis as { WebSearch?: unknown }).WebSearch;
    } else {
      (globalThis as { WebSearch?: unknown }).WebSearch = original;
    }
  }
});

test('runPolicyTask default search path rewrites junk query candidates to the mapped Kerry status without drift', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-default-status-lock-'));
  const original = (globalThis as { WebSearch?: unknown }).WebSearch;

  (globalThis as {
    WebSearch?: (input: { query: string; auto_mode?: string; engines?: string[] }) => Promise<Array<{
      title: string;
      url: string;
      snippet: string;
      source: string;
    }>>;
  }).WebSearch = async () => [
    {
      title: '招聘租房广告大合集',
      url: 'https://example.com/jobs',
      snippet: '招聘 租房 广告',
      source: 'search_auto',
    },
    {
      title: '酒店机票特惠',
      url: 'https://example.com/travel',
      snippet: '酒店 机票 优惠',
      source: 'search_auto',
    },
  ];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { resultList: [] }, success: true, result: { data: { middle: { list: [] } } } }));

  try {
    const cloudflareSearchTool: SearchTool = {
      search: async (query) => {
        const result = await searchWithCloudflareLocal(query, {});
        return result.results;
      },
    };
    const localFetchTool: FetchTool = {
      fetch: async (url) => ({
        requestedUrl: url,
        finalUrl: url,
        title: url,
        content: '',
        backend: 'mock-fetch',
      }),
    };
    const result = await runPolicyTask(
      { topic: '招聘租房广告' },
      {
        outputDir,
        searchTool: cloudflareSearchTool,
        fetchTool: localFetchTool,
        callModel: async () => JSON.stringify({
          decision: 'continue_search',
          reasoning: 'Need candidate URLs first.',
          searchActions: [{ query: '招聘租房广告', why: 'trigger default search path' }],
          fetchActions: [],
          discardedLeads: [],
          uncertainties: ['No fetched evidence yet'],
        }),
      },
    );

    const audit = JSON.parse(await readFile(result.resultAuditPath, 'utf8')) as {
      candidates?: Array<{ source?: string; kerry_quality_status?: string; kerry_quality_reason?: string }>;
    };

    const autoCandidates = audit.candidates?.filter((item) => item.source === 'search_auto') ?? [];
    assert.equal(autoCandidates.length, 2);
    assert.deepEqual(
      autoCandidates.map((item) => item.kerry_quality_status),
      ['junk_heavy', 'junk_heavy'],
    );
    assert.equal(autoCandidates.every((item) => /commercial noise|intent mismatch/i.test(item.kerry_quality_reason ?? '')), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (original === undefined) {
      delete (globalThis as { WebSearch?: unknown }).WebSearch;
    } else {
      (globalThis as { WebSearch?: unknown }).WebSearch = original;
    }
  }
});

test('runPolicyTask writes a separate debug trace artifact with prompt model tool and state events', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-debug-trace-'));

  const result = await runPolicyTask(
    { topic: '科技招商政策' },
    {
      outputDir,
      debug: true,
      callModel: async () => JSON.stringify({
        decision: 'continue_search',
        reasoning: 'Need official candidate URLs first.',
        searchActions: [{ query: '科技招商政策 site:gov.cn', why: 'find official policy pages' }],
        fetchActions: [],
        discardedLeads: [],
        uncertainties: ['No fetched evidence yet'],
      }),
      searchTool: {
        search: async (query: string) => [
          {
            query,
            title: '官方政策页面',
            url: 'https://example.gov.cn/policy',
            snippet: '政策摘要',
            source: 'search-backend',
          },
        ],
      },
      fetchTool: {
        fetch: async (url: string) => ({
          requestedUrl: url,
          finalUrl: url,
          title: '政策全文',
          content: '正文内容',
          backend: 'fetch-backend',
        }),
      },
    },
  );

  assert.equal(typeof (result as { debugTracePath?: string }).debugTracePath, 'string');

  const debugTrace = JSON.parse(
    await readFile((result as { debugTracePath: string }).debugTracePath, 'utf8'),
  ) as {
    events?: Array<{ type: string; payload: Record<string, unknown> }>;
  };

  assert.equal(debugTrace.events?.some((event) => event.type === 'model.prompt'), true);
  assert.equal(debugTrace.events?.some((event) => event.type === 'model.config'), true);
  assert.equal(debugTrace.events?.some((event) => event.type === 'tool.search.request'), true);
  assert.equal(debugTrace.events?.some((event) => event.type === 'state.updated'), true);
});

test('runPolicyTask records model failure details in the separate debug trace artifact', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-debug-failure-'));

  await assert.rejects(
    () => runPolicyTask(
      { topic: '科技招商政策' },
      {
        outputDir,
        debug: true,
        callModel: async () => {
          throw new Error('upstream model exploded');
        },
      },
    ),
    /upstream model exploded/,
  );

  const debugTrace = JSON.parse(
    await readFile(path.join(outputDir, 'debug-trace.json'), 'utf8'),
  ) as {
    events?: Array<{ type: string; payload: Record<string, unknown> }>;
  };

  assert.equal(debugTrace.events?.some((event) => event.type === 'model.prompt'), true);
  assert.equal(debugTrace.events?.some((event) => event.type === 'model.failure'), true);
  assert.equal(debugTrace.events?.some((event) => event.type === 'run.failure'), true);
});
