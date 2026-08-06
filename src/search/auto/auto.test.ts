import assert from 'node:assert/strict';
import test from 'node:test';
import { AutoSearchProvider } from './auto.ts';
import type { AutoEngine } from './contracts.ts';
import { SearchResponseEngine } from './engine-runner.ts';
import { normalizeResponse } from './providers/engines.ts';
import { attemptDiagnostic } from './providers/result.js';

function engine(name: string, fn: AutoEngine['run']): AutoEngine {
  return { name, capabilities: ['general-web'], run: fn };
}

test('Auto stops at the engine budget and returns per-engine diagnostics', async () => {
  const calls: string[] = [];
  const auto = new AutoSearchProvider({
    engines: ['one', 'two', 'three'].map((name) => engine(name, async (query) => {
      calls.push(name);
      return { engine: name, outcome: 'success_with_content', results: [{ query, title: name, url: `https://${name}.example/`, snippet: query + ' ' + name, provider: name, rank: 1 }], durationMs: 1, requestCount: 1, retryCount: 0 };
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
  assert.equal(result.outcome, 'cancelled');
});

test('Auto runs one bounded provider batch without result-count early stopping', async () => {
  const calls: string[] = [];
  const make = (name: string, count: number): AutoEngine => engine(name, async (query) => {
    calls.push(name);
    return { engine: name, outcome: count ? 'success_with_content' : 'success_empty', results: Array.from({ length: count }, (_, index) => ({ query, title: `${name}-${index}`, url: `https://${name}.example/${index}`, snippet: query + ' ' + name, provider: name, rank: index + 1 })), durationMs: 1, requestCount: 1, retryCount: 0 };
  });
  const auto = new AutoSearchProvider({ engines: [make('primary-a', 1), make('primary-b', 0), make('fallback', 5)], maxEngineCalls: 3, deadlineMs: 1000, limit: 10 });
  const result = await auto.search('query');
  assert.deepEqual(calls, ['primary-a', 'primary-b', 'fallback']);
  assert.deepEqual(result.diagnostics?.map((item) => item.provider), ['primary-a', 'primary-b', 'fallback']);
  assert.deepEqual(result.autoDiagnostics?.batches, [['primary-a', 'primary-b', 'fallback']]);
  assert.equal(result.autoDiagnostics?.stoppedReason, 'all_engines');
});

test('Auto makes zero provider calls for a pre-aborted request', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new Error('already cancelled'));
  const auto = new AutoSearchProvider({
    engines: [engine('never', async () => {
      calls += 1;
      throw new Error('must not run');
    })],
  });
  const result = await auto.search('query', { signal: controller.signal });
  assert.equal(calls, 0);
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.autoDiagnostics?.stoppedReason, 'cancelled');
});

test('Auto honors an explicit zero engine budget without invoking a provider', async () => {
  let calls = 0;
  const auto = new AutoSearchProvider({
    engines: [engine('never', async () => {
      calls += 1;
      throw new Error('must not run');
    })],
    maxEngineCalls: 0,
  });
  const result = await auto.search('query');
  assert.equal(calls, 0);
  assert.equal(result.outcome, 'success_empty');
  assert.equal(result.autoDiagnostics?.stoppedReason, 'engine_budget');
});

test('Auto returns at its deadline when an engine ignores AbortSignal', async () => {
  const started = Date.now();
  const auto = new AutoSearchProvider({
    engines: [engine('ignores-abort', async () => await new Promise(() => undefined))],
    deadlineMs: 25,
  });
  const result = await auto.search('query');
  assert.ok(Date.now() - started < 250);
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.diagnostics?.[0]?.error?.code, 'AUTO_TIMEOUT');
});

test('Auto returns promptly when a cancelled engine ignores AbortSignal', async () => {
  const controller = new AbortController();
  const auto = new AutoSearchProvider({
    engines: [engine('ignores-cancel', async () => await new Promise(() => undefined))],
    deadlineMs: 1_000,
  });
  const pending = auto.search('query', { signal: controller.signal });
  controller.abort(new Error('cancelled by test'));
  const result = await pending;
  assert.equal(result.outcome, 'cancelled');
});

test('Auto preserves sibling successes when one engine throws', async () => {
  const auto = new AutoSearchProvider({
    engines: [
      engine('broken', async () => { throw new Error('provider exploded'); }),
      engine('healthy', async (query) => ({ engine: 'healthy', outcome: 'success_with_content', results: [{ query, title: 'Healthy', url: 'https://healthy.example', snippet: query + ' ok', provider: 'healthy' }], durationMs: 1, requestCount: 1, retryCount: 0 })),
    ],
    maxEngineCalls: 2,
  });
  const result = await auto.search('query');
  assert.equal(result.results.length, 1);
  assert.equal(result.diagnostics?.find((item) => item.provider === 'broken')?.error?.code, 'ENGINE_FAILED');
  assert.equal(result.diagnostics?.find((item) => item.provider === 'healthy')?.outcome, 'success_with_content');
});

test('Auto preserves provider failure semantics when no engine returns results', async () => {
  const auto = new AutoSearchProvider({
    engines: [
      engine('blocked', async () => ({ engine: 'blocked', outcome: 'http_error', results: [], durationMs: 1, requestCount: 1, retryCount: 0, error: { code: 'PROVIDER_BLOCKED', message: 'captcha' } })),
      engine('parser', async () => ({ engine: 'parser', outcome: 'transport_error', results: [], durationMs: 1, requestCount: 1, retryCount: 0, error: { code: 'PARSER_FAILURE', message: 'invalid markup' } })),
    ],
    maxEngineCalls: 2,
  });
  const result = await auto.search('query');
  assert.equal(result.outcome, 'http_error');
  assert.deepEqual(result.error, { code: 'PROVIDER_BLOCKED', message: 'captcha' });
});

test('provider normalization keeps valid empty results distinct from blocked and failed responses', () => {
  const empty = normalizeResponse({
    records: [],
    durationMs: 47,
    retryCount: 1,
    diagnostics: { status: 200, markupFound: true, requestCount: 2 },
  }, 'query', 'example');
  assert.equal(empty.outcome, 'success_empty');
  assert.equal(empty.durationMs, 47);
  assert.equal(empty.retryCount, 1);
  assert.equal(empty.diagnostics?.[0]?.requestCount, 2);
  assert.equal(empty.error, undefined);

  const blocked = normalizeResponse({
    records: [],
    diagnostics: { status: 200, blocked: true, blockReason: 'captcha_or_verification', requestCount: 1 },
  }, 'query', 'example');
  assert.equal(blocked.outcome, 'http_error');
  assert.equal(blocked.error?.code, 'PROVIDER_BLOCKED');
  assert.equal(blocked.diagnostics?.[0]?.details?.blocked, true);

  const failed = normalizeResponse({
    records: [],
    diagnostics: { error: { code: 'http_status', message: 'HTTP 403' }, status: 403, requestCount: 1 },
  }, 'query', 'example');
  assert.equal(failed.outcome, 'http_error');
  assert.equal(failed.error?.code, 'http_status');

  const parseFailed = normalizeResponse({
    records: [],
    diagnostics: { parseFailures: 1, markupFound: true, requestCount: 1 },
  }, 'query', 'example');
  assert.equal(parseFailed.outcome, 'transport_error');
  assert.equal(parseFailed.error?.code, 'PARSER_FAILURE');

  const invalidRecord = normalizeResponse({ records: [{ title: 'Broken', url: '', snippet: '' }], diagnostics: { status: 200 } }, 'query', 'example');
  assert.equal(invalidRecord.outcome, 'transport_error');
  assert.equal(invalidRecord.error?.code, 'PARSER_FAILURE');
  assert.equal(invalidRecord.diagnostics?.[0]?.resultCount, 0);
});

test('attempt diagnostics preserve HTTP failure semantics', () => {
  const attempt = attemptDiagnostic({ url: 'https://example.com/search', error: { code: 'http_status', status: 403, message: 'HTTP 403' } });
  assert.equal(attempt.outcome, 'http_error');
});

test('provider normalization exposes ranker fields at the result boundary', () => {
  const response = normalizeResponse({
    records: [{ title: 'Video', url: 'https://example.com/video', snippet: 'x', sourceFamily: 'cn-video', resultType: 'video', score: 0.7 }],
    diagnostics: { status: 200 },
  }, 'query', 'example');
  assert.equal(response.results[0]?.sourceFamily, 'cn-video');
  assert.equal(response.results[0]?.resultType, 'video');
  assert.equal(response.results[0]?.metadata?.score, 0.7);
  assert.equal(response.results[0]?.metadata?.sourceFamily, undefined);
});

test('provider normalization preserves URL, freshness, and wrapper provenance for the ranker', () => {
  const response = normalizeResponse({
    records: [{
      title: 'Mobile result',
      url: 'https://wap.sogou.com/link?url=opaque',
      snippet: 'wrapper',
      publishedAt: '2026-08-03T06:40:00.000Z',
      unresolvedWrapper: true,
      displayUrl: 'wap.sogou.com/link?url=opaque',
    }],
    diagnostics: { status: 200 },
  }, 'query', 'sogou');

  assert.equal(response.results[0]?.publishedAt, '2026-08-03T06:40:00.000Z');
  assert.equal(response.results[0]?.unresolvedWrapper, true);
  assert.equal(response.results[0]?.displayUrl, 'wap.sogou.com/link?url=opaque');
});

test('provider normalization preserves explicit source provenance for transparent ranking', () => {
  const response = normalizeResponse({
    records: [{
      title: 'Developer preview announcement',
      url: 'https://example.com/preview',
      snippet: 'The provider declared a source signal for this candidate.',
      authorityScore: 0.8,
      sourceProvenance: {
        authorityScore: 0.8,
        authorityBasis: 'provider_declared',
      },
    }],
  }, 'preview', 'example');

  assert.equal(response.results[0]?.authorityScore, 0.8);
  assert.deepEqual(response.results[0]?.sourceProvenance, {
    authorityScore: 0.8,
    authorityBasis: 'provider_declared',
  });
});

test('provider normalization aggregates retries and requests from nested attempts', () => {
  const response = normalizeResponse({
    records: [],
    diagnostics: {
      status: 503,
      requestCount: 2,
      retryCount: 1,
      attempts: [
        { url: 'https://one.example', retryCount: 1 },
        { url: 'https://two.example', retryCount: 0 },
      ],
    },
  }, 'query', 'example');
  assert.equal(response.retryCount, 1);
  assert.equal(response.diagnostics?.[0]?.requestCount, 3);
});

test('SearchResponseEngine aggregates request and attempt diagnostics', async () => {
  const engine = new SearchResponseEngine('example', ['general-web'], async () => ({
    outcome: 'success_empty',
    results: [],
    provider: 'example',
    durationMs: 5,
    retryCount: 2,
    diagnostics: [
      { provider: 'example', outcome: 'success_empty', durationMs: 2, resultCount: 0, requestCount: 1, details: { url: 'https://one.example' } },
      { provider: 'example', outcome: 'http_error', durationMs: 3, resultCount: 0, requestCount: 2, details: { url: 'https://two.example' }, error: { code: 'http_status', message: 'HTTP 403' } },
    ],
  }));
  const result = await engine.run('query', { signal: new AbortController().signal, deadlineMs: 1000, request: { query: 'query', limit: 10, deadlineMs: 1000 } });
  assert.equal(result.requestCount, 3);
  assert.equal(result.retryCount, 2);
  assert.equal(result.details?.attemptCount, 2);
  assert.deepEqual(result.details?.attempts, [
    { url: 'https://one.example' },
    { url: 'https://two.example' },
  ]);
});

test('SearchResponseEngine counts nested attempts instead of top-level provider diagnostics', async () => {
  const engine = new SearchResponseEngine('nested', ['general-web'], async () => ({
    outcome: 'success_empty', results: [], provider: 'nested', durationMs: 5, retryCount: 1,
    diagnostics: [{ provider: 'nested', outcome: 'success_empty', durationMs: 5, resultCount: 0, requestCount: 3, details: {
      attempts: [{ url: 'https://one.example', retryCount: 1 }, { url: 'https://two.example', retryCount: 0 }],
    } }],
  }));
  const result = await engine.run('query', { signal: new AbortController().signal, deadlineMs: 1000, request: { query: 'query', limit: 10, deadlineMs: 1000 } });
  assert.equal(result.details?.attemptCount, 2);
  assert.equal(result.requestCount, 3);
});

test('Auto exposes source-neutral candidate quality diagnostics without inferring provenance', async () => {
  const auto = new AutoSearchProvider({
    engines: [engine('fixture', async (query) => ({
      engine: 'fixture',
      outcome: 'success_with_content',
      durationMs: 1,
      requestCount: 1,
      retryCount: 0,
      results: [
        {
          query,
          title: 'Preview announcement',
          snippet: 'A preview announcement.',
          url: 'https://example.com/preview',
          provider: 'fixture',
          sourceFamily: 'general-web',
          authorityScore: 0.8,
          sourceProvenance: { authorityScore: 0.8, authorityBasis: 'provider_declared' },
        },
        {
          query,
          title: 'Duplicate preview announcement',
          snippet: 'A duplicate preview announcement.',
          url: 'https://example.com/preview',
          provider: 'fixture',
        },
        {
          query,
          title: 'Unresolved wrapper',
          snippet: 'wrapper only',
          url: 'https://www.sogou.com/link?url=opaque',
          provider: 'fixture',
          unresolvedWrapper: true,
        },
        {
          query,
          title: 'Invalid URL',
          snippet: 'invalid URL',
          url: 'not-a-url',
          provider: 'fixture',
        },
        {
          query,
          title: '',
          snippet: '',
          url: 'https://example.com/empty',
          provider: 'fixture',
        },
        {
          query,
          title: 'Offsite preview',
          snippet: 'preview outside the requested site',
          url: 'https://other.example/preview',
          provider: 'fixture',
        },
        {
          query,
          title: 'Unrelated page',
          snippet: 'nothing relevant here',
          url: 'https://example.com/irrelevant',
          provider: 'fixture',
        },
      ],
    }))],
    limit: 10,
  });

  const result = await auto.search('site:example.com preview');

  assert.deepEqual(result.autoDiagnostics?.candidateQuality, {
    inputCount: 7,
    uniqueResultCount: 1,
    outputResultCount: 1,
    rejectionCounts: {
      invalidUrl: 1,
      unresolvedWrapper: 1,
      missingText: 1,
      queryConstraint: 1,
      lowRelevance: 1,
      duplicateUrl: 1,
    },
    inputExplicitProvenanceCount: 1,
    uniqueExplicitProvenanceCount: 1,
  });
  assert.equal(result.results[0]?.sourceProvenance?.authorityBasis, 'provider_declared');
  assert.equal(result.results[0]?.sourceProvenance?.authorityScore, 0.8);
});
