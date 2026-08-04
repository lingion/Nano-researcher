# Nano-researcher

一个普适的、接入 LLM 的自主研究搜索工具，核心特点如下：

- 基于 NanoClaw 风格的 live radar 编排内核
- 内置 **Auto** 多引擎搜索、Provider 诊断和有界融合排序
- 本地静态抓取，并支持 Playwright 渲染回退
- 由 prompt 驱动、领域无关的证据判断和最终报告
- 最终以 `summarize_and_stop` 结束，而不是无限搜索

英文文档见：
- [README.md](./README.md)

---

## 1. 项目用途

这个仓库默认运行一个领域无关的自主研究循环：

1. 模型先决定当前应该 search、fetch、review 还是 finish
2. Auto 通过仓库内注册的 Provider 发现候选 URL
3. fetch 只负责抓取页面正文证据
4. 模型把 finding 分类为 `confirmed`、`uncertain` 或 `excluded`，并绑定已抓取证据
5. runtime 校验工具协议、执行用户预算、持久化证据并记录传输事实
6. 最终输出 JSON 或 Markdown，包含答案、finding、引用、不确定性和中断状态

---

## 2. 当前架构

### 2.1 搜索与抓取层

Generic Agent 默认路径由 `create-generic-dependencies.ts` 组装：

默认后端：

- search: `AutoSearchProvider` 和仓库内置 Provider 注册表
- fetch: `local-fetch-primary`，必要时回退 Playwright
- 每轮 search 最多调用 8 个引擎，在统一 deadline 内完成有界聚合

vendored Search MCP worker 只保留给显式 legacy policy runtime 和兼容适配器，
不是 `pnpm start`、Generic CLI、Generic HTTP 或 Generic MCP 的运行依赖。

关键文件：

- `src/app/create-generic-dependencies.ts`
- `src/search/auto/`
- `src/fetch/service.ts`
- `src/fetch-fusion/local-fetch-primary.ts`
- `src/fetch-fusion/browser-fetch.ts`

### 2.2 判断与收敛层

业务判断留在 Generic Agent 契约里，而不是硬编码进 runtime 规则。

模型必须负责：

- 决定何时 search、fetch、review 或 finish
- 决定候选是否相关，以及证据如何支撑结论
- 产出最终答案和 finding disposition

系统只负责协议校验、取消、有界执行、证据持久化、Provider 诊断和报告渲染，
不根据领域语义自动编造 query、选择候选或替换模型决定。

关键文件：

- `src/agent/agent-loop.ts`
- `src/agent/decision-protocol.ts`
- `src/agent/action-executor.ts`
- `src/artifacts/generic-report.ts`

---

## 3. Prompt 契约重点

Generic 使用原生 tool-call 协议。模型每次返回一个经过严格校验的决定，
runtime 不把自由文本 JSON 当成未经验证的命令通道。

### 3.1 输入状态

用户可配置这些任务选项：

- `maxIterations`：1 到 100
- `completionMode`：`target_results` 或 `rounds`
- `targetResultCount`：目标模式下为 1 到 100
- `evidenceRequired` 和 `minFetchedPages`
- `maxSearchActionsPerTurn` 和 `maxFetchActionsPerTurn`：各为 1 到 8
- `locale` 和 `outputFormat`

`target_results` 统计去重后的 Agent confirmed findings；`rounds` 执行用户要求的
有界研究轮次，再单独发起 finish。search discovery 不会被冒充为 fetched evidence。

### 3.2 fetchActions 规则

每一个模型决定都必须满足共享协议：

- `search` 只能带 search actions，`fetch` 只能带 fetch actions
- 单次决定不能超过调用方设置的 action budget
- `finish` 必须带最终答案和绑定证据的 findings
- malformed 或 Provider-invalid 响应会记录为协议错误，只做有界恢复

这些限制只负责防止无限 fan-out，不替模型决定研究顺序和语义选择。

---

## 4. 环境要求

已验证运行版本：

- Node.js `v22.22.3` 或兼容的 Node 22
- pnpm `10.32.1` 或兼容的 pnpm 10+

如果你使用 `nvm`：

```bash
nvm use
corepack enable
```

---

## 5. 安装

```bash
pnpm install
pnpm build
```

---

## 6. 环境变量

先复制示例文件：

```bash
cp .env.example .env
```

Generic live CLI 必填变量：

- `RESEARCH_QUESTION`
- `NANOCLAW_BASE_URL`
- `NANOCLAW_API_KEY`

可选 Generic 变量：

- `RESEARCH_COMPLETION_MODE`
- `RESEARCH_MAX_ITERATIONS`
- `RESEARCH_TARGET_RESULTS`
- `RESEARCH_EVIDENCE_REQUIRED`
- `RESEARCH_MIN_FETCHED_PAGES`
- `RESEARCH_MAX_SEARCH_ACTIONS`
- `RESEARCH_MAX_FETCH_ACTIONS`
- `RESEARCH_OUTPUT_FORMAT`
- `RESEARCH_RUN_TIMEOUT_MS`

可选模型覆盖：

