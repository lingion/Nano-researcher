# 国内 AI 内测热点雷达升级实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将中国大陆 AI 信息采集器升级为能抓取公开 JS 页面、识别 2026-04-01 起灰度/小范围/邀请制热点，并在不足 20 条时明确报告短缺的雷达。

**Architecture:** 保留现有 `SearchTool`/`FetchTool` 接口，在 fetch fusion 内增加可选的浏览器回退 provider；先静态抓取，再 SPA 提取，最后使用 Playwright 渲染公开页面。把日期和访问信号作为证据字段，由独立的 recency/hotspot 模块过滤和排序，最终由报告构建器输出逐条结果；运行时在 `finalize` 前强制校验目标数量和时间窗。

**Tech Stack:** TypeScript strict mode、Node test、tsx、pnpm、现有 Search MCP、可选 Playwright（只抓公开页面，不绕过登录/验证码/访问控制）。

---

## 文件地图

- `src/fetch-fusion/types.ts`：扩展抓取记录的日期、渲染模式、访问信号和时效字段。
- `src/fetch-fusion/browser-fetch.ts`：新增可选 Playwright provider，负责页面加载、正文提取、日期/信号提取和资源限制。
- `src/fetch-fusion/local-fetch-primary.ts`：保留静态路径，并在明确的 JS/正文不足条件下调用浏览器 provider。
- `src/runtime/search-mcp-tool-adapter.ts`：把浏览器 provider 配置和失败原因接入现有 FetchTool。
- `src/search-fusion/early-access-signals.ts`：新增灰度/邀请/候补/内测信号识别与热点评分。
- `src/search-fusion/recency-window.ts`：新增日期解析、窗口过滤和日期不明降级逻辑。
- `src/policy-task/prompt-builder.ts`：改成早期访问热点优先，并修正终态 `final_package` 契约。
- `src/app/run-policy-task.ts`：在 finalize/stop 前强制执行有效条目数量和窗口校验。
- `src/artifacts/write-early-access-report.ts`：新增逐条热点报告输出和 shortfall 元数据。
- `__tests__/fetch-fusion/browser-fetch.test.ts`：浏览器回退和公开页面提取测试。
- `__tests__/search-fusion/early-access-signals.test.ts`：访问信号和评分测试。
- `__tests__/search-fusion/recency-window.test.ts`：日期窗口测试。
- `__tests__/app/policy-loop-behavior.test.ts`：finalize 数量硬门槛和终态契约测试。
- `__tests__/artifacts/write-early-access-report.test.ts`：逐条报告、短缺和排除项测试。

---

### Task 1: 扩展抓取证据模型

**Files:**
- Modify: `src/fetch-fusion/types.ts`
- Modify: `src/policy-task/state-schema.ts`
- Test: `__tests__/fetch-fusion/types.test.ts`

- [ ] **Step 1: 写失败测试**

增加测试，构造一个有发布日期、访问信号和浏览器渲染模式的页面，断言类型边界能接受这些字段，并保留既有页面字段。

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FetchedPageRecord } from '../../src/fetch-fusion/types.ts';

