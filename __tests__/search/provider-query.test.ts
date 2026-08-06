import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeResponse } from '../../src/search/auto/providers/engines.ts';
import { prepareProviderQuery, providerSuccess } from '../../src/search/auto/providers/result.js';
import { parseQuery } from '../../src/search/auto/query/query-parser.js';
import { parseQuarkHtml, parseSogouHtml } from '../../src/search/auto/providers/parsers.js';
import { rankCandidates } from '../../src/search/auto/fusion-ranker.js';

test('provider request preserves the exact agent query including search operators', () => {
  const raw = 'site:example.com "developer preview" -release after:2026-06-01';
  const prepared = prepareProviderQuery(raw);

  assert.equal(prepared.text, raw);
  assert.equal(prepared.query.filters.site, 'example.com');
  assert.equal(prepared.query.filters.after, '2026-06-01');
});

test('provider producer boundary preserves only explicit normalized source provenance', () => {
  const raw = providerSuccess({
    provider: 'fixture',
    sourceFamily: 'general-web',
    resultType: 'web',
    response: { status: 200, url: 'https://search.example/' },
    url: 'https://search.example/?q=preview',
    records: [
      {
        title: 'Explicit provenance',
        url: 'https://example.com/preview',
        snippet: 'Provider-declared source signal.',
        sourceProvenance: { authorityScore: 0.8, authorityBasis: ' provider_declared ' },
      },
      {
        title: 'Malformed provenance',
        url: 'https://example.com/malformed',
        snippet: 'This metadata must not cross the producer boundary.',
        sourceProvenance: { authorityScore: 'not-a-number', authorityBasis: '   ' },
      },
    ],
  });

  assert.deepEqual(raw.records[0]?.sourceProvenance, {
    authorityScore: 0.8,
    authorityBasis: 'provider_declared',
  });
  assert.equal(raw.records[1]?.sourceProvenance, undefined);

  const normalized = normalizeResponse(raw, 'preview', 'fixture');
  assert.deepEqual(normalized.results[0]?.sourceProvenance, {
    authorityScore: 0.8,
    authorityBasis: 'provider_declared',
  });
  assert.equal(normalized.results[1]?.sourceProvenance, undefined);
});

