# local-policy-agent

一个独立的 AI 新品与访问资格雷达运行时，核心特点如下：

- 基于 NanoClaw 风格的 live radar 编排内核
- 默认 **MCP-first / MCP-only** 搜索与抓取后端
- 由 prompt 驱动的新品、发布、内测、Waitlist 和资格证据判断
- 最终以 `summarize_and_stop` 结束，而不是无限搜索

英文文档见：
- [README.md](./README.md)

---

## 1. 项目用途

这个仓库运行一个 AI 产品与访问资格雷达循环：

1. 模型先决定当前应该 search、fetch、review 还是 summarize
2. search 只负责发现产品页、公告、文档、开发者页面和申请入口
3. fetch 只负责抓取页面正文证据
4. 抓取后的证据会被分类为：`GOLD_STANDARD` / `SILVER_STANDARD` / `NOISE`
5. 模型区分产品是否存在与当前用户是否有资格访问
6. 最终结果区分正式发布、公测、内测、Preview、Waitlist、邀请码、地区限制和申请路径

---

## 2. 当前架构

### 2.1 搜索与抓取层

当前默认 owned runtime 路径已经固定为 **vendored Search MCP worker**。
主执行流里已经**没有 legacy Cloudflare 风格默认搜索路径**。

默认后端：

- search: `search-mcp`
- fetch: `search-mcp:fetch_url`

关键文件：

- `src/app/run-policy-task.ts`
- `src/app/run-live-audit.ts`
- `src/runtime/search-mcp-tool-adapter.ts`
- `vendor/search-mcp/src/stdio-server.js`

### 2.2 判断与收敛层

业务判断尽量留在模型契约里，而不是硬编码进 runtime 规则。

模型必须负责：

- 决定什么时候 search，什么时候 fetch
- 对抓取结果做证据分类
- 避免 fetch 后直接 premature finalize
- 只在最终 summary 阶段产出完整总结

关键文件：

- `src/policy-task/prompt-builder.ts`
- `src/runtime/ask-real-claude.ts`
- `src/runtime/local-session-loop.ts`
- `src/runtime/termination-policy.ts`

---

## 3. Prompt 契约重点

当前 prompt contract 明确约束了输入、输出和抓取节奏。

### 3.1 输入状态

模型应只依赖这些输入字段：

- `task`
- `currentIteration`
- `discoveredCandidates`
- `fetchedEvidence`
- `uncertainties`
- `convergencePhase`
- `targetValidatedEvidenceCount`

这意味着 summary 阶段和验证阈值本身也是 prompt contract 的一部分，不再是“隐藏上下文”。

### 3.2 fetchActions 规则

`continue_fetch` 的输出必须满足：

- `fetchActions` 不能为空
- 如果 `discoveredCandidates` 里已经有官方 URL，必须原样拷贝进 `fetchActions`
- 单轮通常只允许 **1–2 个 fetchActions**
- 只有 prompt 明确进入强制多抓取场景时，才允许超过 2 个

这个限制是为了防止一轮里抓太多页面，把上下文和证据判断搞乱。

### 3.3 最终有效证据目标个数

最重要的最终阈值参数是：

- `POLICY_TARGET_VALIDATED_COUNT`

它表示：

> **在进入收敛前，至少要攒够多少条有效抓取证据。**

只有被分类成下面两类的抓取结果才计数：

- `GOLD_STANDARD`
- `SILVER_STANDARD`

`NOISE` 不计数。

默认行为：

- 默认阈值：`3`
- 可通过 runtime option 覆盖：`targetValidatedEvidenceCount`
- 可通过环境变量覆盖：`POLICY_TARGET_VALIDATED_COUNT`

注意：
这代表的是 **有效证据个数**，不是原始抓取页数。

---

## 4. 环境要求

已验证运行版本：

- Node.js `v22.21.0`
- pnpm `10.33.0`

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

live audit 必填变量：

- `LIVE_AUDIT_TOPIC`
- `LIVE_AUDIT_MAX_ITERATIONS`
- `NANOCLAW_LLM_PROVIDER=openai`
- `NANOCLAW_BASE_URL`
- `NANOCLAW_API_KEY`

可选 live-audit 变量：

- `LIVE_AUDIT_OUTPUT_DIR`
- `LIVE_AUDIT_DEBUG`
- `LIVE_AUDIT_DIAG`
- `POLICY_TARGET_VALIDATED_COUNT`

