import test from 'node:test';
import assert from 'node:assert/strict';
import type { PolicyAgentState } from '../../src/policy-task/state-schema.ts';
import type { PolicyAgentDecision } from '../../src/policy-task/output-schema.ts';
import { runLocalPolicyAgentIteration } from '../../src/runtime/run-local-policy-agent.ts';

test('policy state and decision shapes support iterative search/fetch loops', () => {
  const state: PolicyAgentState = {
    task: { topic: '科技招商政策' },
    discoveredCandidates: [],
    fetchedEvidence: [],
    transcriptPath: undefined,
    currentIteration: 0,
    uncertainties: [],
  };

  const decision: PolicyAgentDecision = {
    decision: 'continue_search',
    reasoning: 'Need more candidate URLs.',
    searchActions: [{ query: '科技招商政策', why: 'start broad' }],
    fetchActions: [],
    discardedLeads: [],
    uncertainties: ['No strong fetched evidence yet'],
  };

  assert.equal(state.currentIteration, 0);
  assert.equal(decision.searchActions[0]?.query, '科技招商政策');
});

test('runtime can execute one agent iteration with separate search and fetch tools', async () => {
  const result = await runLocalPolicyAgentIteration({
    task: { topic: '科技招商政策' },
    discoveredCandidates: [],
    fetchedEvidence: [],
    currentIteration: 0,
    uncertainties: [],
  }, {
    askAgent: async () => ({
      decision: 'continue_search',
      reasoning: 'Need candidate URLs.',
      searchActions: [{ query: '科技招商政策', why: 'start broad' }],
      fetchActions: [],
      discardedLeads: [],
      uncertainties: ['No fetched evidence yet'],
    }),
    searchTool: {
      search: async () => [
        { query: '科技招商政策', title: '政策标题', url: 'https://example.gov.cn/policy', snippet: '摘要', source: 'backend' },
      ],
    },
    fetchTool: {
      fetch: async () => ({
        requestedUrl: 'https://example.gov.cn/policy',
        finalUrl: 'https://example.gov.cn/policy?final=1',
        title: '政策全文',
        content: '正文内容',
        backend: 'backend-a',
      }),
    },
  });

  assert.equal(result.discoveredCandidates[0]?.url, 'https://example.gov.cn/policy');
  assert.equal(result.decision.reasoning, 'Need candidate URLs.');
});

test('runtime defaults to the real Claude decision path when no fake askAgent is injected', async () => {
  const captured = { prompt: null as null | string };

  const result = await runLocalPolicyAgentIteration({
    task: { topic: '科技招商政策' },
    discoveredCandidates: [],
    fetchedEvidence: [],
    currentIteration: 0,
    uncertainties: [],
  }, {
    callModel: async (prompt) => {
      captured.prompt = prompt;
      return JSON.stringify({
        decision: 'continue_search',
        reasoning: 'Need live candidate URLs from search.',
        searchActions: [{ query: '科技招商政策 site:gov.cn', why: 'find official pages' }],
        fetchActions: [],
        discardedLeads: [],
        uncertainties: ['No fetched official evidence yet'],
      });
    },
    searchTool: {
      search: async (query) => [
        { query, title: '官方政策', url: 'https://example.gov.cn/policy', snippet: '政策正文摘要', source: 'backend' },
      ],
    },
    fetchTool: {
      fetch: async () => ({
        requestedUrl: 'https://example.gov.cn/policy',
        finalUrl: 'https://example.gov.cn/policy',
        title: '官方政策',
        content: '政策正文',
        backend: 'backend-a',
      }),
    },
  });

  assert.match(captured.prompt ?? '', /You are the single Local Policy Agent/i);
  assert.equal(result.decision.reasoning, 'Need live candidate URLs from search.');
  assert.equal(result.discoveredCandidates[0]?.query, '科技招商政策 site:gov.cn');
});

