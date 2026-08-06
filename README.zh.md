# Nano-researcher

Nano-researcher 是一个普适的、接入 LLM 的自主研究搜索工具。它接收一个研究问题，
由模型决定什么时候搜索、什么时候抓取、什么时候复核证据、什么时候结束，最后输出：

- 有证据绑定的最终答案；
- `confirmed`、`uncertain`、`excluded` 三类 finding；
- 搜索候选、抓取页面和证据 URL；
- Provider、HTTP、解析、重试、超时和协议诊断；
- 不确定性、中断原因和可复现的 JSON/Markdown/HTML 报告。

本文是公司内部交接文档。内容以当前仓库代码、测试和运行契约为准，说明产品边界、
完整调用链、目录职责、配置项、接口、故障排查和扩展方式。

英文版：[README.md](./README.md)

仓库：[lingion/Nano-researcher](https://github.com/lingion/Nano-researcher)

## 目录

- [一、产品边界](#一产品边界)
- [二、总体架构](#二总体架构)
- [三、完整执行链路](#三完整执行链路)
- [四、LLM 决策协议](#四llm-决策协议)
- [五、Auto 搜索实现](#五auto-搜索实现)
- [六、Fetch 与浏览器回退](#六fetch-与浏览器回退)
- [七、Run 持久化与报告](#七run-持久化与报告)
- [八、HTTP 接口](#八http-接口)
- [九、MCP 接口](#九mcp-接口)
- [十、配置项](#十配置项)
- [十一、安装与命令](#十一安装与命令)
- [十二、目录职责](#十二目录职责)
- [十三、故障排查](#十三故障排查)
- [十四、如何扩展 Provider](#十四如何扩展-provider)
- [十五、测试与验证](#十五测试与验证)
- [十六、交接规则](#十六交接规则)

## 一、产品边界

当前项目真正的主链只有一条：

```text
Generic Agent -> Auto 搜索 -> local-fetch-primary 抓取 -> EvidenceStore -> Report/Monitor
```

`Auto` 是 Generic 产品唯一的统一搜索入口。百度、搜狗、Bing、360、夸克以及其他
Provider 都注册在本项目内部，不存在两个平行的搜索项目，也不要求 Generic 运行时依赖
外部搜索项目。

### 模型负责什么

模型是研究业务决策者，负责：

- 决定下一步是否 `search`、`fetch`、`review` 或 `finish`；
- 生成搜索 query；
- 从候选 URL 中选择需要抓取的页面；
- 判断候选与问题是否相关；
- 判断抓取内容是否支持一个 finding；
- 将 finding 标记为 `confirmed`、`uncertain` 或 `excluded`；
- 输出最终答案、引用和不确定性。

### 系统负责什么

系统只负责可验证的技术事实和边界：

- 校验 LLM tool-call 是否符合协议；
- 执行搜索、抓取和证据写入；
- 限制轮次、action 数、请求数、重试数、响应体大小和并发数；
- 传播取消信号和 deadline；
- 记录 Provider 的 HTTP 状态、解析失败、阻断、超时和请求尝试；
- 持久化运行状态、事件、证据和报告；
- 返回 Monitor 和 API 所需的投影。

Generic 不能把政策领域、官方性、灰度测试、地理范围、目标满足情况或日期业务结论
偷偷写成固定规则。代码可以记录机械事实，例如 HTTP status、render mode、
content length、freshness signal 和 extraction warning，但不能根据这些事实越权替模型
下业务结论。

### Legacy 边界

旧的 policy/early-access runtime 仍然保留，是为了兼容历史命令、fixture 和已有运行结果。
它不是默认产品路径：

- `pnpm start` 默认进入 Generic Agent；
- `pnpm generic-http` 默认进入 Generic HTTP；
- `pnpm generic-mcp` 默认进入统一 `research` 工具；
- vendored Search MCP worker 只给 legacy policy 运行时使用；
- policy-specific 清洗、官方域名推导和旧的证据线索不进入 Generic 主链。

如果某个行为只服务旧项目，放在 legacy 入口，并用测试证明 Generic 不会收到它。不要为了
修一个特定研究主题，在 Generic 里增加一条新的意图补丁。

## 二、总体架构

```text
CLI / HTTP / MCP
       |
       v
ResearchTask 校验
       |
       v
ResearchRunManager（HTTP/MCP 异步生命周期）
       |
       v
Generic Agent 循环
       |
       +-- OpenAI-compatible LLM
       |     submit_research_decision tool-call
       |
       +-- search action -> AutoSearchProvider
       |       |
       |       +-- 百度 / 搜狗 / Bing / 360 / 夸克
       |       +-- Yandex / Naver / Dogpile
       |       +-- Provider 归一化和诊断
       |       +-- 机械融合排序
       |
       +-- fetch action -> local-fetch-primary
               |
               +-- 运行时 WebFetch hook（如果存在）
               +-- 安全静态 HTTP 抓取
               +-- JSDOM/Readability 正文提取
               +-- Playwright 浏览器回退

Agent state + events
       |
       +-- FileEvidenceStore：证据和事件落盘
       +-- report.json / report.md / report.html
       +-- /monitor 和 /v1/research 投影
```

### 分层责任表

| 层 | 主要职责 | 明确不能做什么 |
| --- | --- | --- |
| Adapter | 接收输入、鉴权、返回 HTTP/MCP/CLI 结果 | 不能挑候选、改 finding |
| Task validation | 校验字段、枚举和数值边界 | 不能判断问题是否可回答 |
| Generic Agent | 调用模型、执行决策、判断完成契约 | 不能自行编造 query 或语义排名 |
| LLM provider | 发送一次结构化决策请求并返回传输事实 | 不能直接执行搜索和抓取 |
| Auto | 调 Provider、归一化、去重、机械排序 | 不能宣布真伪、官方性或证据充分性 |
| Fetch | 抓页面、提正文、保留抓取事实和 warning | 不能判断页面是否证明 claim |
| EvidenceStore | 存事件、抓取证据和 Agent 结果 | 不能重写模型 finding |
| Report | 序列化结果、证据、诊断和不确定性 | 不能重新执行业务判断 |
| Monitor | 查询投影、展示实时事件 | 不能泄漏 token 或任意文件路径 |

### 关键源码位置

| 文件/目录 | 职责 |
| --- | --- |
| `src/app/run-generic-agent.ts` | Generic CLI 入口和环境变量解析 |
| `src/app/create-generic-dependencies.ts` | Generic LLM、Auto、fetch 组合根 |
| `src/agent/agent-loop.ts` | 模型驱动的研究循环和完成门槛 |
| `src/agent/decision-response-schema.ts` | LLM tool schema |
| `src/agent/decision-protocol.ts` | 严格决策解析和协议错误 |
| `src/agent/action-executor.ts` | 搜索/抓取 action 执行和事件发布 |
| `src/app/run-manager.ts` | 异步 run 生命周期、取消、持久化和报告 |
| `src/search/auto/auto.ts` | Auto 一轮 Provider batch 和总诊断 |
| `src/search/auto/providers/engines.ts` | 内置 Provider 注册表 |
| `src/search/auto/fusion-ranker.js` | URL 过滤、去重和机械打分 |
| `src/fetch-fusion/local-fetch-primary.ts` | 静态抓取、HTML 提取和浏览器回退组合 |
| `src/fetch-fusion/browser-fetch.ts` | Playwright context pool 和渲染回退 |
| `src/fetch-fusion/network-safety.ts` | URL、DNS、redirect 和内网地址保护 |
| `src/evidence/file-store.ts` | 文件型证据和事件存储 |
| `src/artifacts/generic-report.ts` | JSON/Markdown/HTML 报告 |
| `src/adapters/http/server.ts` | HTTP 路由、鉴权、投影、报告读取 |
| `src/adapters/http/monitor-page.ts` | Monitor 页面 HTML/CSS/JavaScript |
| `src/adapters/mcp/server.ts` | MCP `research` 工具适配器 |
| `vendor/search-mcp/` | 仅供旧 policy 兼容路径使用 |

## 三、完整执行链路

### 1. Adapter 接收研究任务

CLI 从环境变量构造 `ResearchTask`；HTTP 接收 JSON；MCP 接收同一任务契约。三条入口
最终都进入同一套 `runAgent`/`runResearchAgent`。

任务示例：

```json
{
  "question": "收集当前公开披露的 AI 开发者工具内测消息",
  "options": {
    "completionMode": "target_results",
    "targetResultCount": 10,
    "maxIterations": 100,
    "evidenceRequired": true,
    "minFetchedPages": 10,
    "maxSearchActionsPerTurn": 8,
    "maxFetchActionsPerTurn": 8,
    "locale": "zh-CN",
    "outputFormat": "markdown"
  }
}
```

`validateResearchTask` 会拒绝未知字段，并强制：

- `maxIterations`：1 到 100 的整数；
- `targetResultCount`：1 到 100 的整数；
- `minFetchedPages`：1 到 100 的整数；
- 每轮 search/fetch action budget：1 到 8 的整数；
- `completionMode`：只能是 `target_results` 或 `rounds`；
- `outputFormat`：只能是 `json` 或 `markdown`；
- question 非空；
- boolean、locale 和其他字符串字段类型正确。

### 2. RunManager 创建有界运行

HTTP 使用 `ResearchRunManager`。`POST /v1/research` 返回 `202` 和一个类似
`run_<uuid>` 的 `runId`，随后异步执行 Agent、发送有序事件、保存 `run.json`、写证据、
生成报告并设置终态。

RunManager 默认最多保存 100 个 run。达到容量时会先删除已经 settle 的 run；如果仍然满，
返回 `RUN_CAPACITY_EXCEEDED`。服务重启时，处于 `queued`、`running` 或 `cancelling` 的持久化
run 会被标记为 `SERVICE_RESTARTED` 失败，不会假装从上次的 LLM 会话继续。

### 3. Agent 强制请求一个结构化 tool-call

Generic 使用 OpenAI-compatible LLM。配置的 URL 如果没有以 `/chat/completions` 结尾，
Provider 会自动补上该路径。

每一轮都强制模型调用：

```text
submit_research_decision
```

请求设置了强制 `tool_choice` 和 `parallel_tool_calls: false`。自由文本 JSON 不是主命令
通道。网关如果忽略 tool-call，会产生 `LLM_INVALID_RESPONSE` 或协议诊断，而不是让 runtime
猜测这段文本想做什么。

Provider 会先在传输层执行有界重试。重试耗尽后，如果确认是缺少或错误的 tool-call，会返回
`protocolError: INVALID_TOOL_CALL`，交给 Agent 做有界的协议恢复请求。runtime 不会猜测自由
文本的业务含义；HTTP、网络、超时和非法 envelope 仍保持 provider error 语义。

### 4. 严格解析模型决策

`src/agent/decision-protocol.ts` 会拒绝：

- 非法 JSON 或非 object envelope；
- 未知顶层字段、缺少必填字段；
- 未知 decision；
- malformed 或重复的 search/fetch action；
- 非 HTTP(S) URL；
- 单个 action 数组超过 8；
- `search` 混入 fetch，`fetch` 混入 search；
- `review`/`finish` 携带 action；
- finding disposition 不在三个允许值中；
- finding evidence URL 格式非法或使用不安全协议。

每个 action 必须显式携带 boolean `retry`。同一个 query 或 URL 再次出现时必须写
`retry: true`，完全相同的 action 总尝试次数最多 3 次。协议恢复最多 2 次；不会为每一种
模型错误继续增加 parser 补丁。

### 5. Executor 每轮执行一个 action 家族

一个合法决策只能是下面四种之一：

- `search`：执行 1 到 8 个搜索 action；
- `fetch`：执行 1 到 8 个抓取 action；
- `review`：不调用外部源，让模型基于当前状态继续判断；
- `finish`：提交最终答案、finding、证据 URL 和 uncertainty。

结果会写回 `AgentState`，并发布 `search.result`、`fetch.result`、`agent.model_request`、
`agent.model_response`、`agent.protocol_error`、`agent.model_error` 等事件。

为了防止 prompt 无限膨胀，搜索结果、抓取内容、action history 和 uncertainty 都有字符
预算。这个截断是传输保护，不是隐藏的候选相关性判断；模型仍然负责候选选择和 finding 判断。

Agent prompt 只要求每个 finding 绑定模型提交的 claim、disposition 和已抓取的 evidence URL。
它不规定某个领域的 target 单位，也不会按发布、项目、受众或日期自动合并页面；语义分组仍由
模型在 Fetch 后自行判断。`transport_error` 和 `success_empty` 是工具结果状态，不是证据。
这些是面向模型的传输与证据指令，不是自动真伪分类器。

### 6. 处理完成条件

| 模式 | 完成条件 |
| --- | --- |
| `target_results` | finish 中至少有目标数量的 `confirmed` finding；如果要求证据，每个 confirmed finding 必须绑定成功抓取的证据，并达到最少引用证据数。 |
| `rounds` | 达到用户要求的有界研究轮次；如果要求证据，还必须达到最少引用证据数。 |

没有指定 `completionMode` 时使用 natural finish 语义。如果 `evidenceRequired=true`，
没有已抓取且被 finish 引用的证据，finish 不能被标记为 completed。搜索 discovery 永远
不能直接算作 fetched evidence。

目标数量是用户要求的目标，不是允许无限搜索的理由。模型提交不完整 finish 时，系统会保留
部分答案、findings 和 uncertainty，以 `completion_not_reached` 返回诚实的
`interrupted`；不会伪造成 `completed`。最大轮次仍硬限制为 100；如果模型始终没有提交
finish，达到硬 deadline 时同样保留当前部分状态。

在 search 或 fetch 之后，如果目标仍未达到，模型必须先提交一次有界的 `review` 决策，
再决定是否不完整 finish。review 必须二选一：指出具体证据缺口并继续 search/fetch，
或记录明确 blockers 后诚实 finish；没有新证据时不得重复 review。

## 四、LLM 决策协议

协议 schema 唯一来源是 `src/agent/decision-response-schema.ts`，解析器是
`src/agent/decision-protocol.ts`，二者必须由测试保持一致。

### 决策 envelope

```json
{
  "decision": "search | fetch | review | finish",
  "searchActions": [{ "query": "...", "retry": false }],
  "fetchActions": [{ "url": "https://example.com", "retry": false }],
  "uncertainties": ["..."],
  "finalAnswer": null,
  "evidenceUrls": [],
  "findings": []
}
```

严格 schema 要求所有顶层字段存在。`finalAnswer`、`evidenceUrls` 和 `findings` 只有在
`finish` 时才有业务意义。finding 结构如下：

```json
{
  "id": "finding-1",
  "claim": "该工具当前开放公开候补名单。",
  "disposition": "confirmed",
  "evidenceUrls": ["https://official.example/waitlist"]
}
```

Finding-level evidence URL 是唯一绑定事实。Runtime 会验证每个 finding 的证据并集，
再从该并集派生 finish 的 `evidenceUrls`。顶层字段为了兼容保留，模型应提交 `[]`；
Runtime 不再把两份由模型重复生成的长 URL 逐字比较，因此复制漂移不会再制造协议错误。

### LLM 传输实现

`OpenAiCompatibleProvider`：

- 发送 model、messages 和严格 tool-call 配置；
- 默认响应体上限 2 MiB，硬上限 16 MiB；
- 支持 1 到 5 次传输尝试，默认 2 次；
- 对可重试 HTTP 错误读取有界 `Retry-After`；
- 传播调用方取消；
- 记录 request ID、HTTP status、model、finish reason、usage 和 transport attempts；
- 不记录 API key 或完整 Authorization header。

## 五、Auto 搜索实现

Auto 是 Generic 唯一的公开搜索入口。其他项目的 Provider 只能适配进本项目的 Provider
契约，不能把整个外部项目作为 Generic 的运行依赖。

### 当前内置 Provider

注册位置：`src/search/auto/providers/engines.ts`。

| Provider | capability | 实现方式 |
| --- | --- | --- |
| `bing` | `general-web`, `chinese-web` | China Bing 和 global Bing HTML，携带中文 market 参数 |
| `baidu` | `chinese-web` | 移动 HTML、JSON、桌面 HTML、移动 fallback 多次尝试 |
| `sogou` | `chinese-web` | 桌面 HTML 后回退移动 HTML |
| `360` | `chinese-web` | session bootstrap 后解析 `so.com` result card |
| `quark` | `chinese-web`, `vertical-search` | 夸克移动 HTML/嵌入 JSON 解析 |
| `yandex` | `general-web` | 适配后的 HTML Provider |
| `naver` | `general-web`, `korean-web` | 适配后的 HTML Provider |
| `dogpile` | `general-web`, `multi-source` | 适配后的多来源 HTML Provider |

Generic 默认组合参数：

- `maxEngineCalls = 8`；
- Auto deadline `15,000 ms`；
- 单 Provider 结果上限 `12`；
- 单轮只执行一个有界 batch，eligible Provider 一起启动；
- 内置 engine context 的单 Provider 请求 timeout 最多 5 秒；
- Provider 支持时默认 1 次重试，重试间隔 120 ms。

Auto 不会因为当前结果条数少就偷偷开启第二批 Provider。下一轮搜索必须由 Agent 决定，
这样延迟、Provider 调用数量和研究进度都可观察，不会形成隐藏的搜索循环。

### Provider 归一化

所有 Provider 都归一化为 `SearchResponse`：

- `outcome`：`success_with_content`、`success_empty`、`http_error`、`transport_error`、
  `timeout` 或 `cancelled`；
- `results`：统一的 query、title、url、snippet、provider、rank、sourceFamily、resultType；
- `error`：有界 code/message；
- `diagnostics`：status、duration、request count、retry count、parser detail、blocked reason
  和每次 attempt；
- `autoDiagnostics`：attempted engines、batch、停止原因、重复数、过滤数、输出限制、
  成功数和 blocked 数。

即使错误响应中碰巧解析出几条内容，HTTP error 仍然保持 error，不会被改成 success。正常
的空结果也与阻断、超时、传输失败和解析失败严格区分。

### UA 与 fallback

Provider HTTP helper 使用稳定的桌面 UA 和 Android UA，不做随机指纹轮换。稳定指纹更容易
复现问题，也不会把随机轮换误当成反爬解决方案。

百度尝试顺序：

1. `m.baidu.com` 移动 HTML，Android UA；
2. `www.baidu.com/s?tn=json` JSON，桌面 UA；
3. 百度桌面 HTML；
4. 带移动 referer 的移动 HTML fallback。

搜狗先尝试桌面 HTML，再尝试移动 HTML。Bing 先请求 `cn.bing.com`，必要时尝试
`www.bing.com`，同时设置 `zh-CN`、`cc=cn` 和 `mkt=zh-CN`。360 和夸克使用有界 session
和自己的解析器。每次 attempt 都会写进诊断，包含 status、retry count、解析数量和失败类型。

### 机械融合排序

`src/search/auto/fusion-ranker.js` 是透明的机械排序器，不是 LLM judge，也不能宣称它
完整实现了某一篇论文的全部排序算法。

处理顺序：

1. 只接受 HTTP(S) URL，去 fragment、常见 tracking 参数和末尾 slash；
2. 丢弃非法 URL、没有解析的百度/搜狗/Bing wrapper URL；
3. 丢弃 title 和 snippet 都为空的记录；
4. 按 canonical URL 分组，同一 URL 的多 Provider 记录合并，不删除不同 URL；
5. 执行 query 约束，包括短语、必需/排除词、`site:`、`domain:`、`filetype:`、
   `source:`、`type:`、`after:` 和 `before:`；
6. 计算 title/snippet/URL lexical BM25-style 分数、phrase 分数、token coverage、声明的
   authority score，以及 query 表达最新意图时的 freshness 分数；canonical URL 分组后再
   加入标准 reciprocal-rank fusion 分数，把跨 Provider 的重复发现作为显式协同信号，而
   不是替代文本相关性；
7. 按融合后的 score 降序、基础相关性分数降序、URL 升序稳定排序。

不同 URL 即使标题相似也会保留。语义重复或事实重复要等 Agent Fetch 后读取页面正文和引用
再判断。Provider rank、resolved/display URL provenance、发布日期、更新日期和未解析 wrapper
标记都会保留在归一化结果与 fusion diagnostics 中。

返回结果保留 `scoreBreakdown` 和 `autoDiagnostics.candidateQuality`，便于诊断。
`candidateQuality` 只报告输入数、去重后数量、输出数、各类淘汰数和 Provider 显式提供的
source provenance 数量。这些都是传输与排序事实；排序器不会推导官方性，不会判断一个页面
是否证明了问题，也不会替模型决定候选。Provider 只能显式提供 `sourceProvenance`；producer
boundary 会清理合法字段并丢弃格式非法的 metadata，不会从 URL、域名或 Provider 名称推断。

## 六、Fetch 与浏览器回退

Generic fetch 由 `createGenericFetchProvider` 组合，底层是
`fetchWithLocalPrimary`。

### 抓取顺序

1. 校验 URL 为 HTTP(S)；
2. DNS 解析并拒绝 loopback、private、link-local、multicast、reserved 等不安全目标；
3. 手动跟随 redirect，每一跳重新校验，最多 5 跳；
4. 如果运行环境提供 `WebFetch` hook，优先调用它；
5. 否则用稳定桌面 UA 和中文优先语言头做有界静态 HTTP 抓取；
6. 使用 JSDOM/Readability 提取正文，大 HTML 走受限 worker pool；
7. 如果页面是 JavaScript shell、内容太短或包含 loading marker，进入 Playwright；
8. 浏览器拿到 HTML 后重新走同一 HTML extraction boundary；
9. 返回 content、title、final URL、render mode、status、content length、truncated、retry
   count 和 extraction warnings。

### 静态提取限制

- 原始 HTML 最大 2,000,000 字符；
- Generic 返回给 Agent 的正文最大 20,000 字符；
- HTML extraction worker 默认 2 个；
- extraction queue 默认 16 个；
- extraction timeout 默认 20,000 ms。

CSS/stylesheet 解析失败会进入 `extractionWarnings`。它不会被伪装成成功证据，也不会阻止
已配置的浏览器回退。浏览器仍失败时，返回静态结果和明确 warning，方便区分抓取失败与模型
判断失败。

### Playwright 行为

Playwright 只在需要回退时动态加载 Chromium，默认：

- headless；
- navigation timeout 20,000 ms；
- 并发 context 2 个；
- 排队 context 16 个；
- abort image、font、media 请求；
- 等待 `domcontentloaded`，不无限等待 `networkidle`；
- 限制 rendered text 和 HTML 长度；
- 取消或服务关闭时关闭 context 和 browser。

安装浏览器：

```bash
pnpm install:browsers
```

部署镜像提供自带 Chromium 时，可以设置 `PLAYWRIGHT_EXECUTABLE_PATH`。浏览器未安装是
环境问题，不能通过修改报告把它写成页面抓取成功。

## 七、Run 持久化与报告

### Run 生命周期

```text
queued -> running -> completed
                  -> interrupted
                  -> failed
                  -> cancelled
running -> cancelling -> cancelled
```

每条事件包含 `runId`、单调递增 `sequence`、ISO timestamp、稳定 event type 和 payload。
Monitor 用 `afterSequence` 增量拉事件，避免每次重复渲染全量历史。

### 文件布局

HTTP 默认输出目录下，一个 run 的布局是：

```text
artifacts/runs/
└── run_<uuid>/
    ├── run.json
    ├── report/
    │   ├── report.json
    │   ├── report.md
    │   └── report.html

RESEARCH_EVIDENCE_DIR/
└── run_<uuid>/
    ├── events.jsonl
    ├── search-results.jsonl
    ├── fetched-pages.jsonl
    └── agent-result.json
```

证据根目录单独配置，默认是 `<RESEARCH_OUTPUT_DIR>/evidence`，可以被多个 run 共享。
报告读取不会信任持久化的绝对路径，而是由 `reportRoot + 合法 runId + 固定文件名` 派生，
并通过 `realpath` 检查 symlink 和 `..` 越界。越界文件返回 404。

### 报告字段语义

`buildGenericReport` 把以下事实分开记录：

- 搜索发现的候选；
- 实际请求的页面及 fetch outcome；
- 有正文的成功抓取页面；
- finish 引用且确实匹配已抓取页面的证据 URL；
- confirmed、uncertain、excluded findings；
- final answer status；
- protocol/model errors；
- search/fetch outcome 统计；
- Auto diagnostics 和 uncertainties。

`answerStatus` 可以是：`completed`、`unavailable`、`blocked_by_evidence`、`interrupted`、
`failed`。没有答案时报告会给出原因，不把答案显示成误导性的 `null`。

## 八、HTTP 接口

启动：

```bash
pnpm generic-http
```

默认监听 `127.0.0.1:8787`。

### 路由表

| 方法 | 路由 | 行为 |
| --- | --- | --- |
| `GET` | `/v1/health` | 返回 `{ "ok": true }`，鉴权前可访问 |
| `POST` | `/v1/research` | 校验 task、启动异步 run、返回 `202` 和 run snapshot |
| `GET` | `/v1/research` | 返回当前 run projection 列表 |
| `GET` | `/v1/research/:runId` | 返回有界 projection；`?include=full` 返回完整 run state |
| `GET` | `/v1/research/:runId/events` | 用 `afterSequence` 增量拉事件，每次最多 1,000 条 |
| `POST` | `/v1/research/:runId/cancel` | 请求取消；已有 run 是幂等的 |
| `GET` | `/v1/research/:runId/report/json` | 返回 `report.json` |
| `GET` | `/v1/research/:runId/report/markdown` | 返回 `report.md` |
| `GET` | `/v1/research/:runId/report/html` | 返回 `report.html` |
| `GET` | `/monitor` | 列出当前 run，每 2 秒刷新 |
| `GET` | `/monitor/:runId` | canonical 详情页，运行中持续刷新 |
| `GET` | `/artifacts/*` | 兼容旧路径，只允许 process `artifacts/` 根目录 |
| `POST` | `/v1/search`, `/v1/fetch` | 默认关闭，只有 `RESEARCH_EXPOSE_ATOMIC_TOOLS=1` 才启用 |

启动后可以直接打开：

```text
http://127.0.0.1:8787/monitor
```

页面首先列出当前 run，点击列表项进入 `/monitor/<runId>`；旧的
`/monitor?runId=<runId>` 会规范化到 canonical path。详情页显示状态、搜索数、抓取数、
事件数、协议错误、迭代数、最终答案、报告链接和实时事件。

请求示例：

```bash
curl -X POST http://127.0.0.1:8787/v1/research \
  -H 'content-type: application/json' \
  -d '{
    "question": "收集当前公开的 AI 开发者工具内测消息",
    "options": {
      "completionMode": "target_results",
      "targetResultCount": 10,
      "evidenceRequired": true,
      "minFetchedPages": 10,
      "maxIterations": 100
    }
  }'
```

拿到 `runId` 后：

```bash
curl http://127.0.0.1:8787/v1/research/<runId>
curl 'http://127.0.0.1:8787/v1/research/<runId>/events?afterSequence=0'
curl http://127.0.0.1:8787/v1/research/<runId>/report/markdown
```

### HTTP 安全

loopback 监听可以没有 `RESEARCH_HTTP_AUTH_TOKEN`。非 loopback 监听必须配置 Bearer token，
否则服务启动时拒绝。启用后，保护路由要求：

```text
Authorization: Bearer <token>
```

token 比较使用 constant-time。Monitor 可以从 URL fragment 读取 token，放入 sessionStorage
后清理地址栏 fragment；token 不进入 query、localStorage、日志或事件文本。

请求 body 上限 1 MiB，HTTP request/header timeout 有界。不要把这个服务直接裸露到公网，
生产环境还需要独立的鉴权边缘和网络策略。

## 九、MCP 接口

启动：

```bash
pnpm generic-mcp
```

Generic MCP 默认只暴露统一 `research` 工具，使用和 CLI/HTTP 完全相同的 `ResearchTask`
校验与 `runAgent` 主链。它不会把旧 Search MCP worker 作为第二个并行产品暴露出去。

`RESEARCH_EXPOSE_ATOMIC_TOOLS=1` 可以为受控诊断或集成测试暴露低层 search/fetch handler，
但这不改变 Generic 默认组成，也不改变 Auto 是唯一统一搜索入口的设计。

## 十、配置项

复制安全模板：

```bash
cp .env.example .env
```

凭据必须由外部运行时环境注入。`.env`、`.env.live`、API key、gateway token、包含敏感 prompt 的
报告和原始 Provider 凭据都不能提交。

### Generic LLM

| 变量 | 默认/范围 | 作用 |
| --- | --- | --- |
| `NANOCLAW_BASE_URL` | 必填 | OpenAI-compatible base URL 或 `/chat/completions` URL |
| `NANOCLAW_API_KEY` | 必填 | Gateway 凭据 |
| `POLICY_AGENT_LLM_MODEL` | `NANOCLAW_MODEL` 或 `gpt-5.4` | 模型名；旧变量名为兼容保留 |
| `NANOCLAW_RESPONSE_FORMAT` | 设置时必须为 `tool_call` | 禁止自由文本命令模式 |
| `NANOCLAW_JSON_MODE` | 默认开启 | Generic 不允许关闭结构化输出 |
| `NANOCLAW_LLM_MAX_ATTEMPTS` | 默认 2，范围 1-5 | LLM 传输尝试次数 |
| `NANOCLAW_LLM_RETRY_DELAY_MS` | 默认 250，范围 0-60,000 | retry 基础延迟 |
| `LIVE_AUDIT_MODEL_TIMEOUT_MS` | Provider 默认 120,000 ms | 历史变量名，当前被 Generic composition 消费 |

### Generic 任务和 HTTP

| 变量 | 默认/范围 | 作用 |
| --- | --- | --- |
| `RESEARCH_QUESTION` | CLI 必填 | 研究问题 |
| `RESEARCH_COMPLETION_MODE` | 不填时 natural | `target_results` 或 `rounds` |
| `RESEARCH_TARGET_RESULTS` | CLI 默认 10，范围 1-100 | confirmed finding 目标数 |
| `RESEARCH_MAX_ITERATIONS` | CLI 默认 100，范围 1-100 | Agent 最大迭代数 |
| `RESEARCH_EVIDENCE_REQUIRED` | CLI target mode 默认 true，否则 false | 是否必须引用 fetched evidence |
| `RESEARCH_MIN_FETCHED_PAGES` | evidence 开启时默认目标数 | 最少引用的成功抓取页面数 |
| `RESEARCH_MAX_SEARCH_ACTIONS` | 默认 8，范围 1-8 | 每轮搜索 action 数 |
| `RESEARCH_MAX_FETCH_ACTIONS` | 默认 8，范围 1-8 | 每轮抓取 action 数 |
| `RESEARCH_LOCALE` | unset | 可选的语言/地区提示 |
| `RESEARCH_OUTPUT_FORMAT` | unset | CLI metadata：`json` 或 `markdown` |
| `RESEARCH_RUN_TIMEOUT_MS` | 默认 1,800,000 ms，最大 86,400,000 | run deadline |
| `RESEARCH_HTTP_HOST` | `127.0.0.1` | HTTP 监听地址 |
| `RESEARCH_HTTP_PORT` | `8787` | HTTP 监听端口 |
| `RESEARCH_HTTP_AUTH_TOKEN` | loopback 可不填 | 非 loopback 必填 |
| `RESEARCH_OUTPUT_DIR` | `./artifacts/runs` | run 和报告根目录 |
| `RESEARCH_EVIDENCE_DIR` | `<output>/evidence` | 证据根目录 |
| `RESEARCH_EXPOSE_ATOMIC_TOOLS` | 关闭 | 为 `1` 时开放诊断用 atomic tools |

### Fetch 和浏览器

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PLAYWRIGHT_EXECUTABLE_PATH` | bundled Chromium | 使用部署镜像自带浏览器 |
| `PLAYWRIGHT_MAX_CONTEXTS` | `2` | 浏览器 context 并发数 |
| `PLAYWRIGHT_CONTEXT_QUEUE_CAPACITY` | `16` | 浏览器排队容量 |
| `FETCH_HTML_WORKER_POOL_SIZE` | `2` | HTML 提取 worker 数 |
| `FETCH_HTML_QUEUE_CAPACITY` | `16` | HTML 提取排队容量 |
| `FETCH_HTML_TIMEOUT_MS` | `20,000` | HTML 提取 timeout |

### Legacy 变量

`LIVE_AUDIT_TOPIC`、`LIVE_AUDIT_MAX_ITERATIONS`、`POLICY_TARGET_VALIDATED_COUNT`、
`SEARCH_MCP_WORKER_PATH`、`LIVE_AUDIT_DEBUG`、`LIVE_AUDIT_DIAG` 和其他 `LIVE_AUDIT_*`
只影响旧 policy runtime。修改前必须先查 legacy 源码，不要默认它们会改变 Generic 行为。

## 十一、安装与命令

已验证开发基线：Node.js 22、pnpm 10。

```bash
corepack enable
pnpm install
pnpm build
pnpm test
```

测试动态网页时安装 Chromium：

```bash
pnpm install:browsers
```

### 命令表

| 命令 | 作用 |
| --- | --- |
| `pnpm start` | Generic CLI 别名 |
| `pnpm generic-agent` | Generic CLI 入口 |
| `pnpm generic-http` | 默认监听 `127.0.0.1:8787` 的异步 HTTP 服务 |
| `pnpm generic-mcp` | Generic stdio MCP 服务 |
| `pnpm build` | 依次构建 policy 和 Generic 两套 TypeScript 项目 |
| `pnpm build:policy` | 构建旧 policy 项目 |
| `pnpm build:generic` | 构建 Generic 项目 |
| `pnpm test` | 执行完整 Node 测试 |
| `pnpm test:fixture` | 执行 golden live-audit fixture 回归 |
| `pnpm install:browsers` | 安装 Playwright Chromium |
| `pnpm legacy-audit` | 显式进入旧 policy 兼容命令 |

### Generic CLI 示例

```bash
RESEARCH_QUESTION='收集当前公开的 AI 开发者工具 Beta 或 Waitlist' \
RESEARCH_COMPLETION_MODE=target_results \
RESEARCH_TARGET_RESULTS=10 \
RESEARCH_MAX_ITERATIONS=100 \
RESEARCH_EVIDENCE_REQUIRED=1 \
pnpm start
```

CLI 输出 `AgentResult` JSON。需要持久化 run、轮询状态、取消和报告文件时使用 HTTP。

## 十二、目录职责

```text
.
├── package.json                    # scripts、依赖、包名
├── .env.example                    # 安全配置模板
├── README.md / README.zh.md        # 公司交接文档
├── src/
│   ├── adapters/                   # HTTP、Monitor、MCP 边界
│   ├── agent/                      # 模型契约、解析器、循环、执行器
│   ├── app/                        # 组合根、CLI、RunManager、deadline
│   ├── artifacts/                  # Generic 报告写入器
│   ├── evidence/                   # 证据接口和文件存储
│   ├── fetch/                      # fetch 接口和 legacy 适配器
│   ├── fetch-fusion/               # 安全抓取、HTML 提取、浏览器回退
│   ├── llm/                        # LLM 接口和 OpenAI-compatible 实现
│   ├── search/                     # search 接口和旧适配器
│   ├── search/auto/                # Generic Auto Provider 与排序器
│   ├── runtime/                    # runtime bridge、日志、兼容逻辑
│   └── legacy/                     # 旧领域 runtime
├── vendor/search-mcp/              # 旧 worker，Generic 默认不依赖
├── __tests__/                      # 单测、契约、集成、安全和 UI 测试
├── fixtures/                       # 旧 runtime/golden fixture
└── docs/
    ├── PRODUCTION_READY.md         # 之前的交付记录
    └── superpowers/                # 设计和实施决策
```

本地可能存在用户自己的 `tasks/` 目录。它不是运行时依赖，也不是默认发布内容。

## 十三、故障排查

### `NANOCLAW_BASE_URL and NANOCLAW_API_KEY are required`

Generic composition 没拿到两个必填变量。检查启动 `pnpm start`、`pnpm generic-http` 或
`pnpm generic-mcp` 的同一个 shell 环境。不要通过把 token 写进源码解决。

### `UNKNOWN_DECISION` 或连续 `agent.protocol_error`

这表示 LLM/gateway 返回的决策不符合严格契约。先看事件里的 `scope`、`code`、`rawLength`
和有界 `rawPreview`。常见原因：

- gateway 返回 prose 或自由文本 JSON，没有真正发起 tool-call；
- tool 名不是 `submit_research_decision`；
- 缺少某个顶层必填字段；
- action 漏了 `retry` 或类型不对；
- decision 和 action 家族混用；
- finish 的顶层 evidence URL 与 finding evidence URL 并集不一致。

先修 gateway 的强制 tool-call 配置，不要为每一种模型输出继续增加 parser 分支。协议恢复
已经限制为两次。

### Answer 不可用或报告是 `blocked_by_evidence`

搜索结果是 discovery，不是证据。按顺序检查：

1. `search.result`：是否拿到了候选 URL，Provider 是成功、空结果还是被阻断；
2. `fetch.result`：是否真的有 `success_with_content`；
3. finish 派生出的 `evidenceUrls` 和 finding 的 evidence binding；
4. `report.json` 的 `answerStatus`、`answerReason`、`validatedEvidenceCount` 和
   `confirmedFindingCount`。

搜索返回十条 URL 不等于已经有十条证据，必须由 Agent 抓取并引用页面。

### CSS/HTML 解析失败

查看 fetch 结果中的 `extractionWarnings`、`renderMode`、`contentType`、`contentLength`
和 `truncated`。静态提取失败时可能仍能进入 Playwright。安装 Chromium：

```bash
pnpm install:browsers
```

或者在部署镜像中设置 `PLAYWRIGHT_EXECUTABLE_PATH`。不要把 warning 改成成功证据。

### Provider 是 `success_empty`、`http_error` 或 `timeout`

这些状态含义不同：

- `success_empty`：请求和 parser 正常完成，但没有可用记录。Generic Fetch 遇到短壳页面、
  验证码/挑战页或其他弱提取时也使用这个 outcome；原始正文和 extraction warnings 仍保留
  供诊断，但不会被当成证据；
- `http_error`：HTTP 错误、验证码或 Provider block；
- `timeout`：Provider request 或 Auto deadline 超时；
- `transport_error`：网络、parser 或 Provider 执行失败；
- `cancelled`：调用方取消在完成前传播到 Provider。

先查看 `search.result` 事件 payload 中的 `diagnostics` 数组；如果存在，继续查看
`diagnostics[*].details.attempts`，确认是 HTTP、retry exhaustion、parser failure 还是正常空结果，
再修改 Provider。`autoDiagnostics` 只有 Auto 层聚合计数和停止信息，不包含逐 Provider 的 attempt 明细。

### HTTP 拒绝公网监听

非 loopback 的 `RESEARCH_HTTP_HOST` 必须配置 `RESEARCH_HTTP_AUTH_TOKEN`，这是启动安全门。
生产环境还要增加真正的鉴权边缘和网络隔离。

### 服务重启后 run 消失或失败

RunManager 会保存终态和中间 snapshot，但不会在进程重启后恢复原来的 LLM 对话。重启时
仍在运行的 run 会以 `SERVICE_RESTARTED` 失败。需要重新开始新 run，旧报告只能当历史证据。

## 十四、如何扩展 Provider

新增搜索引擎必须以 Provider 形式进入现有 Auto，不要把外部搜索项目整体接入。

1. 在 `src/search/auto/providers/` 新增 Provider 模块；
2. 复用 `http.js` 的 body size、timeout、retry、稳定 UA 和取消行为；
3. 复用 `result.js` 的 `providerSuccess`、`providerFailure`、diagnostics 和 attempt；
4. 只把 Provider 响应解析成标准 record，不在这里判断领域意义或证据充分性；
5. 在 `src/search/auto/providers/engines.ts` 注册稳定名称和 capability tags；
6. 增加 parser、空结果、HTTP block、retry、取消和 normalization 测试；
7. 运行 `pnpm test`、`pnpm build`，网络允许时再做有界 live probe。

Provider 必须保留 `status`、`durationMs`、`requestCount`、`retryCount`、`attempts`、
parser version、block reason 和 outcome。不能在 HTTP 或 parser 已表示失败时返回 success。

## 十五、测试与验证

### 本地验证

```bash
pnpm test
pnpm build
git diff --check
```

完整测试覆盖：Generic Agent、decision protocol、action executor、RunManager、EvidenceStore、
Report、Auto orchestration、Provider parser/diagnostics、静态 HTML 提取、Playwright 回退、
HTTP 路由、MCP、Monitor、取消、安全边界和 legacy 兼容。

最近一次交接验证结果是 `428 passed, 0 failed`。这个数字是快照，测试数量会随代码变化；
交接时必须对当前 commit 重新执行命令，不能只相信 README 的旧数字。

### 实测和离线测试必须分开

离线测试只证明代码契约，不证明外部服务当前可访问。一次真实运行应分别记录：

- LLM gateway 是否可达、是否真的返回 tool-call；
- 每个 Provider 的 attempt/outcome/diagnostic；
- 静态抓取和 Playwright fallback 的实际结果；
- validated evidence URL；
- final answer status；
- 报告文件和 HTTP status；
- protocol error 与 model error 数量。

历史日志不能冒充新鲜实测证据。不要把 API token、私有 prompt 或敏感运行报告提交进 fixture。

## 十六、交接规则

1. `Generic Agent` 是正式主链。
2. `Auto` 是 Generic 唯一统一搜索入口。
3. 新引擎以 Provider 形式加入本仓库，不接入平行独立搜索项目。
4. 搜索 discovery、fetch evidence、机械排序和最终输出必须保持分层。
5. 不要用不断增加的领域意图补丁替代模型判断。
6. blocked、timeout、parser failure、empty、cancelled、protocol error、model error 必须保持
   不同状态。
7. 保留硬边界：最多 100 轮、每轮最多 8 个 search/fetch action、有界 Provider batch、有界
   fetch/browser、有界协议恢复。
8. `tasks/` 是用户目录，除非目录所有者明确要求，否则不要修改或发布。
9. 公开路由、环境变量、tool schema、Provider 注册表、持久化布局或运行不变量变化时，必须
   同步更新 README。

相关设计和实施记录：

- [Nano-researcher 统一设计](./docs/superpowers/specs/2026-08-04-nano-researcher-unification-design.md)
- [Nano-researcher 实施计划](./docs/superpowers/plans/2026-08-04-nano-researcher-unification.md)
- [Production-ready handoff](./docs/PRODUCTION_READY.md)
