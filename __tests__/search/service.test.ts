import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchService } from '../../src/search/service.ts';

test('search service merges duplicate URLs and continues after provider failure', async () => {
  const result = await new SearchService({ providers: [
    { name: 'broken', search: async () => { throw new Error('offline'); } },
    { name: 'one', search: async (query) => ({ outcome: 'success_with_content', provider: 'one', results: [{ query, title: 'A', url: 'https://example.com', snippet: 'a', provider: 'one' }], durationMs: 1, retryCount: 1 }) },
    { name: 'two', search: async (query) => ({ outcome: 'success_with_content', provider: 'two', results: [{ query, title: 'duplicate', url: 'https://example.com', snippet: 'b', provider: 'two' }], durationMs: 1, retryCount: 0 }) },
  ] }).search('a question');

  assert.equal(result.outcome, 'success_with_content');
  assert.equal(result.results.length, 1);
  assert.equal(result.retryCount, 1);
});
