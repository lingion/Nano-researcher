import test from 'node:test';
import assert from 'node:assert/strict';

import { createSearchMcpTools, resolveSearchMcpWorkerPath } from './search-mcp-tool-adapter.ts';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio';
import type { SearchDiscoveryRecord } from '../search-fusion/types.js';
import type { FetchedPageRecord } from '../fetch-fusion/types.js';
test('search MCP worker path defaults to a repository-relative vendored stdio server', () => {
  const workerPath = resolveSearchMcpWorkerPath({});

  assert.match(workerPath, /vendor\/search-mcp\/src\/stdio-server\.js$/);
  assert.doesNotMatch(workerPath, /search-mcp-worker-kerry/);
});

test('search MCP adapter forwards the exact query and annotates mapped results with it', async () => {
  const query = 'site:aliyun.com 2026 AI beta';
  const calls: unknown[] = [];
  const fakeTransport = { close: async () => {} } as unknown as StdioClientTransport;
  const fakeClient = {
    connect: async () => {},
    callTool: async (request: unknown) => {
      calls.push(request);
      return {
        structuredContent: {
          results: [{ title: 'Candidate', url: 'https://example.com/candidate' }],
        },
      };
    },
  } as unknown as import('@modelcontextprotocol/sdk/client').Client;

  const toolset = await createSearchMcpTools({
    createClient: () => fakeClient,
    createTransport: () => fakeTransport,
  });

  const [result] = await toolset.searchTool.search(query);

  assert.deepEqual(calls[0], {
    name: 'search_auto',
    arguments: {
      query,
      limit: 8,
      engines: ['bing_cn', 'baidu', '360', 'sogou', 'bing'],
    },
  });
  assert.equal(result?.query, query);
  await toolset.close();
});
test('search MCP adapter closes a timed-out connect without replacing the handshake error', async () => {
  await assert.rejects(
    () => createSearchMcpTools({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 1000)'],
      connectTimeoutMs: 10,
      closeTimeoutMs: 10,
    }),
    (error: unknown) => error instanceof Error && error.name === 'RuntimeTimeoutError' && error.message === 'mcp:connect timed out after 10ms',
  );
});

test('search MCP adapter terminates the stdio child after a timed-out connect', async () => {
  let transport: StdioClientTransport | undefined;
  let childPid: number | undefined;
  const fakeClient = {
    connect: async (candidate: StdioClientTransport) => {
      await candidate.start();
      childPid = candidate.pid;
      await new Promise<void>(() => {});
    },
  } as unknown as import('@modelcontextprotocol/sdk/client').Client;

  await assert.rejects(
    () => createSearchMcpTools({
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
      connectTimeoutMs: 50,
      closeTimeoutMs: 500,
      createClient: () => fakeClient,
      createTransport: (options) => {
        transport = new StdioClientTransport(options);
        return transport;
      },
    }),
    (error: unknown) => error instanceof Error && error.name === 'RuntimeTimeoutError',
  );

  assert.equal(typeof childPid, 'number');
  assert.equal(transport?.pid, null);
  await assert.rejects(
    async () => {
      if (childPid === undefined) throw new Error('missing child pid');
      process.kill(childPid, 0);
    },
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
  );
});
test('search MCP adapter bounds a rejecting close and preserves the close error', async () => {
  const closeError = new Error('transport close failed');
  const fakeTransport = {
    close: async () => { throw closeError; },
  } as unknown as { close: () => Promise<void> };
  const fakeClient = {
    connect: async () => {},
  } as unknown as import('@modelcontextprotocol/sdk/client').Client;

  const toolset = await createSearchMcpTools({
    createClient: () => fakeClient as never,
    createTransport: () => fakeTransport as never,
  });

  await assert.rejects(() => toolset.close(), (error: unknown) => error === closeError);
});

test('search MCP adapter bounds a hanging close', async () => {
  const fakeTransport = {
    close: async () => await new Promise<void>(() => {}),
  } as unknown as { close: () => Promise<void> };
  const fakeClient = {
    connect: async () => {},
  } as unknown as { connect: (transport: unknown) => Promise<void> };

  const toolset = await createSearchMcpTools({
    closeTimeoutMs: 10,
    createClient: () => fakeClient as never,
    createTransport: () => fakeTransport as never,
  });

  await assert.rejects(
    () => toolset.close(),
    (error: unknown) => error instanceof Error
      && error.name === 'RuntimeTimeoutError'
      && error.message === 'mcp:close timed out after 10ms',
  );
});

test('search MCP adapter forwards external abort to client.callTool and suppresses late settlement', async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  let lateReject: ((error: unknown) => void) | undefined;
  const fakeTransport = { close: async () => {} } as unknown as import('@modelcontextprotocol/sdk/client/stdio').StdioClientTransport;
  const fakeClient = {
    connect: async () => {},
    callTool: async (_request: unknown, _schema: unknown, requestOptions?: { signal?: AbortSignal }) => {
      observedSignal = requestOptions?.signal;
      return await new Promise<never>((_resolve, reject) => {
        lateReject = reject;
        requestOptions?.signal?.addEventListener('abort', () => reject(requestOptions.signal?.reason), { once: true });
      });
    },
  } as unknown as import('@modelcontextprotocol/sdk/client').Client;
  const toolset = await createSearchMcpTools({
    createClient: () => fakeClient,
    createTransport: () => fakeTransport,
    requestTimeoutMs: 1000,
  });

  const pending = toolset.searchTool.search('政策', controller.signal);
  controller.abort(new Error('MCP search aborted'));
  await assert.rejects(pending, /MCP search aborted/);
  assert.equal(observedSignal?.aborted, true);
  lateReject?.(new Error('late MCP failure'));
  await new Promise((resolve) => setImmediate(resolve));
  await toolset.close();
});


