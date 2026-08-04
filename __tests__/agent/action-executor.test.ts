import test from 'node:test';
import assert from 'node:assert/strict';
import { executeAgentActions } from '../../src/agent/action-executor.ts';
import type { AgentState } from '../../src/agent/types.ts';

const state: AgentState = {
  task: { question: 'find facts' }, currentIteration: 0, decisions: [], searchResults: [], fetchedPages: [], uncertainties: [],
};

test('executes search then fetch in model order and preserves transport facts', async () => {
  const events: string[] = [];
  const next = await executeAgentActions(state, {
    decision: 'fetch', searchActions: [], fetchActions: [{ url: 'https://example.com' }], uncertainties: [],
  }, {
    search: { name: 'fake-search', search: async () => ({ outcome: 'success_with_content', provider: 'fake-search', results: [], durationMs: 1, retryCount: 0 }) },
    fetch: { name: 'fake-fetch', fetch: async (url) => ({ outcome: 'success_with_content', requestedUrl: url, finalUrl: url, title: 'Example', content: 'body', provider: 'fake-fetch', extractionWarnings: [], durationMs: 1, retryCount: 0 }) },
    onEvent: (event) => events.push(event.type),
  });

  assert.equal(next.currentIteration, 1);
  assert.equal(next.fetchedPages[0]?.content, 'body');
  assert.deepEqual(events, ['fetch.request', 'fetch.result']);
});

test('does not start an action after cancellation', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(() => executeAgentActions(state, { decision: 'search', searchActions: [{ query: 'x' }], fetchActions: [], uncertainties: [] }, {
    search: { name: 'fake', search: async () => { throw new Error('must not run'); } },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not run'); } },
  }, controller.signal), /cancelled/);
});

test('discards a provider success that arrives after cancellation before state or evidence writes', async () => {
  const controller = new AbortController();
  let release!: () => void;
  let evidenceWrites = 0;
  const events: string[] = [];
  const pending = executeAgentActions(state, {
    decision: 'fetch', searchActions: [], fetchActions: [{ url: 'https://example.com/late' }], uncertainties: [],
  }, {
    search: { name: 'fake-search', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'ignores-abort', fetch: async (url) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { outcome: 'success_with_content', requestedUrl: url, finalUrl: url, title: 'late', content: 'must be discarded', provider: 'ignores-abort', extractionWarnings: [], durationMs: 1, retryCount: 0 };
    } },
    evidenceStore: { saveFetchedPage: async () => { evidenceWrites += 1; } },
    onEvent: (event) => events.push(event.type),
  }, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('cancelled while fetching'));
  release();
  await assert.rejects(() => pending, /cancelled while fetching/);
  assert.equal(evidenceWrites, 0);
  assert.deepEqual(events, ['fetch.request', 'fetch.cancelled']);
});

test('turns a thrown search provider error into a structured outcome and preserves earlier results', async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const next = await executeAgentActions(state, {
    decision: 'search',
    searchActions: [{ query: 'works' }, { query: 'throws' }],
    fetchActions: [],
    uncertainties: [],
  }, {
    search: {
      name: 'fake-search',
      search: async (query) => {
        if (query === 'throws') throw new Error('upstream socket closed');
        return {
          outcome: 'success_with_content', provider: 'fake-search', durationMs: 1, retryCount: 0,
          results: [{ query, title: 'kept', url: 'https://example.com/kept', snippet: 'proof', provider: 'fake-search' }],
        };
      },
    },
    fetch: { name: 'fake-fetch', fetch: async () => { throw new Error('must not fetch'); } },
    onEvent: (event) => events.push(event),
  });

  assert.equal(next.currentIteration, 1);
  assert.deepEqual(next.searchResults.map((item) => item.title), ['kept']);
  const failed = events.find((event) => event.type === 'search.result' && event.payload.query === 'throws');
  assert.equal(failed?.payload.outcome, 'transport_error');
  assert.equal((failed?.payload.error as { code?: string })?.code, 'SEARCH_PROVIDER_THROW');
});

test('turns a thrown fetch provider error into a fetched-page outcome', async () => {
  const next = await executeAgentActions(state, {
    decision: 'fetch', searchActions: [], fetchActions: [{ url: 'https://example.com/broken' }], uncertainties: [],
  }, {
    search: { name: 'fake-search', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake-fetch', fetch: async () => { throw new Error('connection reset'); } },
  });

  assert.equal(next.currentIteration, 1);
  assert.equal(next.fetchedPages[0]?.outcome, 'transport_error');
  assert.equal(next.fetchedPages[0]?.error?.code, 'FETCH_PROVIDER_THROW');
});

test('reports evidence persistence failure separately without changing the tool outcome', async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const next = await executeAgentActions(state, {
    decision: 'search', searchActions: [{ query: 'persist me' }], fetchActions: [], uncertainties: [],
  }, {
    search: {
      name: 'fake-search',
      search: async (query) => ({
        outcome: 'success_with_content', provider: 'fake-search', durationMs: 1, retryCount: 0,
        results: [{ query, title: 'result', url: 'https://example.com/result', snippet: 'proof', provider: 'fake-search' }],
      }),
    },
    fetch: { name: 'fake-fetch', fetch: async () => { throw new Error('must not fetch'); } },
    evidenceStore: { saveSearchResults: async () => { throw new Error('disk full'); } },
    onEvent: (event) => events.push(event),
  });

  assert.equal(next.searchResults.length, 1);
  assert.equal(events.find((event) => event.type === 'search.result')?.payload.outcome, 'success_with_content');
  assert.deepEqual(events.find((event) => event.type === 'evidence.write_error')?.payload, {
    operation: 'saveSearchResults', code: 'EVIDENCE_WRITE_FAILED', message: 'disk full',
  });
});

test('runs actions in one decision concurrently while preserving submitted result order', async () => {
  const releases = new Map<string, () => void>();
  const started: string[] = [];
  const running = executeAgentActions(state, {
    decision: 'search',
    searchActions: [{ query: 'first' }, { query: 'second' }, { query: 'third' }],
    fetchActions: [], uncertainties: [],
  }, {
    search: {
      name: 'fake-search',
      search: async (query) => {
        started.push(query);
        await new Promise<void>((resolve) => releases.set(query, resolve));
        return {
          outcome: 'success_with_content' as const, provider: 'fake-search', durationMs: 1, retryCount: 0,
          results: [{ query, title: query, url: `https://example.com/${query}`, snippet: query, provider: 'fake-search' }],
        };
      },
    },
    fetch: { name: 'fake-fetch', fetch: async () => { throw new Error('must not fetch'); } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['first', 'second', 'third']);
  releases.get('third')!(); releases.get('second')!(); releases.get('first')!();
  const next = await running;
  assert.deepEqual(next.searchResults.map((item) => item.query), ['first', 'second', 'third']);
});
