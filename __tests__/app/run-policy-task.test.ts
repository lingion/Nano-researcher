import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildPolicyPrompt } from '../../src/policy-task/prompt-builder.ts';
import { runPolicyTask, runPolicyTaskLoop } from '../../src/app/run-policy-task.ts';
import type { BrowserAdapter } from '../../src/fetch-fusion/browser-fetch.ts';

test('policy loop uses Browser fallback after a weak MCP fetch result', async () => {
  let decisionStep = 0;
  let browserCalls = 0;
  const browserAdapter: BrowserAdapter = {
    render: async (url) => {
      browserCalls += 1;
      return {
        finalUrl: url,
        title: 'Rendered access page',
        text: '申请体验 developer preview 2026-07-20 ' + '正文'.repeat(80),
      };
    },
  };

  const result = await runPolicyTaskLoop(
    { topic: 'AI access' },
    {
      maxIterations: 3,
      enableBrowser: true,
      ...({ browserAdapter } as Record<string, unknown>),
      createToolset: async () => ({
        searchTool: {
          search: async (query) => [{
            query,
            title: 'Candidate',
            url: 'https://example.com/access',
            snippet: 'Candidate',
            source: 'search-mcp',
          }],
        },
        fetchTool: {
          fetch: async (url) => ({
            requestedUrl: url,
            finalUrl: url,
            title: 'JavaScript required',
            content: 'Please enable JavaScript',
            backend: 'search-mcp:fetch_url',
          }),
        },
      }),
      askAgent: async (state) => {
        decisionStep += 1;
        if (decisionStep === 1) {
          return {
            decision: 'continue_search',
            reasoning: 'Find a candidate.',
            searchActions: [{ query: 'AI access', why: 'find candidate' }],
            fetchActions: [],
            uncertainties: [],
            discardedLeads: [],
          };
        }
        if (decisionStep === 2) {
          return {
            decision: 'continue_fetch',
            reasoning: 'Fetch candidate evidence.',
            searchActions: [],
            fetchActions: [{
              url: state.discoveredCandidates[0]?.url ?? 'https://example.com/access',
              why: 'fetch candidate',
            }],
            uncertainties: [],
            discardedLeads: [],
          };
        }
        return {
          decision: 'summarize_and_stop',
          reasoning: 'Review rendered evidence.',
          searchActions: [],
          fetchActions: [],
          uncertainties: [],
          discardedLeads: [],
        };
      },
    },
  );

  assert.equal(decisionStep, 3);
  assert.equal(browserCalls, 1);
  assert.equal(result.fetchedEvidence[0]?.backend, 'playwright');
  assert.match(result.fetchedEvidence[0]?.content ?? '', /developer preview/);
});
test('policy loop does not print search query or rationale to stdout', async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(' '));
  });

  await runPolicyTaskLoop(
    { topic: 'stdout redaction' },
    {
      maxIterations: 1,
      askAgent: async () => ({
        decision: 'continue_search',
        reasoning: 'synthetic reasoning',
        searchActions: [{ query: 'SYNTHETIC_SEARCH_QUERY', why: 'SYNTHETIC_SEARCH_WHY' }],
        fetchActions: [],
        uncertainties: [],
        discardedLeads: [],
      }),
      searchTool: { search: async () => [] },
      fetchTool: { fetch: async () => ({}) as never },
    },
  );

  assert.doesNotMatch(lines.join('\\n'), /SYNTHETIC_SEARCH_QUERY|SYNTHETIC_SEARCH_WHY/);
});

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

