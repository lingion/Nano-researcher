# 验证基线（2026-07-25）

目标仓库：当前 Git 工作区根目录

## 版本与环境

- 本轮主工作区 HEAD：`fdf793ee2873b08af065643172c06fd838a949b`
- Node：`v22.22.3`
- pnpm：`11.6.0`
- 测试入口：`tsx --test "__tests__/**/*.test.ts" "src/**/*.test.ts"`
- `package.json` scripts：`build`、`test`、`start`、`live-audit`、`test:fixture`

## 工作区边界

主工作区在审计开始时已经存在大量 dirty changes。它们不是本轮复现产生的修改。本轮只新增/更新 `docs/audits/` 审计产物，没有修改产品源码、配置或凭据。

代理复现使用隔离 worktree；代理报告的运行结果只作为复现证据，不能证明主工作区已经修复。任何修复状态仍需在主工作区目标 HEAD 上重新验证。

## 已执行验证

| 项目 | 命令/方法 | 结果 |
|---|---|---|
| 协议单测 | `node_modules/.bin/tsx --test __tests__/runtime/decision-protocol.test.ts` | 8 passed, exit 0 |
| malformed decision | `callModel` 固定返回 `{`，`maxIterations=3` | calls=3，`INVALID_JSON`，无有效 decision，未 fail-closed |
| invalid action | `continue_fetch` 携带 bad URL 与 valid URL | 仅 valid URL 执行，`INVALID_ACTION`，parser 仍 `ok=true` |
| terminal/action consistency | finalize/stop/summarize 携带 fetch action 与 `final_package:null` | 三种均先 fetch，再 terminal return |
| transport failure | search 抛错后继续提供 finalize decision | transport fact/debug event 存在，但仍 finalize |
| timeout cancellation | Promise operation 经 `withTimeout` 超时 | signal aborted，但底层 Promise 之后仍 settled |
| state initialization | 最小 `runPolicyTaskLoop` | `convergencePhase` 和 `targetValidatedEvidenceCount` 未出现在 state |
| browser persistence | `enableBrowser=true` fetch path | static→browser 可达，但绕过 `createPersistentFetchTool`/`saveFetchResult` |

## 测试基线限制

`pnpm test` 在当前依赖环境中因 pnpm 尝试处理 `better-sqlite3`/`esbuild` ignored build scripts 或 registry 安装失败而退出 1。绕过 pnpm 的聚焦协议测试通过；另一个包含 legacy `real-ask-agent` expectations 的聚焦批次为 5 passed / 9 failed。失败不能被解释为本轮所有 finding 已确认，也不能被解释为产品全量测试通过。

## 后续验证规则

1. 每个 finding 必须记录目标仓库 commit、命令、退出码和 artifact。
2. 代理 worktree 结果只保留为复现线索，不能标记 fixed。
3. 先修/验证 P0，再处理 P1；修复前不覆盖既有 dirty changes。
4. 任何测试环境问题单独记录为 process/dependency finding。
