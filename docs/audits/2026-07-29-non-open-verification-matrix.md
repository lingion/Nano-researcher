# 2026-07-29 Non-open Finding Verification Matrix

- Scope: 95 records with original status other than `open`.
- Acceptance standard: `docs/audits/early-access-acceptance-standard.md` (read before verification).
- Inventory statuses are preserved; this matrix is an independent re-audit projection.

- Results: PASS 40; FAIL 29; BLOCKED 8; NOT_EXECUTABLE 18.

| ID | Original status | Severity | Result | Summary | Boundary |
|---|---|---|---|---|---|
| F-001 | fixed | P0 | **PASS** | Runtime 可能改写 `continue_fetch` 为 `continue_search`；`src/runtime/ask-real-claude.ts`。 | No remaining current-head reproduction identified. |
| F-002 | fixed | P0 | **PASS** | Runtime 可能从 payload/关键词自动生成 search action。 | No remaining current-head reproduction identified. |
| F-003 | fixed | P0 | **PASS** | fetch action 可能被 Runtime 复活成 search+fetch。 | No remaining current-head reproduction identified. |
| F-004 | fixed | P0 | **PASS** | search 与 fetch 缺少严格互斥调度；`src/runtime/local-session-loop.ts`。 | No remaining current-head reproduction identified. |
| F-005 | fixed | P0 | **PASS** | terminal decision 仍可能触发工具。 | No remaining current-head reproduction identified. |
| F-006 | fixed | P0 | **PASS** | 非法 action 组合可能被改写为 stop，而不是保留原 decision 并记录 protocol error。 | No remaining current-head reproduction identified. |
| F-007 | fixed | P0 | **PASS** | target/date/quality/convergence gate 可能覆盖模型业务决定。 | No remaining current-head reproduction identified. |
| F-008 | historical-unverified | P0 | **NOT_EXECUTABLE** | 硬编码 20 条目标可能强迫继续或提前停止。 | Required external or historical evidence is unavailable in this offline verification. |
| F-009 | fixed | P0 | **PASS** | `targetHotspotCount` 未完整贯穿 policy loop。 | No remaining current-head reproduction identified. |
| F-010 | fixed | P0 | **PASS** | `validCount` 在发现、抓取、报告链路中可能不一致。 | No remaining current-head reproduction identified. |
| F-011 | fixed | P0 | **PASS** | 达不到目标时 shortfall 没有稳定产生。 | No remaining current-head reproduction identified. |
| F-012 | fixed | P1 | **PASS** | context governor 参与业务筛选、排序或裁剪。 | No remaining current-head reproduction identified. |
| (missing ID) | fixed |  | **PASS** |  | No remaining current-head reproduction identified. |
| F-014 | fixed | P1 | **PASS** | 工具层硬编码 `is_suspected_reprint`。 | No remaining current-head reproduction identified. |
| F-015 | fixed | P1 | **PASS** | `access_source_grade` 被当作业务结论而非未验证 hint。 | No remaining current-head reproduction identified. |
| F-016 | fixed | P0 | **PASS** | 工具层将 inclusion 结论伪装为 transport fact。 | No remaining current-head reproduction identified. |
| F-017 | historical-unverified | P1 | **NOT_EXECUTABLE** | 任意 OpenAI-compatible gateway URL 被隐式当作 Anthropic provider。 | Required external or historical evidence is unavailable in this offline verification. |
| F-018 | historical-unverified | P1 | **NOT_EXECUTABLE** | provider hard-lock 导致错误 API protocol。 | Required external or historical evidence is unavailable in this offline verification. |
| F-019 | historical-unverified | P1 | **NOT_EXECUTABLE** | preflight 空响应被错误判为失败。 | Required external or historical evidence is unavailable in this offline verification. |
| F-020 | fixed | P1 | **PASS** | preflight 瞬时网络错误直接阻塞 policy loop。 | No remaining current-head reproduction identified. |
| F-021 | fixed | P1 | **PASS** | preflight 失败没有 Agent trace 或业务级失败状态。 | No remaining current-head reproduction identified. |
| F-022 | fixed | P1 | **PASS** | 配置数值用 `parseFloat` 但没有 finite/range 校验。 | No remaining current-head reproduction identified. |
| F-023 | historical-unverified | P1 | **NOT_EXECUTABLE** | Provider schema 接受任意 type/settings。 | Required external or historical evidence is unavailable in this offline verification. |
| F-024 | historical-unverified | P1 | **NOT_EXECUTABLE** | 缺失 provider key 时可能错误恢复其他 provider 的 backup key。 | Required external or historical evidence is unavailable in this offline verification. |
| F-025 | fixed | P1 | **PASS** | fallback model 与 primary model 共用 NanoClaw provider/baseURL/API key，gateway preflight 已同时验证两者的模型可见性。 | No remaining current-head reproduction identified. |
| F-026 | historical-unverified | P2 | **NOT_EXECUTABLE** | Dexie cloud 被禁用但没有迁移/清理旧同步状态。 | Required external or historical evidence is unavailable in this offline verification. |
| F-027 | historical-unverified | P2 | **NOT_EXECUTABLE** | 历史描述称 `pnpm start` 指向不存在的 `dist/app/index.js`。 | Required external or historical evidence is unavailable in this offline verification. |
| F-028 | historical-unverified | P2 | **NOT_EXECUTABLE** | 历史描述称 ignored install scripts 可能导致 better-sqlite3/esbuild 二进制缺失。 | Required external or historical evidence is unavailable in this offline verification. |
| F-029 | historical-unverified | P2 | **NOT_EXECUTABLE** | 历史描述称缺少环境变量时诊断信息不清晰或静默失败。 | Required external or historical evidence is unavailable in this offline verification. |
| F-030 | historical-unverified | P2 | **NOT_EXECUTABLE** | 历史描述称隐式 binary/provider/env 依赖破坏跨机器可移植性。 | Required external or historical evidence is unavailable in this offline verification. |
| F-031 | fixed | P1 | **PASS** | SearXNG search 没有可靠 retry/backoff。 | No remaining current-head reproduction identified. |
| F-032 | fixed | P1 | **PASS** | 一次 search 失败可能拒绝整个 batch。 | No remaining current-head reproduction identified. |
| F-033 | fixed | P1 | **PASS** | zero results 返回 empty quality state，而不是 fatal。 | No remaining current-head reproduction identified. |
| F-041 | confirmed | P2 | **FAIL** | 媒体/知乎/36Kr 可能压过官方来源。 | Reproduction/evidence remains current and requires remediation. |
| F-043 | confirmed | P1 | **FAIL** | 全国任务被路由为黑龙江地方政策任务。 | Reproduction/evidence remains current and requires remediation. |
| F-044 | confirmed | P1 | **FAIL** | OPC 等缩写没有先做 disambiguation。 | Reproduction/evidence remains current and requires remediation. |
| F-046 | confirmed | P1 | **FAIL** | Heavy Prompt 过拟合地方政策素材。 | Reproduction/evidence remains current and requires remediation. |
| F-047 | confirmed | P1 | **FAIL** | 定义研究没有转换到政策搜索。 | Reproduction/evidence remains current and requires remediation. |
| F-048 | confirmed | P1 | **FAIL** | 官方候选出现后没有转换到 fetch。 | Reproduction/evidence remains current and requires remediation. |
| F-049 | confirmed | P1 | **FAIL** | 多轮 continue_search 后仍无阶段转换。 | Reproduction/evidence remains current and requires remediation. |
| F-050 | confirmed | P1 | **FAIL** | maxIterations 消耗在研究阶段，打断后续验证。 | Reproduction/evidence remains current and requires remediation. |
| F-052 | fixed | P0 | **PASS** | 真实 MCP fetch 路径可能绕过 Browser fallback。 | No remaining current-head reproduction identified. |
| F-053 | needs-verification | P2 | **BLOCKED** | Browser 失败后静态弱内容仍可能被当成证据。 | Required external or historical evidence is unavailable in this offline verification. |
| F-062 | fixed | P1 | **PASS** | `normalizeFetchedPage` 丢失 raw/date/metadata/attempt facts。 | No remaining current-head reproduction identified. |
| F-063 | fixed | P0 | **PASS** | 日期解析结果被提前变成 inclusion 业务结论。 | No remaining current-head reproduction identified. |
| F-069 | historical-unverified | P2 | **NOT_EXECUTABLE** | 取正文最后一个日期可能选错日期。 | Required external or historical evidence is unavailable in this offline verification. |
| F-070 | historical-unverified | P2 | **NOT_EXECUTABLE** | 非法日期过滤曾缺失。 | Required external or historical evidence is unavailable in this offline verification. |
| F-073 | fixed | P0 | **PASS** | malformed model output 被 cast 成 `decision: undefined`，loop 继续而非 fail-closed；`src/runtime/ask-real-claude.ts:569-581`。 | No remaining current-head reproduction identified. |
| F-074 | fixed | P0 | **PASS** | invalid individual actions 被丢弃但 parser 仍返回 `ok: true`；`src/runtime/decision-protocol.ts:103-121`。 | No remaining current-head reproduction identified. |
| F-075 | fixed | P0 | **PASS** | decision/action 一致性依靠 prompt 而非 enforceable state machine。 | No remaining current-head reproduction identified. |
| F-081 | needs-verification | P2 | **BLOCKED** | output schema 允许 arbitrary keys，legacy normalization 可能改变语义。 | Required external or historical evidence is unavailable in this offline verification. |
| F-083 | fixed | P1 | **PASS** | askAgent failure 可能在 `state.updated` 前直接抛出。 | No remaining current-head reproduction identified. |
| F-084 | fixed | P2 | **PASS** | ask-agent failure 与 search/fetch failure 状态投影不对称。 | No remaining current-head reproduction identified. |
| F-085 | fixed | P2 | **PASS** | loop 没有统一 explicit failure state。 | No remaining current-head reproduction identified. |
| F-091 | historical-unverified | P1 | **NOT_EXECUTABLE** | trace persistence error 曾覆盖原始 loop error。 | Required external or historical evidence is unavailable in this offline verification. |
| F-092 | historical-unverified | P2 | **NOT_EXECUTABLE** | debug event 新序列破坏旧测试契约。 | Required external or historical evidence is unavailable in this offline verification. |
| F-097 | fixed | P2 | **PASS** | Promise-form operation timeout 不具备通用取消能力；signal-aware operation 通过 AbortSignal 取消，MCP connect timeout 通过显式 transport cleanup 收敛资源生命周期。 | No remaining current-head reproduction identified. |
| F-098 | fixed | P2 | **PASS** | browser-enabled path 绕过 persistent fetch wrapper；`src/app/run-policy-task.ts:72-74`。 | No remaining current-head reproduction identified. |
| F-099 | fixed | P1 | **PASS** | transport failure 只记录 facts/debug，不投影 explicit failure quality。 | No remaining current-head reproduction identified. |
| F-100 | fixed | P1 | **PASS** | `convergencePhase`/`targetValidatedEvidenceCount` 初始化与 schema 可能脱节。 | No remaining current-head reproduction identified. |
| F-106 | confirmed | P1 | **FAIL** | `is_suspected_reprint` 被硬编码/直接设 false。 | Reproduction/evidence remains current and requires remediation. |
| F-113 | process-gap | P1 | **FAIL** | 计划要求 append-only journal，但 canonical findings store 不存在。 | Process gap remains observable and is not equivalent to a runtime defect. |
| F-115 | fixed | P0 | **PASS** | live audit 不稳定产生逐条 early-access report。 | No remaining current-head reproduction identified. |
| F-116 | fixed | P0 | **PASS** | summary 统计与逐条报告可能不一致。 | No remaining current-head reproduction identified. |
| F-117 | confirmed | P1 | **FAIL** | `status: complete` 只证明流程完成，不证明业务正确。 | Reproduction/evidence remains current and requires remediation. |
| F-126 | fixed | P2 | **PASS** | report writer 自身不重验 items 或 target；`src/artifacts/write-early-access-report.ts:19-46`。 | No remaining current-head reproduction identified. |
| F-127 | confirmed | P2 | **FAIL** | startup live update/checkUpdate 路径被显式禁用。 | Reproduction/evidence remains current and requires remediation. |
| F-128 | needs-verification | P2 | **BLOCKED** | migration failure 仅记录并忽略，没有 user-visible audit status。 | Required external or historical evidence is unavailable in this offline verification. |
| F-129 | fixed | P2 | **PASS** | MCP keepalive close failure 未 await/record。 | No remaining current-head reproduction identified. |
| F-130 | historical-unverified | P2 | **NOT_EXECUTABLE** | MCP `onclose` race 时可能对不存在 pool entry 解引用。 | Required external or historical evidence is unavailable in this offline verification. |
| F-131 | historical-unverified | P2 | **NOT_EXECUTABLE** | 历史线索称 `mcp-client.ts` 会 mutate caller settings，删除 timeout，但当前 HEAD 未发现该文件或对应调用路径。 | Required external or historical evidence is unavailable in this offline verification. |
| F-132 | fixed | P2 | **PASS** | MCP connect 没有 timeout，hung connection 可永久阻塞。 | No remaining current-head reproduction identified. |
| F-133 | historical-unverified | P1 | **NOT_EXECUTABLE** | vendored Search MCP stdio 曾 connection closed。 | Required external or historical evidence is unavailable in this offline verification. |
| F-137 | needs-verification | P2 | **BLOCKED** | live audit 没有 bounded shutdown。 | Required external or historical evidence is unavailable in this offline verification. |
| F-139 | needs-verification | P1 | **BLOCKED** | 任意 crawl URL 没有 SSRF/private-IP 防护。 | Required external or historical evidence is unavailable in this offline verification. |
| F-147 | needs-verification | P1 | **BLOCKED** | `.env.live` 存在明文 API key，尚未轮换。 | Required external or historical evidence is unavailable in this offline verification. |
| F-148 | needs-verification | P1 | **BLOCKED** | 错误/日志可能泄露 upstream message、headers 或 page content。 | Required external or historical evidence is unavailable in this offline verification. |
| F-149 | needs-verification | P1 | **BLOCKED** | 没有统一 token/cookie/header 脱敏。 | Required external or historical evidence is unavailable in this offline verification. |
| F-151 | process-gap | P2 | **FAIL** | 直接运行 Vitest 失败，项目实际测试入口是 `tsx --test`。 | Process gap remains observable and is not equivalent to a runtime defect. |
| F-152 | process-gap | P2 | **FAIL** | `pnpm exec tsx` 曾触发 registry 安装，造成离线环境误判。 | Process gap remains observable and is not equivalent to a runtime defect. |
| F-153 | process-gap | P1 | **FAIL** | 多个代理在错误 worktree，修复没有回到目标仓库。 | Process gap remains observable and is not equivalent to a runtime defect. |
| F-154 | process-gap | P1 | **FAIL** | 错误 worktree 产生的测试文件不能作为目标修复。 | Process gap remains observable and is not equivalent to a runtime defect. |
| F-155 | process-gap | P1 | **FAIL** | 没有统一 cherry-pick/commit 回收机制。 | Process gap remains observable and is not equivalent to a runtime defect. |
| F-156 | process-gap | P2 | **FAIL** | 测试结果没有绑定 commit/dirty snapshot。 | Process gap remains observable and is not equivalent to a runtime defect. |
| F-157 | process-gap | P2 | **FAIL** | 没有 race test 证据。 | Process gap remains observable and is not equivalent to a runtime defect. |
| F-158 | process-gap | P1 | **FAIL** | 没有完整静态审计闭环。 | Process gap remains observable and is not equivalent to a runtime defect. |
| F-159 | process-gap | P0 | **FAIL** | 计划引用的 `docs/audits/2026-07-25-p0-p3-reaudit.md` 未落盘。 | Process gap remains observable and is not equivalent to a runtime defect. |
| F-160 | process-gap | P1 | **FAIL** | P0/P1/P2/P3 文字计数曾被误解为 finding 数量。 | Process gap remains observable and is not equivalent to a runtime defect. |
| F-161 | process-gap | P1 | **FAIL** | 没有 finding ID。 | Process gap remains observable and is not equivalent to a runtime defect. |
| F-162 | process-gap | P1 | **FAIL** | 没有 open/fixed/verified/duplicate lifecycle。 | Process gap remains observable and is not equivalent to a runtime defect. |
| F-163 | process-gap | P1 | **FAIL** | 没有 remediation evidence。 | Process gap remains observable and is not equivalent to a runtime defect. |
| F-164 | process-gap | P1 | **FAIL** | 没有 re-audit 结果。 | Process gap remains observable and is not equivalent to a runtime defect. |
| F-165 | process-gap | P1 | **FAIL** | 没有 section coverage matrix。 | Process gap remains observable and is not equivalent to a runtime defect. |
| F-166 | process-gap | P1 | **FAIL** | 当前 HEAD、历史 worktree、代理声明没有清晰分层。 | Process gap remains observable and is not equivalent to a runtime defect. |
| F-167 | process-gap | P2 | **FAIL** | dirty working tree 影响可重复性。 | Process gap remains observable and is not equivalent to a runtime defect. |

## Interpretation

- `PASS` means the stated current-head remediation has automated evidence; it does not mean the live business audit reached its product target.
- `FAIL` means a current confirmed defect or observed process gap remains.
- `BLOCKED` means the finding needs a safe reproduction or external evidence not available in this offline run.
- `NOT_EXECUTABLE` means the historical claim is not safely re-executable against current HEAD; it is not upgraded to fixed.
- `confirmed`, `needs-verification`, historical, and process findings are not silently promoted by test exit code.