test('runPolicyTask preserves injected official provider candidates in the search layer', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-official-default-'));
  const calls: string[] = [];
  const candidates = [
    { title: '国家发展改革委招商政策解读', url: 'https://www.ndrc.gov.cn/policy', snippet: '招商政策线索', source: 'ndrc-policy-search' },
    { title: '工业和信息化部高新区政策发布会', url: 'https://www.miit.gov.cn/policy', snippet: '高新区和科技创新政策内容', source: 'miit-policy-search' },
    { title: '国务院政策库', url: 'https://www.gov.cn/policy', snippet: '政策内容', source: 'gov-cn-policy-library-search' },
    { title: '一般搜索结果', url: 'https://example.gov.cn/policy', snippet: '政策摘要', source: 'search_auto' },
  ];
  const result = await runPolicyTask({ topic: '科技招商政策' }, {
    outputDir,
    callModel: async () => JSON.stringify({ decision: 'continue_search', reasoning: 'Need official candidate URLs first.', searchActions: [{ query: '科技招商政策 site:gov.cn', why: 'find official policy pages' }], fetchActions: [], discardedLeads: [], uncertainties: [] }),
    createToolset: async () => ({
      searchTool: { search: async (query) => { calls.push(query); return candidates; } },
      fetchTool: { fetch: async (url) => ({ requestedUrl: url, finalUrl: url, title: '', content: '', backend: 'test' }) },
    }),
  });
  const audit = JSON.parse(await readFile(result.resultAuditPath, 'utf8')) as { candidates?: Array<{ source?: string }> };
  assert.deepEqual(calls, ['科技招商政策 site:gov.cn']);
  for (const source of ['ndrc-policy-search', 'miit-policy-search', 'gov-cn-policy-library-search', 'search_auto']) assert.equal(audit.candidates?.some((item) => item.source === source), true);
});

test('runPolicyTask preserves injected Kerry status for junk query candidates without drift', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-default-status-lock-'));
  const result = await runPolicyTask({ topic: '招聘租房广告' }, {
    outputDir,
    callModel: async () => JSON.stringify({ decision: 'continue_search', reasoning: 'Need candidate URLs first.', searchActions: [{ query: '招聘租房广告', why: 'trigger injected search path' }], fetchActions: [], discardedLeads: [], uncertainties: [] }),
    createToolset: async () => ({
      searchTool: { search: async () => [
        { title: '招聘租房广告大合集', url: 'https://example.com/jobs', snippet: '招聘 租房 广告', source: 'search_auto', kerry_quality_status: 'junk_heavy', kerry_quality_reason: 'commercial noise' },
        { title: '酒店机票特惠', url: 'https://example.com/travel', snippet: '酒店 机票 优惠', source: 'search_auto', kerry_quality_status: 'junk_heavy', kerry_quality_reason: 'intent mismatch' },
      ] },
      fetchTool: { fetch: async (url) => ({ requestedUrl: url, finalUrl: url, title: '', content: '', backend: 'test' }) },
    }),
  });
  const audit = JSON.parse(await readFile(result.resultAuditPath, 'utf8')) as { candidates?: Array<{ source?: string; kerry_quality_status?: string; kerry_quality_reason?: string }> };
  const autoCandidates = audit.candidates?.filter((item) => item.source === 'search_auto') ?? [];
  assert.equal(autoCandidates.length, 2);
  assert.deepEqual(autoCandidates.map((item) => item.kerry_quality_status), ['junk_heavy', 'junk_heavy']);
  assert.equal(autoCandidates.every((item) => /commercial noise|intent mismatch/i.test(item.kerry_quality_reason ?? '')), true);
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

test('runPolicyTask redacts failure messages from the separate debug trace artifact', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-debug-failure-redaction-'));

  await assert.rejects(
    () => runPolicyTask(
      { topic: '科技招商政策' },
      {
        outputDir,
        debug: true,
        callModel: async () => {
          throw new Error('SYNTHETIC_UPSTREAM_MESSAGE');
        },
        searchTool: { search: async () => [] },
        fetchTool: { fetch: async () => ({}) as never },
      },
    ),
    /SYNTHETIC_UPSTREAM_MESSAGE/,
  );

  const debugTrace = await readFile(path.join(outputDir, 'debug-trace.json'), 'utf8');
  assert.doesNotMatch(debugTrace, /SYNTHETIC_UPSTREAM_MESSAGE/);
  assert.match(debugTrace, /"name"\s*:\s*"Error"/);
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
