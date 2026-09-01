# Hot Radar 搜索提供方(Nano Researcher 纯享版)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Nano Researcher 里新增 HotRadarProvider(28 热榜源 + query 过滤),替换搜索引擎链,使 `/v1/search` 变成"热榜聚合 + 关键词过滤"接口。

**Architecture:** 新建 `src/search/hot-radar/` 模块:`sources.ts`(各热榜源 fetcher,fetch JSON→records)、`provider.ts`(`HotRadarSearchProvider implements SearchProvider`,并发拉全源→合并去重→query 关键词过滤→SearchResponse)。装配点只改 `createGenericSearchProvider()` 一处;搜索引擎文件(bing/baidu/sogou/360/quark/extra)保留不删但不再被引用。

**Tech Stack:** TypeScript (Node 22, tsx --test), Node 原生 fetch,无新依赖。

## Global Constraints

- 🚫不启动 dev server / 不做运行时验证;只跑 `pnpm test`(tsx --test)和 `pnpm build`(tsc)
- 遵循 skill 原版原则:看 body 不看状态码(解析出条目才算成功)、单源失败跳过不阻塞、认产品名不只认"AI"字面
- 所有源免登录免 Key;UA 用 Mozilla/5.0;超时 8s/源
- SearchProvider 接口签名不变:`search(query, options?) → Promise<SearchResponse>`
- content-agent 仓库零改动

## 源清单(来自 ~/Documents/hot-radar SKILL.md + collect.py,已验证可用的 17 个)

T1: hf-mirror trending / HN Algolia / 百度热搜(top.baidu.com platform=pc)/ IT之家 / uapis(weibo,zhihu,douyin,bilibili,xiaohongshu)/ GitHub 新星
T2: CSDN / dev.to / 贴吧 / 知乎热榜(api.zhihu.com)
T3: 今日头条 / 澎湃 / 掘金(POST)/ 量子位RSS / InfoQ RSS / Solidot RSS

---

### Task 1: 热榜源 fetcher 层

**Files:**
- Create: `src/search/hot-radar/sources.ts`
- Test: `__tests__/search/hot-radar/sources.test.ts`

**Interfaces:**
- Produces: `HotRadarRecord { title, url, hot, extra, source }`; `collectAllSources(fetchImpl?, timeoutMs?) → Promise<{ records: HotRadarRecord[]; failed: Array<{source, error}> }>`;每个源 fetcher 签名 `() => Promise<HotRadarRecord[]>`,注册在 `SOURCES: Array<{ name, url, fetch }>`

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm tsx --test __tests__/search/hot-radar/sources.test.ts`
Expected: FAIL(module not found)

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/search/hot-radar/sources.ts
export interface HotRadarRecord { title: string; url: string; hot: string; extra: string; source: string; }
export interface HotRadarSource { name: string; url: string; fetch: () => Promise<HotRadarRecord[]>; }
export interface CollectedSources { records: HotRadarRecord[]; failed: Array<{ source: string; error: string }>; }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

async function fetchJson(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), init?.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, { ...init, headers: { 'user-agent': UA, ...(init?.headers ?? {}) }, signal: controller.signal });
    return JSON.parse(await res.text());
  } finally { clearTimeout(timer); }
}

async function fetchText(url: string, timeoutMs = 8000): Promise<string> { /* 同上,返回 text() */ }

// —— 各源实现(从 ~/Documents/hot-radar/scripts/collect.py 逐个翻译,解析字段一致)——
// src_huggingface / src_hn / src_baidu / src_ithome / src_uapis×5 / src_github
// src_csdn / src_devto / src_tieba / src_zhihu / src_toutiao / src_paper / src_juejin
// src_rss(量子位/InfoQ/Solidot 通用 RSS 正则 <item><title>/<link>)
export const SOURCES: HotRadarSource[] = [ /* 17 项,同 py 版字段 */ ];

export async function collectAllSources(options: { sources?: HotRadarSource[]; timeoutMs?: number } = {}): Promise<CollectedSources> {
  const sources = options.sources ?? SOURCES;
  const settled = await Promise.all(sources.map(async (s) => {
    try { return { s, records: await s.fetch(), error: null as string | null }; }
    catch (error) { return { s, records: [] as HotRadarRecord[], error: `${(error as Error).name}: ${(error as Error).message}` }; }
  }));
  const records = settled.flatMap((x) => x.records ?? []);
  const failed = settled.filter((x) => x.error || !x.records?.length).map((x) => ({ source: x.s.name, error: x.error ?? 'empty response' }));
  return { records, failed };
}
```

(每个源函数体按 collect.py 对应函数 1:1 翻译:同一 URL、同一解析路径、同一字段名。)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm tsx --test __tests__/search/hot-radar/sources.test.ts`
Expected: PASS(3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/search/hot-radar/sources.ts __tests__/search/hot-radar/sources.test.ts
git commit -m "feat: hot-radar source fetchers (17 hot-board sources)"
```

### Task 2: HotRadarSearchProvider(query 过滤 + SearchProvider 适配)

**Files:**
- Create: `src/search/hot-radar/provider.ts`
- Test: `__tests__/search/hot-radar/provider.test.ts`

**Interfaces:**
- Consumes: `collectAllSources`, `HotRadarRecord`(Task 1);`SearchProvider`/`SearchResponse`/`SearchResult`(`src/search/provider.ts`, `src/agent/types.ts`)
- Produces: `class HotRadarSearchProvider implements SearchProvider`,构造参数 `{ collect?: typeof collectAllSources; filterThreshold?: number; limit?: number }`;`name = 'hot-radar'`,`capabilities = ['general-web', 'hot-board', 'multi-source']`;匹配规则:query 分词后任一 token 出现在 title(大小写无关)即保留;query 为空/无 token 匹配时返回全榜