test('treats OR as an alternative group instead of requiring every quoted term', () => {
  const parsed = parseQuery('site:example.com \"邀测\" OR \"内测\" 软件');
  assert.deepEqual(parsed.anyOf, [['邀测', '内测']]);
  const ranked = rankCandidates([
    { title: '邀测软件', snippet: '软件开放邀测', url: 'https://example.com/invite', provider: 'fake', providerRank: 1 },
    { title: '内测软件', snippet: '软件开放内测', url: 'https://example.com/beta', provider: 'fake', providerRank: 2 },
  ], 'site:example.com \"邀测\" OR \"内测\" 软件');
  assert.deepEqual(ranked.results.map((item: { url: string }) => item.url), [
    'https://example.com/invite',
    'https://example.com/beta',
  ]);
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

test('keeps distinct URLs when providers return the same generic title', () => {
  const ranked = rankCandidates([
    { title: 'Developer preview', snippet: 'same generic title', url: 'https://one.example/preview', provider: 'one', providerRank: 1 },
    { title: 'Developer preview', snippet: 'same generic title', url: 'https://two.example/preview', provider: 'two', providerRank: 2 },
  ], 'developer preview');

  assert.deepEqual(ranked.results.map((item: { url: string }) => item.url).sort(), [
    'https://one.example/preview',
    'https://two.example/preview',
  ]);
});

test('uses reciprocal rank fusion when the same URL is returned by multiple providers', () => {
  const ranked = rankCandidates([
    { title: 'Shared result', snippet: 'developer preview', url: 'https://shared.example/preview', provider: 'one', providerRank: 5 },
    { title: 'Shared result', snippet: 'developer preview', url: 'https://shared.example/preview', provider: 'two', providerRank: 5 },
    { title: 'Single result', snippet: 'developer preview', url: 'https://single.example/preview', provider: 'one', providerRank: 1 },
  ], 'developer preview');

  assert.equal(ranked.results[0]?.url, 'https://shared.example/preview');
  assert.equal(ranked.results[0]?.metadata?.fusion?.providerCount, 2);
  assert.ok((ranked.results[0]?.metadata?.fusion?.rrfScore as number) > (ranked.results[1]?.metadata?.fusion?.rrfScore as number));
});

test('keeps a highly relevant single-source result ahead of a weak multi-source result', () => {
  const ranked = rankCandidates([
    { title: 'developer preview', snippet: 'official preview announcement', url: 'https://relevant.example/preview', provider: 'one', providerRank: 1 },
    { title: 'weather report', snippet: 'unrelated forecast', url: 'https://weak.example/report', provider: 'one', providerRank: 5 },
    { title: 'weather report', snippet: 'unrelated forecast', url: 'https://weak.example/report', provider: 'two', providerRank: 5 },
  ], 'developer preview');

  assert.equal(ranked.results[0]?.url, 'https://relevant.example/preview');
});

test('does not let repeated generic terms outrank a specific Chinese test announcement', () => {
  const ranked = rankCandidates([
    {
      title: '2026 AI 年度报告',
      snippet: '2026 中国 AI 中国 AI 中国 AI 中国',
      url: 'https://report.example.com/2026',
      provider: 'bing',
      providerRank: 1,
    },
    {
      title: '内测测试',
      snippet: '2026年6月 AI 产品',
      url: 'https://official.example.com/ai-beta-2026-06',
      provider: 'bing',
      providerRank: 2,
    },
  ], '2026年6月 内测 中国 AI');

  assert.equal(ranked.results[0]?.url, 'https://official.example.com/ai-beta-2026-06');
  assert.ok((ranked.results[0]?.score ?? 0) > (ranked.results[1]?.score ?? 0));
  assert.equal(ranked.results[1]?.scoreBreakdown?.freshness, 0);
});

test('treats spaces inserted between Chinese characters as formatting noise', () => {
  const ranked = rankCandidates([
    {
      title: 'AI 内 测 招募 中',
      snippet: '面向用户的内测邀请',
      url: 'https://official.example.com/ai-beta',
      provider: 'sogou',
      providerRank: 1,
    },
    {
      title: '2026 年度报告',
      snippet: 'AI 中国 2026',
      url: 'https://report.example.com/2026',
      provider: 'sogou',
      providerRank: 2,
    },
  ], 'AI 内测 招募');

  assert.equal(ranked.results[0]?.url, 'https://official.example.com/ai-beta');
  assert.equal(ranked.results[0]?.scoreBreakdown?.phrase, 6);
});

test('does not count an explicitly quoted Chinese phrase twice', () => {
  const ranked = rankCandidates([
    {
      title: '内测公告',
      snippet: '面向用户开放内测。',
      url: 'https://official.example/beta',
      provider: 'fake',
      providerRank: 1,
    },
  ], '"内测"');

  assert.equal(ranked.results[0]?.scoreBreakdown?.phrase, 4);
});

test('does not turn an unrelated result into a hit through fusion alone', () => {
  const ranked = rankCandidates([
    { title: 'Unrelated page', snippet: 'No matching terms', url: 'https://one.example/page', provider: 'one', providerRank: 1 },
    { title: 'Another unrelated page', snippet: 'Still no matching terms', url: 'https://two.example/page', provider: 'two', providerRank: 1 },
  ], 'specific preview');

  assert.equal(ranked.results.length, 0);
  assert.equal(ranked.rejected.relevance, 2);
});

test('uses an explicit Chinese month as a soft temporal relevance signal', () => {
  const ranked = rankCandidates([
    {
      title: '2026 年政府工作报告',
      snippet: '2026年3月5日 AI 中国',
      url: 'https://gov.example/2026',
      provider: 'bing',
      providerRank: 1,
    },
    {
      title: '中国 AI 产品更新',
      snippet: 'AI 2026年6月20日',
      url: 'https://official.example/beta',
      provider: 'bing',
      providerRank: 2,
    },
  ], '2026年6月 中国 AI');

  assert.equal(ranked.results[0]?.url, 'https://official.example/beta');
  assert.ok((ranked.results[0]?.scoreBreakdown?.freshness ?? 0) > 0);
  assert.equal(ranked.results[1]?.url, 'https://gov.example/2026');
  assert.equal(ranked.results[1]?.scoreBreakdown?.freshness, -0.5);
});

test('downranks generic section pages without deleting them by URL shape', () => {
  const ranked = rankCandidates([
    {
      title: 'AI 最新动态',
      snippet: '内测 测试 产品更新',
      url: 'https://news.example.com/tags/ai',
      provider: 'fake',
      providerRank: 1,
    },
    {
      title: 'AI 产品内测招募',
      snippet: '面向开发者开放申请，提供测试资格。',
      url: 'https://news.example.com/p/2026-06-beta',
      provider: 'fake',
      providerRank: 2,
    },
  ], 'AI 内测 测试 产品');

  assert.equal(ranked.results.length, 2);
  assert.equal(ranked.results[0]?.url, 'https://news.example.com/p/2026-06-beta');
  assert.equal(ranked.results[1]?.scoreBreakdown?.pageShapeType, 'tag');
  assert.equal(ranked.results[1]?.scoreBreakdown?.pageShape, -3);
});

test('Quark parser only accepts web hydration categories and source URLs', () => {
  const html = `<script type="application/json" id="s-data-web" data-used-by="hydrate">${JSON.stringify({
    data: { initialData: {
      titleProps: { content: '<em>Official preview</em>' },
      sourceProps: { dest_url: 'https://docs.example.com/preview', time: '1785739200' },
      summaryProps: { content: 'Official preview documentation.' },
    } },
    extraData: { sc: 'ss_doc' },
  })}</script>
  <script type="application/json" id="s-data-video" data-used-by="hydrate">${JSON.stringify({
    data: { initialData: { title: 'Video card', url: 'https://page.sm.cn/blm/video-page', desc: 'Internal video wrapper' } },
    extraData: { sc: 'ss_video' },
  })}</script>`;

  assert.deepEqual(parseQuarkHtml(html, 5), [{
    title: 'Official preview',
    url: 'https://docs.example.com/preview',
    snippet: 'Official preview documentation.',
    publishedAt: '2026-08-03T06:40:00.000Z',
  }]);
});

test('Sogou parser resolves data-url and mobile url wrappers before ranking', () => {
  const html = `
    <div class="vrwrap">
      <h3 class="vr-title"><a href="https://www.sogou.com/link?url=opaque" data-url="https://docs.example.com/preview">Official preview</a></h3>
      <p>Official preview documentation.</p>
    </div>
    <div class="vrResult">
      <h3 class="vr-tit"><a class="resultLink" href="./tc?url=https%3A%2F%2Fnews.example.com%2Fpreview">News preview</a></h3>
      <div class="txt-summary">News preview summary.</div>
    </div>`;

  assert.deepEqual(parseSogouHtml(html, 5), [
    { title: 'Official preview', url: 'https://docs.example.com/preview', snippet: 'Official preview documentation.' },
    { title: 'News preview', url: 'https://news.example.com/preview', snippet: 'News preview summary.' },
  ]);
});

test('Sogou parser marks opaque cite links as unresolved wrappers', () => {
  const html = `
    <div class="vrwrap">
      <h3 class="vr-title"><a href="https://wap.sogou.com/link?url=opaque">Wrapped result</a></h3>
      <p>Wrapped result summary.</p>
    </div>`;

  assert.deepEqual(parseSogouHtml(html, 5), [{
    title: 'Wrapped result',
    url: 'https://wap.sogou.com/link?url=opaque',
    snippet: 'Wrapped result summary.',
    unresolvedWrapper: true,
  }]);
});

test('ranker rejects unresolved mobile search wrappers', () => {
  const ranked = rankCandidates([
    {
      title: 'Unresolved mobile result',
      snippet: 'wrapper only',
      url: 'https://wap.sogou.com/link?url=opaque',
      provider: 'sogou',
      unresolvedWrapper: true,
    },
  ], 'preview');

  assert.equal(ranked.results.length, 0);
  assert.equal(ranked.rejected.wrapper, 1);
});