- `NANOCLAW_MODEL=gpt-5.4`
- `POLICY_AGENT_LLM_MODEL=gpt-5.4`

Legacy policy runtime 变量：

- `LIVE_AUDIT_TOPIC`
- `LIVE_AUDIT_MAX_ITERATIONS`
- `POLICY_TARGET_VALIDATED_COUNT`
- `SEARCH_MCP_WORKER_PATH`

说明：

- live run 需要一个 OpenAI-compatible 的 NanoClaw gateway
- Generic 主链不依赖 Search MCP
- `pnpm legacy-audit` 只为旧 policy runtime 保留兼容入口

---

## 7. 运行时参数总表

### 7.1 Generic 环境参数

- `RESEARCH_QUESTION` — 研究问题
- `RESEARCH_COMPLETION_MODE` — `target_results` 或 `rounds`
- `RESEARCH_MAX_ITERATIONS` — 1 到 100
- `RESEARCH_TARGET_RESULTS` — 目标 confirmed findings，1 到 100
- `RESEARCH_EVIDENCE_REQUIRED` — 是否要求 finding 引用 fetched page
- `RESEARCH_MIN_FETCHED_PAGES` — 要求证据时的最少抓取页数
- `RESEARCH_MAX_SEARCH_ACTIONS` 和 `RESEARCH_MAX_FETCH_ACTIONS` — 每轮 1 到 8

### 7.2 `ResearchTask.options`

- `maxIterations?: number`
- `completionMode?: 'target_results' | 'rounds'`
- `targetResultCount?: number`
- `evidenceRequired?: boolean`
- `minFetchedPages?: number`
- `maxSearchActionsPerTurn?: number`
- `maxFetchActionsPerTurn?: number`
- `locale?: string`
- `outputFormat?: 'json' | 'markdown'`

### 7.3 Legacy `SearchMcpToolOptions`

- `command?: string`
- `args?: string[]`
- `env?: Record<string, string | undefined>`
- `cwd?: string`
- `providerConfigPath?: string`
- `searchLimit?: number`
- `fetchMaxChars?: number`
- `engines?: string[]`

Legacy 默认值：

- `command = node`
- `args = [vendor/search-mcp/src/stdio-server.js]`
- `searchLimit = 8`
- `fetchMaxChars = 20000`
- `engines = ['bing_cn', 'baidu', '360', 'sogou', 'bing']`

### 7.4 Generic 外部适配器

- HTTP：`pnpm generic-http`，提供 `/v1/research` 和 `/monitor`
- MCP：`pnpm generic-mcp`，默认只暴露统一 `research` 工具
- CLI：`pnpm generic-agent` 或 `pnpm start`

---

## 8. 常用命令

### 8.1 Build

```bash
pnpm build
```

### 8.2 全量测试

```bash
pnpm test
```

### 8.3 离线 Golden Fixture 回归

```bash
pnpm test:fixture
```

### 8.4 Generic CLI

```bash
pnpm start
```

示例：

```bash
RESEARCH_QUESTION='查找当前可公开申请的 AI 开发者工具 Beta 或 Waitlist' \
RESEARCH_COMPLETION_MODE=target_results \
RESEARCH_TARGET_RESULTS=10 \
RESEARCH_MAX_ITERATIONS=100 \
pnpm start
```

---

## 9. 当前执行保证

Generic runtime 的边界是明确且有上限的：

- 默认搜索路径是 Auto，全部 Provider 在本仓库注册
- search、ranking 和最终输出分层处理
- Agent 决定 search/fetch/review/finish，系统只执行和验证
- target 按规范化 finding/证据统计，不按原始 snippet 凑数
- 每个 run 最多 100 轮，每轮 action 数也有硬上限

---

## 10. 仓库内重点文件

- `src/app/run-generic-agent.ts` — Generic CLI 入口
- `src/agent/agent-loop.ts` — 模型自主研究循环
- `src/search/auto/` — Auto Provider 注册和有界融合
- `src/fetch/` 与 `src/fetch-fusion/` — 抓取 Provider 和浏览器回退
- `src/adapters/http/` 与 `src/adapters/mcp/` — 统一外部接口
- `src/artifacts/generic-report.ts` — JSON/Markdown/HTML 报告
- `src/legacy/` 与 `vendor/search-mcp/` — 显式兼容路径

---

## 11. 最近验证基线

近期已经验证通过的关键点：

- Generic Agent、Auto、Provider、fetch、evidence、report、HTTP、MCP 和 monitor 均由完整测试命令覆盖
- policy 与 generic 两套 TypeScript 项目都由 `pnpm build` 编译
- 真实 Provider/LLM 运行受环境影响，必须与离线测试状态分开报告

---

## 12. 非目标

这个仓库**不打算**做这些事：

- 把政策业务结论硬编码进 runtime
- 把 search snippet 当成最终证据
- 把 policy 领域规则重新放进 Generic Agent

当前方向是：

- 更广的 Auto Provider 覆盖
- 更清晰的模型/系统责任边界
- 更可靠的证据驱动 summary 输出