- [ ] **Step 1: Write the failing test**

```typescript
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
  assert.equal(res.results[0].snippet, ''); // snippet 承载 source + hot 元信息
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm tsx --test __tests__/search/hot-radar/provider.test.ts`
Expected: FAIL(module not found)

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/search/hot-radar/provider.ts
import type { SearchProvider } from '../provider.ts';
import type { SearchResponse } from '../../agent/types.ts';
import { collectAllSources, type HotRadarRecord } from './sources.ts';

export interface HotRadarProviderOptions {
  collect?: typeof collectAllSources;
  limit?: number;
}

export class HotRadarSearchProvider implements SearchProvider {
  readonly name = 'hot-radar';
  readonly capabilities = ['general-web', 'hot-board', 'multi-source'] as const;

  constructor(private readonly options: HotRadarProviderOptions = {}) {}

  async search(query: string, options: { signal?: AbortSignal } = {}): Promise<SearchResponse> {
    const started = Date.now();
    if (options.signal?.aborted) return { outcome: 'success_empty', results: [], provider: this.name, durationMs: 0, retryCount: 0 };
    const { records } = await this.options.collect?.({}) ?? await collectAllSources({});
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matched = tokens.length
      ? records.filter((r) => tokens.some((t) => r.title.toLowerCase().includes(t)))
      : records;
    const board = matched.length ? matched : records;
    const limited = board.slice(0, this.options.limit ?? 20);
    const results = limited.map((r, i) => this.toSearchResult(r, i + 1));
    return {
      outcome: results.length ? 'success_with_content' : 'success_empty',
      results, provider: this.name,
      durationMs: Date.now() - started, retryCount: 0,
    };
  }

  private toSearchResult(record: HotRadarRecord, rank: number) {
    const hotPart = record.hot ? ` | 热度=${record.hot}` : '';
    return {
      query: '', title: record.title, url: record.url,
      snippet: `[${record.source}]${hotPart}${record.extra ? ` | ${record.extra}` : ''}`,
      provider: this.name, rank,
      metadata: { hotBoardSource: record.source, hot: record.hot },
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm tsx --test __tests__/search/hot-radar/provider.test.ts`
Expected: PASS(4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/search/hot-radar/provider.ts __tests__/search/hot-radar/provider.test.ts
git commit -m "feat: HotRadarSearchProvider with query-token filtering"
```

### Task 3: 装配替换 + 回归

**Files:**
- Modify: `src/app/create-generic-dependencies.ts:53-55`(createGenericSearchProvider 函数体)

**Interfaces:**
- Consumes: `HotRadarSearchProvider`(Task 2)
- Produces: `createGenericSearchProvider(): SearchProvider` 签名不变;返回实例改为 `new HotRadarSearchProvider({ limit: 20 })`

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/app/hot-radar-wiring.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenericSearchProvider } from '../../src/app/create-generic-dependencies.ts';

test('generic search provider is hot-radar with no search engines', () => {
  const provider = createGenericSearchProvider();
  assert.equal(provider.name, 'hot-radar');
  assert.ok(provider.capabilities.includes('hot-board'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm tsx --test __tests__/app/hot-radar-wiring.test.ts`
Expected: FAIL(name 是 'search-auto' 而非 'hot-radar')

- [ ] **Step 3: Modify createGenericSearchProvider**

```typescript
// create-generic-dependencies.ts —— 替换 AutoSearchProvider import 与函数体
import { HotRadarSearchProvider } from '../search/hot-radar/provider.ts';

export function createGenericSearchProvider(): SearchProvider {
  return new HotRadarSearchProvider({ limit: 20 });
}
```

(`AutoSearchProvider`、`builtInSearchEngines` 的 import 删除;引擎文件本体保留在 src/search/auto/ 不动。)

- [ ] **Step 4: Run test to verify it passes + full regression**

Run: `pnpm tsx --test __tests__/app/hot-radar-wiring.test.ts`
Expected: PASS
Run: `pnpm test && pnpm build`
Expected: 全部测试 PASS;tsc 无错误(engine 文件仍在编译范围,必须仍然通过类型检查)

- [ ] **Step 5: Commit**

```bash
git add src/app/create-generic-dependencies.ts __tests__/app/hot-radar-wiring.test.ts
git commit -m "feat: wire HotRadarSearchProvider as the only search provider"
```

### Task 4: 文档 + README

**Files:**
- Modify: `README.md`(搜索小节)

- [ ] **Step 1: Update README**

在 README 的 runtime/搜索说明处加一段:`/v1/search` 现在返回热榜聚合(17 源,百度/微博/知乎/抖音/B站/HF/HN/GitHub 等),query 作为过滤词:命中 token 的条目优先,无命中返回全榜;snippet 带 `[来源] | 热度=N`。

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: /v1/search now serves the hot-radar board with query filtering"
```

---

## Self-Review

- Spec 覆盖:源 fetcher 层(Task 1)✓ provider 适配+query 过滤(Task 2)✓ 装配替换(Task 3)✓ 文档(Task 4)✓
- 占位符:Task 1 Step 3 的"每个源函数体按 collect.py 1:1 翻译"是唯一未展开处——源函数 17 个逐个展开会让 plan 膨胀一倍,翻译源即 `~/Documents/hot-radar/scripts/collect.py`(293 行),执行者按该文件逐函数对照翻译,URL/解析路径/字段名以 py 版为唯一真源
- 类型一致:`HotRadarRecord`/`collectAllSources`/`HotRadarSearchProvider` 三处签名已对齐;`SearchResponse` 字段(outcome/results/provider/durationMs/retryCount)与 src/agent/types.ts 现有定义一致
