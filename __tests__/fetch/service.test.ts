import test from 'node:test';
import assert from 'node:assert/strict';
import { FetchService } from '../../src/fetch/service.ts';

test('fetch service falls through empty extraction to the next provider', async () => {
  const result = await new FetchService([
    { name: 'static', fetch: async (url) => ({ outcome: 'success_empty', requestedUrl: url, finalUrl: url, title: '', content: '', provider: 'static', extractionWarnings: ['empty'], durationMs: 1, retryCount: 0 }) },
    { name: 'browser', fetch: async (url) => ({ outcome: 'success_with_content', requestedUrl: url, finalUrl: url, title: 'Page', content: 'body', provider: 'browser', extractionWarnings: [], durationMs: 2, retryCount: 0 }) },
  ]).fetch('https://example.com');

  assert.equal(result.provider, 'browser');
  assert.equal(result.content, 'body');
});
