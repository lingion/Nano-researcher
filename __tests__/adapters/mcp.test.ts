import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchMcpHandlers } from '../../src/adapters/mcp/tools.ts';
import { genericResearchToolDefinitions } from '../../src/adapters/mcp/server.ts';

test('MCP handlers use the shared research service and atomic providers', async () => {
  const handlers = createResearchMcpHandlers({
    llm: { complete: async () => ({ text: JSON.stringify({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'mcp', evidenceUrls: [], findings: [] }) }) },
    search: { name: 'search', search: async (query) => ({ outcome: 'success_with_content', results: [{ query, title: 'A', url: 'https://example.com', snippet: 'x', provider: 'search' }], provider: 'search', durationMs: 1, retryCount: 0 }) },
    fetch: { name: 'fetch', fetch: async (url) => ({ outcome: 'success_with_content', requestedUrl: url, finalUrl: url, title: 'A', content: 'x', provider: 'fetch', extractionWarnings: [], durationMs: 1, retryCount: 0 }) },
  });
  const research = await handlers.research({ question: 'x' });
  assert.equal(research.state.finalAnswer, 'mcp');
  assert.equal((await handlers.search({ query: 'x' })).results.length, 1);
  assert.equal((await handlers.fetch({ url: 'https://example.com' })).content, 'x');
});

test('MCP exposes only unified research by default and publishes the real bounded option contract', () => {
  const tools = genericResearchToolDefinitions();
  assert.deepEqual(tools.map((tool) => tool.name), ['research']);
  const options = (tools[0].inputSchema.properties.options as any).properties;
  assert.equal(options.maxIterations.maximum, 100);
  assert.equal(options.maxSearchActionsPerTurn.maximum, 8);
  assert.equal(options.maxFetchActionsPerTurn.maximum, 8);
  assert.deepEqual(genericResearchToolDefinitions(true).map((tool) => tool.name), ['research', 'search', 'fetch']);
});

test('MCP research handler uses the shared strict task validator', async () => {
  const handlers = createResearchMcpHandlers({
    llm: { complete: async () => { throw new Error('must not run'); } },
    search: { name: 'search', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fetch', fetch: async () => { throw new Error('must not fetch'); } },
  });
  await assert.rejects(() => handlers.research({ question: 'x', options: { maxIterations: 101 } }), /invalid_option_maxIterations/);
  await assert.rejects(() => handlers.research({ question: 'x', options: { unsupported: true } } as any), /unknown_option_unsupported/);
});

test('MCP handler propagates client cancellation into the generic agent', async () => {
  let receivedSignal: AbortSignal | undefined;
  const handlers = createResearchMcpHandlers({
    llm: { complete: async ({ signal }) => {
      receivedSignal = signal;
      return await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } },
    search: { name: 'search', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fetch', fetch: async () => { throw new Error('must not fetch'); } },
  });
  const controller = new AbortController();
  const pending = handlers.research({ question: 'x' }, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('client cancelled'));
  const result = await pending;
  assert.equal(receivedSignal, controller.signal);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.state.interrupted?.reason, 'cancelled');
});

test('MCP research handler combines its wall-clock deadline with client cancellation', async () => {
  let receivedSignal: AbortSignal | undefined;
  const handlers = createResearchMcpHandlers({
    llm: {
      structuredOutputMode: 'tool_call',
      complete: async ({ signal }) => {
        receivedSignal = signal;
        return await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
    },
    search: { name: 'search', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fetch', fetch: async () => { throw new Error('must not fetch'); } },
  }, { runTimeoutMs: 10 });
  const result = await handlers.research({ question: 'deadline' });
  assert.equal(receivedSignal?.aborted, true);
  assert.match(String(receivedSignal?.reason), /timed out/i);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.state.interrupted?.reason, 'timeout');
});
