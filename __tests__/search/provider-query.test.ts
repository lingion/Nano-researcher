import test from 'node:test';
import assert from 'node:assert/strict';

import { prepareProviderQuery } from '../../src/search/auto/providers/result.js';
import { rankCandidates } from '../../src/search/auto/fusion-ranker.js';

test('provider request preserves the exact agent query including search operators', () => {
  const raw = 'site:example.com "developer preview" -release after:2026-06-01';
  const prepared = prepareProviderQuery(raw);

  assert.equal(prepared.text, raw);
  assert.equal(prepared.query.filters.site, 'example.com');
  assert.equal(prepared.query.filters.after, '2026-06-01');
});

test('site constraint accepts the requested host and its subdomains', () => {
  const ranked = rankCandidates([
    { title: 'Developer preview', snippet: 'official test', url: 'https://www.example.com/preview', provider: 'fake', providerRank: 1 },
    { title: 'Developer preview', snippet: 'mirror', url: 'https://other.test/preview', provider: 'fake', providerRank: 2 },
  ], 'site:example.com developer preview');

  assert.deepEqual(ranked.results.map((item: { url: string }) => item.url), ['https://www.example.com/preview']);
});

test('site constraint preserves an optional path prefix instead of treating it as a hostname', () => {
  const ranked = rankCandidates([
    { title: 'Beta release', snippet: 'developer preview', url: 'https://developer.example.com/news/releases/beta', provider: 'fake', providerRank: 1 },
    { title: 'Other release', snippet: 'developer preview', url: 'https://developer.example.com/blog/beta', provider: 'fake', providerRank: 2 },
  ], 'site:developer.example.com/news/releases beta');

  assert.deepEqual(ranked.results.map((item: { url: string }) => item.url), ['https://developer.example.com/news/releases/beta']);
});