test('fetched page records carry freshness and early-access evidence', () => {
  const page: FetchedPageRecord = {
    requestedUrl: 'https://example.cn/beta',
    finalUrl: 'https://example.cn/beta',
    title: '限量灰度招募',
    content: '加入候补名单，限量邀请体验',
    backend: 'playwright',
    publishedAt: '2026-07-20',
    updatedAt: '2026-07-21',
    lastVerifiedAt: '2026-07-24T00:00:00.000Z',
    pageRenderMode: 'playwright',
    accessSignals: ['gray_release', 'waitlist', 'invite_only'],
    freshnessStatus: 'in_window',
    dateEvidence: ['正文发布日期：2026-07-20'],
    extractionWarnings: [],
  };
  assert.equal(page.freshnessStatus, 'in_window');
  assert.deepEqual(page.accessSignals, ['gray_release', 'waitlist', 'invite_only']);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec tsx --test __tests__/fetch-fusion/types.test.ts`
Expected: FAIL because the new fields are absent from `FetchedPageRecord`.

- [ ] **Step 3: 实现最小类型扩展**

在 `src/fetch-fusion/types.ts` 定义：

```ts
export type PageRenderMode = 'static' | 'spa_extraction' | 'playwright';
export type FreshnessStatus = 'in_window' | 'out_of_window' | 'date_unknown';
export type AccessSignal =
  | 'gray_release' | 'small_batch' | 'invite_only' | 'waitlist'
  | 'application_open' | 'developer_preview' | 'limited_rollout'
  | 'closed' | 'public_release';
```

将以下可选字段加入页面记录：`publishedAt`、`updatedAt`、`lastVerifiedAt`、`pageRenderMode`、`accessSignals`、`freshnessStatus`、`dateEvidence`、`extractionWarnings`。同时给状态 schema 的 fetched evidence 复用同一字段。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec tsx --test __tests__/fetch-fusion/types.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/fetch-fusion/types.ts src/policy-task/state-schema.ts __tests__/fetch-fusion/types.test.ts
git commit -m "feat: add freshness and early-access evidence fields"
```

### Task 2: 增加公开 JS/Playwright 抓取回退

**Files:**
- Create: `src/fetch-fusion/browser-fetch.ts`
- Modify: `src/fetch-fusion/local-fetch-primary.ts`
- Modify: `src/runtime/search-mcp-tool-adapter.ts`
- Test: `__tests__/fetch-fusion/browser-fetch.test.ts`

- [ ] **Step 1: 写失败测试**

用注入的 browser adapter 替代真实浏览器，验证 SPA 静态正文不足时会提取 `renderedText`、日期和访问信号，并在 browser 失败时返回包含 warning 的静态记录而不是抛出未处理异常。

```ts
test('browser fetch extracts rendered beta page metadata', async () => {
  const result = await fetchWithBrowserFallback('https://example.cn/beta', {
    staticFetch: async () => ({ title: 'App', content: 'enable javascript' }),
    browser: { render: async () => ({ title: '灰度招募', text: '2026-07-20 限量邀请体验，加入候补名单', finalUrl: 'https://example.cn/beta' }) },
    now: '2026-07-24T00:00:00.000Z',
  });
  assert.equal(result.pageRenderMode, 'playwright');
  assert.equal(result.publishedAt, '2026-07-20');
  assert.deepEqual(result.accessSignals, ['gray_release', 'waitlist', 'invite_only']);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec tsx --test __tests__/fetch-fusion/browser-fetch.test.ts`
Expected: FAIL because `fetchWithBrowserFallback` does not exist。

- [ ] **Step 3: 实现 provider 和回退条件**

在 `browser-fetch.ts` 实现：

```ts
export interface BrowserRenderResult { finalUrl?: string; title?: string; text: string; html?: string; }
export interface BrowserAdapter { render(url: string, options: { timeoutMs: number; maxChars: number }): Promise<BrowserRenderResult>; }
export interface BrowserFetchOptions { staticFetch(url: string): Promise<{ title?: string; content?: string; finalUrl?: string }>; browser?: BrowserAdapter; now: string; maxChars?: number; }
export async function fetchWithBrowserFallback(url: string, options: BrowserFetchOptions): Promise<FetchedPageRecord>;
```

静态正文包含 JS 占位、长度低于 400 或无可读正文时才启用浏览器。真实 adapter 使用 Playwright 的 `chromium.launch()`、单页 `goto(..., { waitUntil: 'domcontentloaded', timeout })`、`page.locator('body').innerText()`，默认 20 秒超时、单页 20000 字符、关闭图片/字体/媒体资源。禁止注入账号、绕过验证码或访问控制。依赖未安装或浏览器失败时保留静态结果并记录 `extractionWarnings`。

在 `local-fetch-primary.ts` 把当前抓取结果先传给 `fetchWithBrowserFallback`；在 `search-mcp-tool-adapter.ts` 增加 `enableBrowserFallback`、`browserTimeoutMs` 配置，默认关闭以保持兼容，内测热点运行命令显式打开。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec tsx --test __tests__/fetch-fusion/browser-fetch.test.ts __tests__/runtime/search-mcp-tool-adapter.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/fetch-fusion/browser-fetch.ts src/fetch-fusion/local-fetch-primary.ts src/runtime/search-mcp-tool-adapter.ts __tests__/fetch-fusion/browser-fetch.test.ts
git commit -m "feat: add public SPA and Playwright fetch fallback"
```

### Task 3: 实现时效窗口和早期访问信号评分

**Files:**
- Create: `src/search-fusion/recency-window.ts`
- Create: `src/search-fusion/early-access-signals.ts`
- Modify: `src/search-fusion/types.ts`
- Test: `__tests__/search-fusion/recency-window.test.ts`
- Test: `__tests__/search-fusion/early-access-signals.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
test('recency window excludes dates before April 1', () => {
  assert.equal(classifyFreshness('2026-03-31', { from: '2026-04-01', to: '2026-07-24' }), 'out_of_window');
  assert.equal(classifyFreshness('2026-07-23', { from: '2026-04-01', to: '2026-07-24' }), 'in_window');
  assert.equal(classifyFreshness(undefined, { from: '2026-04-01', to: '2026-07-24' }), 'date_unknown');
});

test('early access scoring outranks ordinary release', () => {
  const hot = scoreEarlyAccess({ text: '限量灰度测试，邀请制，加入候补名单', freshnessStatus: 'in_window' });
  const release = scoreEarlyAccess({ text: '新品正式发布，面向所有用户', freshnessStatus: 'in_window' });
  assert.ok(hot.score > release.score);
  assert.deepEqual(hot.signals, ['gray_release', 'invite_only', 'waitlist']);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec tsx --test __tests__/search-fusion/recency-window.test.ts __tests__/search-fusion/early-access-signals.test.ts`
Expected: FAIL because both modules are absent。

- [ ] **Step 3: 实现日期和信号模块**

`recency-window.ts` 导出 `DateWindow`、`classifyFreshness(date, window)`、`extractDateEvidence(text)`、`latestEvidenceDate(page)`。支持 ISO、`YYYY-MM-DD`、`YYYY年M月D日`，不能解析时返回 `date_unknown`；不允许用抓取时间伪造发布日期。

`early-access-signals.ts` 导出 `scoreEarlyAccess(input)`，使用中文/英文正则识别 `灰度/小范围/限量/邀请码/邀请制/候补/内测/公测/开发者预览/分批开放` 等词，输出去重信号、分数和 `hotspotTier`（A/B/C）。普通“发布/上线/新品”仅给背景分，不能单独达到有效热点分数。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec tsx --test __tests__/search-fusion/recency-window.test.ts __tests__/search-fusion/early-access-signals.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/search-fusion/recency-window.ts src/search-fusion/early-access-signals.ts src/search-fusion/types.ts __tests__/search-fusion/recency-window.test.ts __tests__/search-fusion/early-access-signals.test.ts
git commit -m "feat: score dated domestic early-access signals"
```

### Task 4: 将搜索 Prompt 改为热点优先并修正最终包字段

**Files:**
- Modify: `src/policy-task/prompt-builder.ts`
- Modify: `src/runtime/ask-real-claude.ts`
- Test: `__tests__/policy-task/prompt-builder.test.ts`
- Test: `__tests__/runtime/ask-real-claude.test.ts`

- [ ] **Step 1: 写失败测试**

断言 prompt 要求灰度/邀请优先、普通发布不能单独入选、时间窗口硬限制，并断言 snake_case `final_package` 会规范化到 runtime 的 `finalPackage`。

```ts
test('prompt prioritizes small-batch early access', () => {
  const prompt = buildPolicyPrompt({ dateWindow: { from: '2026-04-01', to: '2026-07-24' }, targetCount: 20 });
  assert.match(prompt, /灰度|小范围|邀请码|候补/);
  assert.match(prompt, /2026-04-01/);
  assert.match(prompt, /普通.*发布.*不得/);
});

test('normalizer maps final_package for terminal decisions', () => {
  const decision = normalizeModelDecision({ decision: 'summarize_and_stop', final_package: { items: [] } });
  assert.deepEqual(decision.finalPackage, { items: [] });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec tsx --test __tests__/policy-task/prompt-builder.test.ts __tests__/runtime/ask-real-claude.test.ts`
Expected: FAIL on missing options/normalization。

- [ ] **Step 3: 实现 Prompt 与字段规范化**

让 `buildPolicyPrompt` 接收可选 `{ dateWindow, targetCount }`，加入：只有日期在窗口内、且存在灰度/小批量/邀请/候补/内测/开发者预览信号的条目才计入目标；普通发布和只有首页的内容不得计入；每条必须输出 `hotspotTier`、`freshnessStatus`、`last_verified_at` 和证据 URL。将终态约束改为：`continue_search`/`continue_fetch` 的 `final_package` 为 null，`finalize`/`stop`/`summarize_and_stop` 必须输出完整 package。

在 `ask-real-claude.ts` 的两个 normalize 分支统一读取：

```ts
const finalPackage = payload.finalPackage ?? payload.final_package;
```

并避免把整个 payload 作为嵌套 package；只有两个字段都缺失时才使用兼容回退。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec tsx --test __tests__/policy-task/prompt-builder.test.ts __tests__/runtime/ask-real-claude.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/policy-task/prompt-builder.ts src/runtime/ask-real-claude.ts __tests__/policy-task/prompt-builder.test.ts __tests__/runtime/ask-real-claude.test.ts
git commit -m "feat: prioritize dated early-access hotspots"
```

### Task 5: 加入 20 条硬门槛和逐条报告

**Files:**
- Create: `src/artifacts/write-early-access-report.ts`
- Modify: `src/app/run-policy-task.ts`
- Modify: `src/app/run-live-audit.ts`
- Test: `__tests__/app/policy-loop-behavior.test.ts`
- Test: `__tests__/artifacts/write-early-access-report.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
test('finalize is rejected when valid hotspot count is below target', async () => {
  const result = await runPolicyTaskLoop(input, { maxIterations: 2, targetValidatedEvidenceCount: 20, askAgent: async () => finalizeWithFiveItems() });
  assert.equal(result.final_quality_status, 'insufficient_target_count');
  assert.equal(result.shortfall, 15);
});

test('report preserves per-item hotspot fields and shortfall', async () => {
  const report = writeEarlyAccessReport({ target: 20, items: [{ name: 'Kimi K3', hotspotTier: 'A', freshnessStatus: 'in_window' }] });
  assert.equal(report.validCount, 1);
  assert.equal(report.shortfall, 19);
  assert.match(report.markdown, /Kimi K3/);
  assert.match(report.markdown, /shortfall|缺口/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec tsx --test __tests__/app/policy-loop-behavior.test.ts __tests__/artifacts/write-early-access-report.test.ts`
Expected: FAIL because count validation and report writer are absent。

- [ ] **Step 3: 实现硬门槛和报告 writer**

在 `run-policy-task.ts` 计算独立条目：必须有窗口内日期、非 `NOISE` 证据、至少一个早期访问信号；普通产品发布不计数。若模型返回 `finalize`/`stop`/`summarize_and_stop` 但 `validCount < targetCount`，保留已收集证据并返回 `final_quality_status: 'insufficient_target_count'`、`targetCount`、`validCount`、`shortfall`，不得宣称完成；若仍有可执行搜索/抓取且未超过硬上限，继续循环。

`write-early-access-report.ts` 输出结构化 JSON 和 Markdown，每条一行/一节，字段包括排名、产品/功能、测试类型、发布日期/更新时间、最近验证时间、状态、申请入口、邀请码/候补要求、地区、官方证据、热点理由和风险；同时输出 `validCount`、`targetCount`、`shortfall`、`excludedCount`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec tsx --test __tests__/app/policy-loop-behavior.test.ts __tests__/artifacts/write-early-access-report.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/app/run-policy-task.ts src/app/run-live-audit.ts src/artifacts/write-early-access-report.ts __tests__/app/policy-loop-behavior.test.ts __tests__/artifacts/write-early-access-report.test.ts
git commit -m "feat: enforce hotspot target and write itemized report"
```

### Task 6: 集成配置、运行验证和回归检查

**Files:**
- Modify: `src/app/live-audit-runtime.ts`
- Modify: `README.zh.md`
- Modify: `README.md`
- Test: `__tests__/app/live-audit-runtime.test.ts`

- [ ] **Step 1: 写失败测试**

断言环境变量能配置 `LIVE_AUDIT_FROM`、`LIVE_AUDIT_TO`、`LIVE_AUDIT_TARGET_COUNT`、`LIVE_AUDIT_ENABLE_BROWSER` 和 `LIVE_AUDIT_HOTSPOT_ONLY`，默认日期窗口不覆盖旧内容，浏览器开关和目标数量传入 loop。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec tsx --test __tests__/app/live-audit-runtime.test.ts`
Expected: FAIL on missing environment parsing。

- [ ] **Step 3: 实现配置和文档**

扩展 runtime 配置解析，示例命令：

```bash
LIVE_AUDIT_TOPIC='中国大陆 AI 灰度、内测、邀请码、候补和小范围测试热点' \
LIVE_AUDIT_FROM='2026-04-01' \
LIVE_AUDIT_TO='2026-07-24' \
LIVE_AUDIT_TARGET_COUNT=20 \
LIVE_AUDIT_HOTSPOT_ONLY=1 \
LIVE_AUDIT_ENABLE_BROWSER=1 \
LIVE_AUDIT_MAX_ITERATIONS=12 \
pnpm live-audit
```

更新 README，说明浏览器依赖安装、公开页面边界、日期字段语义、A/B/C 热点等级和短缺输出。Playwright 不可用时必须显示降级原因而不是静默伪装为成功。

- [ ] **Step 4: 运行全量验证**

Run: `pnpm build`
Expected: PASS。

Run: `pnpm test`
Expected: PASS，既有测试无回归。

Run: `LIVE_AUDIT_TOPIC='中国大陆 AI 灰度内测热点' LIVE_AUDIT_FROM='2026-04-01' LIVE_AUDIT_TO='2026-07-24' LIVE_AUDIT_TARGET_COUNT=20 LIVE_AUDIT_HOTSPOT_ONLY=1 LIVE_AUDIT_ENABLE_BROWSER=1 LIVE_AUDIT_MAX_ITERATIONS=12 pnpm live-audit`
Expected: 输出逐条报告路径；每条都有日期或 `date_unknown` 排除说明；最终 JSON 明确 `valid_count` 和 `shortfall`，不把普通发布新闻凑入 20 条。

- [ ] **Step 5: 检查输出并提交**

```bash
rg -n '2026-0[4-7]|gray_release|small_batch|invite_only|waitlist|shortfall|valid_count' "${LIVE_AUDIT_OUTPUT_DIR:?set LIVE_AUDIT_OUTPUT_DIR}"
 git status --short
 git add README.md README.zh.md src/app/live-audit-runtime.ts __tests__/app/live-audit-runtime.test.ts
 git commit -m "docs: document domestic early-access radar operation"
```

若实测不能达到 20 条，报告实际数量和短缺原因；不通过就不做“已完成 20 条”的结论。