test('runtime emits brain action audit counts for search and fetch decisions when debug is enabled', async (t) => {
  const originalDebug = process.env.LIVE_AUDIT_DEBUG;
  process.env.LIVE_AUDIT_DEBUG = '1';
  const logs: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });

  try {
    await runLocalPolicyAgentIteration({
      task: { topic: '科技招商政策' },
      discoveredCandidates: [],
      fetchedEvidence: [],
      currentIteration: 0,
      uncertainties: [],
    }, {
      askAgent: async () => ({
        decision: 'continue_search',
        reasoning: 'Need candidate URLs and page evidence.',
        searchActions: [{ query: '科技招商政策', why: 'start broad' }],
        fetchActions: [],
        discardedLeads: [],
        uncertainties: ['Need fetched evidence'],
      }),
      searchTool: {
        search: async () => [],
      },
      fetchTool: {
        fetch: async (url) => ({
          requestedUrl: url,
          finalUrl: url,
          title: '政策全文',
          content: '正文内容',
          backend: 'backend-a',
        }),
      },
    });
  } finally {
    if (originalDebug === undefined) delete process.env.LIVE_AUDIT_DEBUG;
    else process.env.LIVE_AUDIT_DEBUG = originalDebug;
  }

  assert.equal(logs.some((line) => line.includes('=== [LLM BRAIN ACTION DEFLECTION AUDIT] ===')), false);
  assert.equal(logs.some((line) => line.includes('decision.type = "continue_search"')), false);
  assert.equal(logs.some((line) => line.includes('decision.searchActions count = 1')), false);
  assert.equal(logs.some((line) => line.includes('decision.fetchActions count = 0')), false);
  assert.equal(logs.some((line) => line.includes('LLM refused to issue FETCH action')), false);
});

test('runtime brain audit does not print raw model output or URL excerpts', async (t) => {
  const originalDebug = process.env.LIVE_AUDIT_DEBUG;
  process.env.LIVE_AUDIT_DEBUG = '1';
  const logs: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });

  try {
    await runLocalPolicyAgentIteration({
      task: { topic: '科技招商政策' },
      discoveredCandidates: [],
      fetchedEvidence: [],
      currentIteration: 0,
      uncertainties: [],
    }, {
      askAgent: async () => ({
        decision: 'stop',
        reasoning: 'No reasoning returned.',
        searchActions: [],
        fetchActions: [],
        discardedLeads: [],
        uncertainties: [],
        finalPackage: {
          _raw_model_output: '{"next_actions":[{"url":"https://www.hlj.gov.cn/","why":"唯一强相关官方入口，应立即抓取正文证据。"}]}',
        },
      }),
      searchTool: {
        search: async () => [],
      },
      fetchTool: {
        fetch: async (url) => ({
          requestedUrl: url,
          finalUrl: url,
          title: '政策全文',
          content: '正文内容',
          backend: 'backend-a',
        }),
      },
    });
  } finally {
    if (originalDebug === undefined) delete process.env.LIVE_AUDIT_DEBUG;
    else process.env.LIVE_AUDIT_DEBUG = originalDebug;
  }

  assert.equal(logs.some((line) => line.includes('=== [RAW BRAIN OUTPUT CELL BIOPSY] ===')), false);
  assert.equal(logs.some((line) => line.includes('https://www.hlj.gov.cn/')), false);
});

test('runtime projects askAgent failure without emitting a successful decision', async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const failure = new Error('model backend exploded');

  await assert.rejects(
    () => runLocalPolicyAgentIteration({
      task: { topic: '科技招商政策' },
      discoveredCandidates: [],
      fetchedEvidence: [],
      currentIteration: 2,
      uncertainties: [],
    }, {
      askAgent: async () => {
        throw failure;
      },
      searchTool: { search: async () => [] },
      fetchTool: { fetch: async () => { throw new Error('unexpected fetch'); } },
      onDebugEvent: (event) => events.push(event),
    }),
    (error) => error === failure,
  );

  assert.equal(events.some((event) => event.type === 'agent.failure'), true);
  assert.equal(events.some((event) => event.type === 'state.updated'), true);
  assert.equal(events.some((event) => event.type === 'agent.decision'), false);
  const stateEvent = events.find((event) => event.type === 'state.updated');
  assert.equal((stateEvent?.payload.state as { runtimeFailure?: { stage?: string } }).runtimeFailure?.stage, 'agent');
});

test('runtime emits tool-specific failure events when search fails', async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

  await runLocalPolicyAgentIteration({
      task: { topic: '科技招商政策' },
      discoveredCandidates: [],
      fetchedEvidence: [],
      currentIteration: 0,
      uncertainties: [],
    }, {
      askAgent: async () => ({
        decision: 'continue_search',
        reasoning: 'Need candidate URLs.',
        searchActions: [{ query: '科技招商政策', why: 'start broad' }],
        fetchActions: [],
        discardedLeads: [],
        uncertainties: ['No fetched evidence yet'],
      }),
      searchTool: {
        search: async () => {
          throw new Error('search backend exploded');
        },
      },
      fetchTool: {
        fetch: async () => ({
          requestedUrl: 'https://example.gov.cn/policy',
          finalUrl: 'https://example.gov.cn/policy?final=1',
          title: '政策全文',
          content: '正文内容',
          backend: 'backend-a',
        }),
      },
      onDebugEvent: (event) => {
        events.push(event);
      },
    }
  );

  assert.equal(events.some((event) => event.type === 'tool.search.request'), true);
  assert.equal(events.some((event) => event.type === 'tool.search.failure'), true);
});

