import assert from 'node:assert/strict';
import test from 'node:test';
import { AutoSearchProvider } from './auto.ts';
import type { AutoEngine } from './contracts.ts';

function engine(name: string, fn: AutoEngine['run']): AutoEngine {
  return { name, capabilities: ['general-web'], run: fn };
}

test('Auto stops at the engine budget and returns per-engine diagnostics', async () => {
  const calls: string[] = [];
  const auto = new AutoSearchProvider({
    engines: ['one', 'two', 'three'].map((name) => engine(name, async (query) => {
      calls.push(name);
      return { engine: name, outcome: 'success_with_content', results: [{ query, title: name, url: `https://${name}.example/`, snippet: name, provider: name, rank: 1 }], durationMs: 1, requestCount: 1, retryCount: 0 };
    })),
    maxEngineCalls: 2,
    deadlineMs: 1000,
    limit: 10,
  });
  const result = await auto.search('query');
  assert.deepEqual(calls, ['one', 'two']);
  assert.equal(result.diagnostics?.length, 2);
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.autoDiagnostics?.batches, [['one', 'two']]);
  assert.equal(result.autoDiagnostics?.stoppedReason, 'engine_budget');
});

test('Auto propagates cancellation to the active engine and returns bounded diagnostics', async () => {
  let observedAbort = false;
  const controller = new AbortController();
  const auto = new AutoSearchProvider({
    engines: [engine('slow', async (_query, context) => new Promise((resolve) => {
      context.signal.addEventListener('abort', () => { observedAbort = true; resolve({ engine: 'slow', outcome: 'timeout', results: [], durationMs: 1, requestCount: 1, retryCount: 0 }); }, { once: true });
    }))],
    deadlineMs: 1000,
  });
  const pending = auto.search('query', { signal: controller.signal });
  controller.abort(new Error('cancel test'));
  const result = await pending;
  assert.equal(observedAbort, true);
  assert.equal(result.outcome, 'timeout');
});

test('Auto expands to the second engine batch only when the primary batch is insufficient', async () => {
  const calls: string[] = [];
  const make = (name: string, count: number): AutoEngine => engine(name, async (query) => {
    calls.push(name);
    return { engine: name, outcome: count ? 'success_with_content' : 'success_empty', results: Array.from({ length: count }, (_, index) => ({ query, title: `${name}-${index}`, url: `https://${name}.example/${index}`, snippet: name, provider: name, rank: index + 1 })), durationMs: 1, requestCount: 1, retryCount: 0 };
  });
  const auto = new AutoSearchProvider({ engines: [make('primary-a', 1), make('primary-b', 0), make('fallback', 5)], primaryEngineCount: 2, maxEngineCalls: 3, minResultsBeforeExpansion: 5, deadlineMs: 1000, limit: 10 });
  const result = await auto.search('query');
  assert.deepEqual(calls, ['primary-a', 'primary-b', 'fallback']);
  assert.deepEqual(result.diagnostics?.map((item) => item.provider), ['primary-a', 'primary-b', 'fallback']);
  assert.deepEqual(result.autoDiagnostics?.batches, [['primary-a', 'primary-b'], ['fallback']]);
});
