import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchHttpServer } from '../../src/adapters/http/server.ts';
import { assertSafeHttpExposure, isLoopbackHost } from '../../src/adapters/http/exposure.ts';

test('HTTP adapter routes research through the shared application service', async () => {
  const server = createResearchHttpServer({
    llm: { complete: async () => ({ text: JSON.stringify({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'ok', evidenceUrls: [], findings: [] }) }) },
    search: { name: 'search', search: async () => ({ outcome: 'success_empty', results: [], provider: 'search', durationMs: 1, retryCount: 0 }) },
    fetch: { name: 'fetch', fetch: async (url) => ({ outcome: 'success_with_content', requestedUrl: url, finalUrl: url, title: 'Example', content: 'body', provider: 'fetch', extractionWarnings: [], durationMs: 1, retryCount: 0 }) },
  }, undefined, { exposeAtomicTools: true });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const port = (address as { port: number }).port;
  try {
    const health = await fetch(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(health.status, 200);
    const research = await fetch(`http://127.0.0.1:${port}/v1/research`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'x' }) });
    assert.equal(research.status, 200);
    assert.equal((await research.json() as any).state.finalAnswer, 'ok');
    const search = await fetch(`http://127.0.0.1:${port}/v1/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'x' }) });
    assert.equal(search.status, 200);
    const fetchResult = await fetch(`http://127.0.0.1:${port}/v1/fetch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com' }) });
    assert.equal(fetchResult.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('HTTP deployment requires external authentication off loopback and protects research data', async () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.throws(() => assertSafeHttpExposure('0.0.0.0'), /RESEARCH_HTTP_AUTH_TOKEN/);
  assert.doesNotThrow(() => assertSafeHttpExposure('0.0.0.0', 'external-secret'));

  const manager = { list: () => [], get: () => undefined, events: () => undefined, start: () => { throw new Error('unused'); }, cancel: () => false } as any;
  const server = createResearchHttpServer({
    llm: { complete: async () => { throw new Error('unused'); } },
    search: { name: 'search', search: async () => { throw new Error('unused'); } },
    fetch: { name: 'fetch', fetch: async () => { throw new Error('unused'); } },
  }, manager, { authToken: 'external-secret' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/monitor`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/research`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/research`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/research`, { headers: { authorization: 'Bearer external-secret' } })).status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('HTTP adapter rejects execution budgets that the agent cannot honor', async () => {
  const server = createResearchHttpServer({
    llm: { complete: async () => { throw new Error('must not call model'); } },
    search: { name: 'search', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fetch', fetch: async () => { throw new Error('must not fetch'); } },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    for (const options of [
      { maxIterations: 101 },
      { maxSearchActionsPerTurn: 9 },
      { maxFetchActionsPerTurn: 9 },
      { minFetchedPages: 101 },
      { unknownBudget: 1 },
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/research`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'x', options }),
      });
      assert.equal(response.status, 400, JSON.stringify(options));
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('HTTP monitor endpoints use bounded projections and incremental event cursors', async () => {
  const events = [1, 2, 3].map((sequence) => ({ runId: 'run_test', sequence, type: `event.${sequence}`, timestamp: '2026-08-04T00:00:00.000Z', payload: { sequence } }));
  const run = {
    runId: 'run_test', status: 'running', task: { question: 'monitor me' }, createdAt: '2026-08-04T00:00:00.000Z',
    reportStatus: 'pending', events,
    result: {
      status: 'interrupted', decision: { decision: 'review', searchActions: [], fetchActions: [], uncertainties: [] },
      state: { task: { question: 'monitor me' }, currentIteration: 1, decisions: [], searchResults: [{ query: 'q', title: 'A', url: 'https://example.com', snippet: 'large content must stay out of list', provider: 'search' }], fetchedPages: [], uncertainties: [] },
    },
  };
  const manager = {
    list: () => [run], get: (runId: string) => runId === run.runId ? run : undefined,
    events: (runId: string) => runId === run.runId ? events : undefined,
    start: () => run, cancel: () => false,
  } as any;
  const server = createResearchHttpServer({
    llm: { complete: async () => { throw new Error('unused'); } },
    search: { name: 'search', search: async () => { throw new Error('unused'); } },
    fetch: { name: 'fetch', fetch: async () => { throw new Error('unused'); } },
  }, manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/v1/research`)).json() as any;
    assert.equal(list.runs[0].question, 'monitor me');
    assert.equal(list.runs[0].counts.searchResults, 1);
    assert.equal(list.runs[0].result, undefined);
    assert.equal(list.runs[0].events, undefined);

    const detail = await (await fetch(`http://127.0.0.1:${port}/v1/research/run_test`)).json() as any;
    assert.equal(detail.result, undefined);
    const full = await (await fetch(`http://127.0.0.1:${port}/v1/research/run_test?include=full`)).json() as any;
    assert.equal(full.result.state.searchResults.length, 1);

    const incremental = await (await fetch(`http://127.0.0.1:${port}/v1/research/run_test/events?afterSequence=1&limit=1`)).json() as any;
    assert.deepEqual(incremental.events.map((event: any) => event.sequence), [2]);
    assert.equal(incremental.nextSequence, 2);
    assert.equal(incremental.hasMore, true);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/research/run_test/events?afterSequence=-1`)).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('HTTP cancellation is idempotent for existing runs and reserves 404 for unknown ids', async () => {
  let cancellations = 0;
  const run = { runId: 'run_cancel', status: 'cancelling', task: { question: 'cancel' }, createdAt: '2026-08-04T00:00:00.000Z', reportStatus: 'pending', events: [] };
  const manager = {
    list: () => [run], get: (runId: string) => runId === run.runId ? run : undefined,
    events: () => [], start: () => run,
    cancel: () => { cancellations += 1; return cancellations === 1; },
  } as any;
  const server = createResearchHttpServer({
    llm: { complete: async () => { throw new Error('unused'); } },
    search: { name: 'search', search: async () => { throw new Error('unused'); } },
    fetch: { name: 'fetch', fetch: async () => { throw new Error('unused'); } },
  }, manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/research/run_cancel/cancel`, { method: 'POST' })).status, 202);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/research/run_cancel/cancel`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/research/run_missing/cancel`, { method: 'POST' })).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