test('search MCP adapter rejects unsafe fetch targets before calling the worker', async () => {
  let calls = 0;
  const fakeTransport = { close: async () => {} } as unknown as StdioClientTransport;
  const fakeClient = {
    connect: async () => {},
    callTool: async () => { calls += 1; return { structuredContent: {} }; },
  } as unknown as import('@modelcontextprotocol/sdk/client').Client;
  const toolset = await createSearchMcpTools({
    createClient: () => fakeClient,
    createTransport: () => fakeTransport,
  });

  await assert.rejects(() => toolset.fetchTool.fetch('http://127.0.0.1:8080/internal'), /blocked unsafe network target/i);
  assert.equal(calls, 0);
  await toolset.close();
});


test('search MCP adapter derives suspected reprint clues from fetched content', async () => {
  const fakeTransport = { close: async () => {} } as unknown as StdioClientTransport;
  const fakeClient = {
    connect: async () => {},
    callTool: async () => ({
      structuredContent: {
        title: '绥化日报转载：科技招商通知',
        finalUrl: 'https://news.example.com/reprint',
        cleaned_text: '来源：绥化市人民政府，现转载如下。',
      },
    }),
  } as unknown as import('@modelcontextprotocol/sdk/client').Client;

  const toolset = await createSearchMcpTools({
    createClient: () => fakeClient,
    createTransport: () => fakeTransport,
  });

  const result = await toolset.fetchTool.fetch('https://news.example.com/reprint');

  assert.equal(result.evidence_clues?.is_suspected_reprint, true);
  await toolset.close();
});

test('search MCP adapter drops invalid access source grades instead of casting them', async () => {
  const fakeTransport = { close: async () => {} } as unknown as StdioClientTransport;
  const fakeClient = {
    connect: async () => {},
    callTool: async () => ({
      structuredContent: {
        results: [{
          title: '候选页面',
          url: 'https://example.com/page',
          snippet: '页面摘要',
          access_source_grade: 'forged_business_conclusion',
        }, {
          title: '官方访问页',
          url: 'https://example.com/access',
          snippet: '访问说明',
          access_source_grade: 'official_access',
        }],
      },
    }),
  } as unknown as import('@modelcontextprotocol/sdk/client').Client;

  const toolset = await createSearchMcpTools({
    createClient: () => fakeClient,
    createTransport: () => fakeTransport,
  });

  const [candidate, validCandidate] = await toolset.searchTool.search('测试');

  assert.equal(candidate?.access_source_grade, undefined);
  assert.equal(validCandidate?.access_source_grade, 'official_access');
  await toolset.close();
});

test('search MCP adapter contract maps Kerry-style search and fetch records', () => {
  const candidate: SearchDiscoveryRecord = {
    query: '黑龙江省 2026 大规模设备更新 政策',
    title: '关于印发《黑龙江省2026年大规模设备更新和消费品以旧换新实施方案》的通知',
    url: 'https://drc.hlj.gov.cn/drc/c111444/202602/c00_31915357.shtml',
    snippet: '实施方案已经省政府同意，现印发给你们。',
    source: 'baidu',
    sources: ['baidu'],
    quality_status: 'green',
    quality_reason: 'usable_results',
    kerry_quality_status: 'usable_results',
    kerry_quality_reason: 'usable_results',
  };

  const page: FetchedPageRecord = {
    requestedUrl: candidate.url,
    finalUrl: candidate.url,
    title: candidate.title,
    content: '《黑龙江省2026年大规模设备更新和消费品以旧换新实施方案》已经省政府同意正式印发实施。',
    backend: 'search-mcp:fetch_url',
    evidence_clues: {
      is_suspected_reprint: false,
      extracted_doc_no: '黑发改环资规〔2026〕1号',
      potential_official_urls: [],
    },
    kerry_cleaning: {
      raw_text: '首页 登录 《黑龙江省2026年大规模设备更新和消费品以旧换新实施方案》已经省政府同意正式印发实施。',
      cleaned_text: '《黑龙江省2026年大规模设备更新和消费品以旧换新实施方案》已经省政府同意正式印发实施。',
      metadata: {
        document_number: '黑发改环资规〔2026〕1号',
        issuing_body: '黑龙江省发展和改革委员会',
      },
      removed_fragments: [{ reason: 'chrome_block', text: '首页 登录' }],
      cleaning_alerts: [],
      cleaning_stats: { raw_length: 60, cleaned_length: 40 },
    },
  };

  assert.equal(candidate.kerry_quality_status, 'usable_results');
  assert.equal(page.backend, 'search-mcp:fetch_url');
  assert.equal(page.content, page.kerry_cleaning?.cleaned_text);
  assert.equal(page.kerry_cleaning?.metadata?.document_number, '黑发改环资规〔2026〕1号');
  assert.deepEqual(page.kerry_cleaning?.cleaning_alerts, []);
});
