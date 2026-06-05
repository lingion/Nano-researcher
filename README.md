# local-policy-agent

一个独立的本地政策研究运行时，核心特点是：
A standalone local policy research runtime with the following core properties:

- 基于 NanoClaw 风格的 live audit 编排内核  
  NanoClaw-style live-audit orchestration core
- 默认 **MCP-first / MCP-only** 搜索与抓取后端  
  Default **MCP-first / MCP-only** search and fetch backend
- 由 prompt 驱动的证据判断与收敛控制  
  Prompt-driven evidence judgment and convergence control
- 最终以 `summarize_and_stop` 结束，而不是无限搜索  
  Final termination via `summarize_and_stop`, not endless search loops

---

## 1. 项目用途 / What this repository does

这个仓库运行一个政策研究循环：
This repository runs a policy research loop:

1. 模型先决定当前应该 search、fetch、review 还是 summarize  
   The model decides whether the next step should be search, fetch, review, or summarize
2. search 只负责发现候选 URL  
   Search discovers candidate URLs only
3. fetch 只负责抓取页面正文证据  
   Fetch retrieves page evidence only
4. 抓取后的证据会被分类为：`GOLD_STANDARD` / `SILVER_STANDARD` / `NOISE`  
   Fetched evidence is classified as: `GOLD_STANDARD` / `SILVER_STANDARD` / `NOISE`
5. 达到足够验证证据后，runtime 会进入两阶段收敛：  
   Once enough validated evidence is collected, the runtime enters a two-step convergence flow:
   - `post_convergence_review`
   - `final_summary`
6. 最终输出为总结结果包，而不是继续搜索  
   The final output is a summary package rather than more search churn

---

## 2. 当前架构 / Current architecture

### 2.1 搜索与抓取层 / Search and fetch layer

当前默认 owned runtime 路径已经固定为 **vendored Search MCP worker**。  
The default owned runtime path is now hard-wired to the **vendored Search MCP worker**.

主执行流里已经**没有 legacy Cloudflare 风格默认搜索路径**。  
There is **no legacy Cloudflare-style default search path** left in the main execution flow.

默认后端：  
Default backend:

- search: `search-mcp`
- fetch: `search-mcp:fetch_url`

关键文件：  
Relevant files:

- `src/app/run-policy-task.ts`
- `src/app/run-live-audit.ts`
- `src/runtime/search-mcp-tool-adapter.ts`
- `vendor/search-mcp/src/stdio-server.js`

### 2.2 判断与收敛层 / Judgment and convergence layer

业务判断尽量留在模型契约里，而不是硬编码进 runtime 规则。  
Business judgment is intentionally kept in the model contract rather than hard-coded runtime rules.

模型必须负责：  
The model is responsible for:

- 决定什么时候 search，什么时候 fetch  
  deciding when to search vs fetch
- 对抓取结果做证据分类  
  classifying fetched evidence
- 避免 fetch 后直接 premature finalize  
  avoiding premature finalize right after fetch
- 只在最终 summary 阶段产出完整总结  
  producing the final summary package only in the summary phase

关键文件：  
Relevant files:

- `src/policy-task/prompt-builder.ts`
- `src/runtime/ask-real-claude.ts`
- `src/runtime/local-session-loop.ts`
- `src/runtime/termination-policy.ts`

---

## 3. Prompt 契约重点 / Prompt contract highlights

当前 prompt contract 明确约束了输入、输出和抓取节奏。  
The current prompt contract explicitly constrains inputs, outputs, and fetch cadence.

### 3.1 输入状态 / Input state

模型应只依赖这些输入字段：  
The model should rely only on these input fields:

- `task`
- `currentIteration`
- `discoveredCandidates`
- `fetchedEvidence`
- `uncertainties`
- `convergencePhase`
- `targetValidatedEvidenceCount`

这意味着 summary 阶段和验证阈值本身也是 prompt contract 的一部分，不再是“隐藏上下文”。  
This means the summary phase and validated-evidence threshold are part of the visible prompt contract, not hidden runtime context.

### 3.2 fetchActions 规则 / fetchActions rules

`continue_fetch` 的输出必须满足：  
A `continue_fetch` output must satisfy all of the following:

- `fetchActions` 不能为空  
  `fetchActions` must not be empty
- 如果 `discoveredCandidates` 里已经有官方 URL，必须原样拷贝进 `fetchActions`  
  If `discoveredCandidates` already contains official URLs, they must be copied into `fetchActions` verbatim
- 单轮通常只允许 **1–2 个 fetchActions**  
  A round normally allows only **1–2 fetchActions**
- 只有 prompt 明确进入强制多抓取场景时，才允许超过 2 个  
  More than 2 is only allowed when the prompt explicitly enters a forced multi-fetch transition

