// __tests__/search/hot-radar/sources.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAllSources, SOURCES } from '../../../src/search/hot-radar/sources.ts';

const ok = (body: unknown) => async () => body;
const bad = () => async () => { throw new Error('offline'); };

test('collectAllSources merges records from all successful sources and reports failures', async () => {
  const fake = [
    { name: 'a', url: 'https://a.example', fetch: ok([{ title: 'T1', url: 'https://a.example/1', hot: '100', extra: '', source: 'a' }]) },
    { name: 'b', url: 'https://b.example', fetch: bad() },
    { name: 'c', url: 'https://c.example', fetch: ok([{ title: 'T2', url: 'https://c.example/2', hot: '', extra: 'x', source: 'c' }]) },
  ];
  const result = await collectAllSources({ sources: fake, timeoutMs: 1000 });
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.failed, [{ source: 'b', error: 'Error: offline' }]);
});

test('SOURCES has at least 15 registered hot-board sources', () => {
  assert.ok(SOURCES.length >= 15, `expected >=15 sources, got ${SOURCES.length}`);
});

test('collectAllSources returns empty records without throwing when every source fails', async () => {
  const result = await collectAllSources({ sources: [{ name: 'z', url: 'https://z.example', fetch: bad() }], timeoutMs: 500 });
  assert.deepEqual(result.records, []);
  assert.equal(result.failed.length, 1);
});
