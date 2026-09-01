// __tests__/search/hot-radar/provider.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { HotRadarSearchProvider } from '../../../src/search/hot-radar/provider.ts';

const records = [
  { title: 'AI 芯片新突破', url: 'https://x/1', hot: '999', extra: '', source: '百度热搜' },
  { title: '某明星官宣', url: 'https://x/2', hot: '800', extra: '', source: 'uapis-微博' },
  { title: 'OpenAI 发布新模型', url: 'https://x/3', hot: '500', extra: '', source: 'HackerNews' },
];

test('filters hot-board records by query tokens (AI matches 2 records)', async () => {
  const provider = new HotRadarSearchProvider({ collect: async () => ({ records, failed: [] }) });
  const res = await provider.search('AI 大模型');
  assert.equal(res.outcome, 'success_with_content');
  assert.equal(res.results.length, 2);
  assert.ok(res.results.every((r) => /AI|OpenAI|模型/.test(r.title)));
});

test('returns full board when query matches nothing', async () => {
  const provider = new HotRadarSearchProvider({ collect: async () => ({ records, failed: [] }) });
  const res = await provider.search('完全无关词');
  assert.equal(res.results.length, 3);
});

test('returns success_empty when no sources survive', async () => {
  const provider = new HotRadarSearchProvider({ collect: async () => ({ records: [], failed: [{ source: 'a', error: 'x' }] }) });
  const res = await provider.search('AI');
  assert.equal(res.outcome, 'success_empty');
  assert.deepEqual(res.results, []);
});

test('maps records to SearchResult with provider=hot-radar and rank', async () => {
  const provider = new HotRadarSearchProvider({ collect: async () => ({ records, failed: [] }) });
  const res = await provider.search('');
  assert.equal(res.provider, 'hot-radar');
  assert.equal(res.results[0].title, 'AI 芯片新突破');
  assert.equal(res.results[0].provider, 'hot-radar');
  assert.ok(res.results.every((r, i) => r.rank === i + 1));
  assert.equal(res.results[0].snippet, '[百度热搜] | 热度=999'); // snippet 承载 source + hot 元信息
});
