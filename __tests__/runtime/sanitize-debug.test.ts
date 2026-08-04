import test from 'node:test';
import assert from 'node:assert/strict';

import {
  safeSerializeDebugPayload,
  sanitizeDebugValue,
  summarizeError,
  summarizeFetchedPage,
  summarizeSearchResults,
} from '../../src/runtime/sanitize-debug.js';

test('sanitizeDebugValue removes sensitive recursive fields and unsafe URL parts', () => {
  const value = {
    decision: 'continue_fetch',
    prompt: 'SYNTHETIC_MODEL_PROMPT',
    state: { content: 'SYNTHETIC_PAGE_CONTENT' },
    headers: { authorization: 'SYNTHETIC_HEADER_SECRET' },
    url: 'https://user:pass@example.test/path?token=SYNTHETIC_HEADER_SECRET#fragment',
    nested: {
      message: 'SYNTHETIC_UPSTREAM_MESSAGE',
      stack: 'SYNTHETIC_STACK',
      apiKey: 'SYNTHETIC_API_KEY',
      authorization: 'SYNTHETIC_AUTHORIZATION',
      cookie: 'SYNTHETIC_COOKIE',
      password: 'SYNTHETIC_PASSWORD',
      secret: 'SYNTHETIC_SECRET',
      accessToken: 'SYNTHETIC_ACCESS_TOKEN',
      refreshToken: 'SYNTHETIC_REFRESH_TOKEN',
      query: 'SYNTHETIC_QUERY',
      why: 'SYNTHETIC_WHY',
    },
  };

  const sanitized = sanitizeDebugValue(value) as Record<string, unknown>;
  const serialized = JSON.stringify(sanitized);

  assert.equal(sanitized.decision, 'continue_fetch');
  assert.equal(sanitized.url, 'https://example.test/path');
  assert.doesNotMatch(serialized, /SYNTHETIC_/);
});

test('keeps search and fetch action rationale while sanitizing unrelated query fields', () => {
  const sanitized = sanitizeDebugValue({
    searchActions: [{ query: '中国大陆 2026 AI 内测 官方 申请', why: '寻找官方入口' }],
    fetchActions: [{ url: 'https://example.test/apply?token=SYNTHETIC_TOKEN', why: '核验官方页面' }],
    metadata: { query: 'SYNTHETIC_QUERY', why: 'SYNTHETIC_WHY' },
  }) as Record<string, unknown>;

  assert.deepEqual(sanitized.searchActions, [
    { query: '中国大陆 2026 AI 内测 官方 申请', why: '寻找官方入口' },
  ]);
  assert.deepEqual(sanitized.fetchActions, [
    { url: 'https://example.test/apply', why: '核验官方页面' },
  ]);
  assert.equal((sanitized.metadata as Record<string, unknown>).query, undefined);
  assert.equal((sanitized.metadata as Record<string, unknown>).why, undefined);
});

test('summaries retain safe metadata without upstream content', () => {
  const error = Object.assign(new Error('SYNTHETIC_UPSTREAM_MESSAGE'), {
    code: 'UPSTREAM_TIMEOUT',
    status: 504,
    diagnostics: 'SYNTHETIC_HEADER_SECRET',
  });
  const errorSummary = summarizeError(error);
  const searchSummary = summarizeSearchResults([
    { url: 'https://example.test/search?q=SYNTHETIC_PAGE_CONTENT', title: 'Example result', snippet: 'SYNTHETIC_PAGE_CONTENT' },
  ]);
  const pageSummary = summarizeFetchedPage({
    url: 'https://example.test/page?secret=SYNTHETIC_HEADER_SECRET',
    status: 200,
    title: 'Example page',
    content: 'SYNTHETIC_PAGE_CONTENT',
    headers: { authorization: 'SYNTHETIC_HEADER_SECRET' },
  });

  assert.equal(errorSummary.name, 'Error');
  assert.equal(errorSummary.code, 'UPSTREAM_TIMEOUT');
  assert.equal(errorSummary.status, 504);
  assert.equal('message' in errorSummary, false);
  assert.equal(searchSummary.count, 1);
  assert.equal(pageSummary.status, 200);
  assert.doesNotMatch(JSON.stringify({ errorSummary, searchSummary, pageSummary }), /SYNTHETIC_/);
});

test('safe serializer handles circular and throwing values without throwing', () => {
  const circular: Record<string, unknown> = { safe: true };
  circular.self = circular;
  Object.defineProperty(circular, 'throwing', { enumerable: true, get: () => { throw new Error('SYNTHETIC_UPSTREAM_MESSAGE'); } });

  assert.doesNotThrow(() => safeSerializeDebugPayload(circular));
  assert.doesNotMatch(safeSerializeDebugPayload(circular), /SYNTHETIC_/);
});
