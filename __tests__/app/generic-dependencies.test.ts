import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenericLlmProvider, createGenericFetchProvider, classifyGenericFetchPage } from '../../src/app/create-generic-dependencies.ts';

test('generic LLM composition requires explicit gateway credentials', () => {
  assert.throws(() => createGenericLlmProvider({}), /NANOCLAW_BASE_URL and NANOCLAW_API_KEY/);
});

test('generic LLM composition rejects free-text decision modes and invalid transport numbers', () => {
  const base = { NANOCLAW_BASE_URL: 'https://example.com/v1', NANOCLAW_API_KEY: 'test' };
  assert.throws(() => createGenericLlmProvider({ ...base, NANOCLAW_RESPONSE_FORMAT: 'json_schema' }), /requires NANOCLAW_RESPONSE_FORMAT=tool_call/);
  assert.throws(() => createGenericLlmProvider({ ...base, LIVE_AUDIT_MODEL_TIMEOUT_MS: 'NaN' }), /LIVE_AUDIT_MODEL_TIMEOUT_MS/);
  assert.throws(() => createGenericLlmProvider({ ...base, NANOCLAW_LLM_MAX_ATTEMPTS: '6' }), /NANOCLAW_LLM_MAX_ATTEMPTS/);
  assert.throws(() => createGenericLlmProvider({ ...base, NANOCLAW_LLM_RETRY_DELAY_MS: '-1' }), /NANOCLAW_LLM_RETRY_DELAY_MS/);
});

test('generic fetch composition exposes a domain-neutral provider name', () => {
  const provider = createGenericFetchProvider();
  assert.equal(provider.name, 'local-fetch-primary');
  assert.equal(typeof provider.close, 'function');
});

test('generic fetch composition preserves cancellation instead of reporting a transport failure', async () => {
  const provider = createGenericFetchProvider();
  const controller = new AbortController();
  controller.abort(new Error('cancelled by caller'));
  try {
    await assert.rejects(() => provider.fetch('https://example.com', { signal: controller.signal }), /cancelled by caller/);
  } finally {
    await provider.close?.();
  }
});

test('generic fetch classifies HTTP failures before considering returned page text', () => {
  const result = classifyGenericFetchPage({
    statusCode: 404,
    title: 'Not found',
    content: 'This response contains enough text to look readable, but the server returned a missing page.',
  });

  assert.deepEqual(result, {
    outcome: 'http_error',
    error: { code: 'HTTP_STATUS', message: 'Fetch returned HTTP 404' },
  });
});

test('generic fetch keeps a 200 challenge or weak extraction as an empty result', () => {
  const result = classifyGenericFetchPage({
    statusCode: 200,
    title: 'Loading',
    content: 'enable javascript',
  });

  assert.deepEqual(result, { outcome: 'success_empty' });
});