这个限制是为了防止一轮里抓太多页面，把上下文和证据判断搞乱。  
This limit exists to prevent over-fetching in one round and degrading context quality and evidence judgment.

---

## 4. 环境要求 / Requirements

已验证运行版本：  
Validated runtime versions:

- Node.js `v22.21.0`
- pnpm `10.33.0`

如果你使用 `nvm`：  
If you use `nvm`:

```bash
nvm use
corepack enable
```

---

## 5. 安装 / Install

```bash
pnpm install
pnpm build
```

---

## 6. 环境变量 / Environment

先复制示例文件：  
Copy the example file first:

```bash
cp .env.example .env
```

live audit 必填变量：  
Required variables for live audit:

- `NANOCLAW_LLM_PROVIDER=openai`
- `NANOCLAW_BASE_URL`
- `NANOCLAW_API_KEY`

可选模型覆盖：  
Optional model overrides:

- `NANOCLAW_MODEL=gpt-5.4`
- `POLICY_AGENT_LLM_MODEL=gpt-5.4`

说明：  
Notes:

- live run 需要一个 OpenAI-compatible 的 NanoClaw gateway  
  Live runs require an OpenAI-compatible NanoClaw gateway
- Search MCP worker 已 vendored 到仓库内，并且默认使用  
  The Search MCP worker is vendored inside the repo and used by default
- 一般情况下**不需要**再切换搜索后端开关  
  In normal usage, you **do not need** to switch search backend flags

---

## 7. 常用命令 / Common commands

### 7.1 Build

```bash
pnpm build
```

### 7.2 全量测试 / Full test suite

```bash
pnpm test
```

### 7.3 离线 Golden Fixture 回归 / Offline golden fixture regression

```bash
pnpm test:fixture
```

### 7.4 Live audit

```bash
pnpm live-audit
```

示例：  
Example:

```bash
LIVE_AUDIT_TOPIC='常州市 医疗补贴' \
LIVE_AUDIT_MAX_ITERATIONS=10 \
LIVE_AUDIT_DEBUG=1 \
pnpm live-audit
```

---

## 8. 当前执行保证 / Current execution guarantees

当前 runtime 行为是刻意收紧过的：  
The current runtime behavior is intentionally stricter than before:

- 默认 owned search 路径是 MCP-only  
  The default owned search path is MCP-only
- 抓取证据在有效 summary 结束前必须完成分类  
  Fetched evidence must be classified before valid summary termination
- `post_convergence_review` 不会再被 premature `finalize` 直接截断  
  `post_convergence_review` can no longer be prematurely terminated by `finalize`
- loop 可以进入 `final_summary` 并以 `summarize_and_stop` 结束  
  The loop can advance into `final_summary` and terminate with `summarize_and_stop`

---

## 9. 仓库内重点文件 / Important files

- `src/app/run-live-audit.ts` — live audit 入口  
  live audit entrypoint
- `src/app/run-policy-task.ts` — 外层循环控制器  
  outer loop controller
- `src/runtime/local-session-loop.ts` — 单轮执行逻辑  
  per-iteration execution logic
- `src/runtime/search-mcp-tool-adapter.ts` — MCP 搜索/抓取桥接层  
  MCP search/fetch bridge
- `src/policy-task/prompt-builder.ts` — 模型契约定义  
  agent contract definition
- `vendor/search-mcp/` — vendored MCP worker  
  vendored MCP worker used by the runtime

---

## 10. 最近验证基线 / Latest verification baseline

近期已经验证通过的关键点：  
Recently verified outcomes include:

- MCP-only 默认 backend 路径已有回归测试覆盖  
  The MCP-only default backend path is covered by regression tests
- convergence 回归测试覆盖：  
  Convergence regression covers:
  - `post_convergence_review`
  - `final_summary`
  - `summarize_and_stop`
- `常州市 医疗补贴` live audit 已能正常走到 `summarize_and_stop`  
  The `常州市 医疗补贴` live audit now reaches `summarize_and_stop`
- 不再卡在 premature `finalize`  
  It no longer gets stuck at premature `finalize`

---

## 11. 非目标 / Non-goals

这个仓库**不打算**做这些事：  
This repository is **not** trying to do the following:

- 把政策业务结论硬编码进 runtime  
  hard-code policy conclusions into runtime logic
- 把 search snippet 当成最终证据  
  treat search snippets as final evidence
- 为了兼容继续保留 legacy 默认搜索行为  
  preserve legacy default search behavior for compatibility

当前方向是：  
The intended direction is:

- 更强的 MCP 搜索/抓取质量  
  stronger MCP search/fetch quality
- 更清晰的 prompt contract  
  clearer prompt contracts
- 更可靠的证据驱动 summary 输出  
  more reliable evidence-grounded summary outputs