可选模型覆盖：

- `NANOCLAW_MODEL=gpt-5.4`
- `POLICY_AGENT_LLM_MODEL=gpt-5.4`

可选 Search MCP 覆盖：

- `SEARCH_MCP_WORKER_PATH`

说明：

- live run 需要一个 OpenAI-compatible 的 NanoClaw gateway
- Search MCP worker 已 vendored 到仓库内，并且默认使用
- 一般情况下不需要再切换搜索后端开关

---

## 7. 运行时参数总表

### 7.1 live-audit 环境参数

- `LIVE_AUDIT_TOPIC` — live audit 主题
- `LIVE_AUDIT_MAX_ITERATIONS` — 最大轮数，必须是正整数
- `LIVE_AUDIT_OUTPUT_DIR` — 可选输出目录
- `LIVE_AUDIT_DEBUG` — 可选详细调试模式
- `LIVE_AUDIT_DIAG` — 可选诊断模式
- `POLICY_TARGET_VALIDATED_COUNT` — 收敛前要求的有效证据目标个数

### 7.2 `runPolicyTaskLoop(...)` options

- `maxIterations?: number`
- `askAgent?: (state) => Promise<PolicyAgentDecision>`
- `callModel?: (prompt: string) => Promise<string>`
- `searchTool?: SearchTool`
- `fetchTool?: FetchTool`
- `onDebugEvent?: (event: DebugEvent) => void`
- `targetValidatedEvidenceCount?: number`

### 7.3 `SearchMcpToolOptions`

- `command?: string`
- `args?: string[]`
- `env?: Record<string, string | undefined>`
- `cwd?: string`
- `providerConfigPath?: string`
- `searchLimit?: number`
- `fetchMaxChars?: number`
- `engines?: string[]`

默认值：

- `command = node`
- `args = [vendor/search-mcp/src/stdio-server.js]`
- `searchLimit = 8`
- `fetchMaxChars = 20000`
- `engines = ['bing_cn', 'baidu', '360', 'sogou', 'bing']`

### 7.4 下游 MCP tool 调用参数

Search adapter 调用：

- tool: `search_auto`
- args:
  - `query`
  - `limit`
  - `engines`

Fetch adapter 调用：

- tool: `fetch_url`
- args:
  - `url`
  - `maxChars`

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

### 8.4 Live audit

```bash
pnpm live-audit
```

示例：

```bash
LIVE_AUDIT_TOPIC='最新 AI 模型、Agent、API、Beta/Preview、Waitlist 和内测资格' \
LIVE_AUDIT_MAX_ITERATIONS=10 \
POLICY_TARGET_VALIDATED_COUNT=4 \
LIVE_AUDIT_DEBUG=1 \
pnpm live-audit
```

---

## 9. 当前执行保证

当前 runtime 行为是刻意收紧过的：

- 默认 owned search 路径是 MCP-only
- 抓取证据在有效 summary 结束前必须完成分类
- `post_convergence_review` 不会再被 premature `finalize` 直接截断
- loop 可以进入 `final_summary` 并以 `summarize_and_stop` 结束

---

## 10. 仓库内重点文件

- `src/app/run-live-audit.ts` — live audit 入口
- `src/app/run-policy-task.ts` — 外层循环控制器
- `src/runtime/local-session-loop.ts` — 单轮执行逻辑
- `src/runtime/search-mcp-tool-adapter.ts` — MCP 搜索/抓取桥接层
- `src/policy-task/prompt-builder.ts` — 模型契约定义
- `vendor/search-mcp/` — vendored MCP worker

---

## 11. 最近验证基线

近期已经验证通过的关键点：

- MCP-only 默认 backend 路径已有回归测试覆盖
- convergence 回归测试覆盖：
  - `post_convergence_review`
  - `final_summary`
  - `summarize_and_stop`
- 最新 AI 新品与访问资格 live audit 已能走到 `summarize_and_stop`，并输出发布和资格证据
- 不再卡在 premature `finalize`

---

## 12. 非目标

这个仓库**不打算**做这些事：

- 把政策业务结论硬编码进 runtime
- 把 search snippet 当成最终证据
- 为了兼容继续保留 legacy 默认搜索行为

当前方向是：

- 更强的 MCP 搜索/抓取质量
- 更清晰的 prompt contract
- 更可靠的证据驱动 summary 输出
