<p align="center">
  <a href="https://github.com/lingion/Nano-researcher/stargazers"><img src="https://img.shields.io/github/stars/lingion/Nano-researcher?style=for-the-badge&logo=github&color=FFD700" alt="Stars"></a>
  <a href="https://github.com/lingion/Nano-researcher/network/members"><img src="https://img.shields.io/github/forks/lingion/Nano-researcher?style=for-the-badge&logo=github&color=8B5CF6" alt="Forks"></a>
  <a href="https://github.com/lingion/Nano-researcher/issues"><img src="https://img.shields.io/github/issues/lingion/Nano-researcher?style=for-the-badge&logo=github&color=EF4444" alt="Issues"></a>
  <a href="https://github.com/lingion/Nano-researcher/blob/main/LICENSE"><img src="https://img.shields.io/github/license/lingion/Nano-researcher?style=for-the-badge&logo=github&color=10B981" alt="License"></a>
  <br>
  <a href="https://github.com/lingion/Nano-researcher/commits/main"><img src="https://img.shields.io/github/last-commit/lingion/Nano-researcher?style=flat-square" alt="Last commit"></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-Agent-purple?style=flat-square" alt="MCP"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
</p>

# Nano-researcher

Standalone LLM-connected research agent with the following core properties:

- NanoClaw-style live-radar orchestration core
- built-in **Auto** multi-engine search with provider diagnostics and bounded fusion
- local static fetch with optional Playwright rendering fallback
- prompt-driven, domain-neutral evidence judgment and final reporting
- final termination via `summarize_and_stop`, not endless search loops

See the Chinese documentation here:
- [README.zh.md](./README.zh.md)

---

## 1. What this repository does

The default product is the generic autonomous research agent. It accepts a
research question, lets an LLM choose search/fetch/review/finish actions, and
returns source-backed results through the direct CLI, HTTP, or MCP host.

The previous policy and early-access runtime remains available as the explicit
`legacy-audit` compatibility command during migration.

This repository runs a domain-neutral autonomous research loop:

1. the model decides whether the next step should be search, fetch, review, or finish
2. Auto search discovers candidate URLs through the registered provider set
3. fetch retrieves page evidence only
4. the model classifies findings as `confirmed`, `uncertain`, or `excluded` and binds them to fetched evidence
5. the runtime validates tool calls, enforces user-selected budgets, persists evidence, and reports transport facts
6. the final output is JSON or Markdown with an answer, findings, citations, uncertainties, and interruption state

---

## 2. Current architecture

### 2.1 Search and fetch layer

The default Generic Agent path is assembled in `create-generic-dependencies.ts`:

Default backend:

- search: `AutoSearchProvider` with the built-in provider registry
- fetch: `local-fetch-primary`, with optional Playwright fallback
- limits: at most 8 engine calls per search turn in one bounded provider batch, with a bounded search deadline

The vendored Search MCP worker is retained only for the explicit legacy policy
runtime and compatibility adapter. It is not a dependency of `pnpm start`, the
Generic CLI, the Generic HTTP adapter, or the Generic MCP adapter.

Relevant files:

- `src/app/create-generic-dependencies.ts`
- `src/search/auto/`
- `src/fetch/service.ts`
- `src/fetch-fusion/local-fetch-primary.ts`
- `src/fetch-fusion/browser-fetch.ts`

### 2.2 Judgment and convergence layer

Business judgment is intentionally kept in the Generic Agent contract rather than hard-coded runtime rules.

The model is responsible for:

- deciding when to search, fetch, review, or finish
- deciding which candidate is relevant and how evidence supports it
- producing the final answer and finding dispositions

The system is responsible for protocol validation, cancellation, bounded
execution, evidence persistence, provider diagnostics, and report rendering.
It does not invent search queries, select candidates by domain meaning, or
replace a model decision with a hidden business rule.

Relevant files:

- `src/agent/agent-loop.ts`
- `src/agent/decision-protocol.ts`
- `src/agent/action-executor.ts`
- `src/artifacts/generic-report.ts`

---

## 3. Prompt contract highlights

The Generic contract is a native tool-call protocol. The model returns one
validated decision at a time; the runtime never treats free-form text as an
unvalidated command channel.

### 3.1 Input state

The task accepts these user-controlled options:

- `maxIterations` — 1 to 100
- `completionMode` — `target_results` or `rounds`
- `targetResultCount` — 1 to 100 when target mode is used
- `evidenceRequired` and `minFetchedPages`
- `maxSearchActionsPerTurn` and `maxFetchActionsPerTurn` — each 1 to 8
- `locale` and `outputFormat`

`target_results` counts unique agent-confirmed findings; `rounds` executes the
requested bounded number of research rounds before a separate finish request.
Search discovery alone is never treated as fetched evidence.

### 3.2 fetchActions rules

Every model decision must satisfy the shared protocol:

- `search` carries search actions only; `fetch` carries fetch actions only
- one decision cannot exceed the caller's action budget
- `finish` carries the final answer and evidence-bound findings
- malformed or provider-invalid responses are recorded as protocol failures and recovered only within a bounded retry budget

The limits prevent unbounded action fan-out while leaving the model in charge
of research order and semantic selection.

---

## 4. Requirements

Validated runtime versions:

- Node.js `v22.22.3` or compatible Node 22
- pnpm `10.32.1` or compatible pnpm 10+

If you use `nvm`:

```bash
nvm use
corepack enable
```

---

## 5. Install

```bash
pnpm install
pnpm build
```

---

## 6. Environment

Copy the example file first:

```bash
cp .env.example .env
```

Required variables for the Generic live CLI:

- `RESEARCH_QUESTION`
- `NANOCLAW_BASE_URL`
- `NANOCLAW_API_KEY`

Optional live-audit variables:

- `RESEARCH_COMPLETION_MODE`
- `RESEARCH_MAX_ITERATIONS`
- `RESEARCH_TARGET_RESULTS`
- `RESEARCH_EVIDENCE_REQUIRED`
- `RESEARCH_MIN_FETCHED_PAGES`
- `RESEARCH_MAX_SEARCH_ACTIONS`
- `RESEARCH_MAX_FETCH_ACTIONS`
- `RESEARCH_OUTPUT_FORMAT`
- `RESEARCH_RUN_TIMEOUT_MS`

Optional model overrides:

- `NANOCLAW_MODEL=gpt-5.4`
- `POLICY_AGENT_LLM_MODEL=gpt-5.4`

Legacy policy runtime variables:

- `LIVE_AUDIT_TOPIC`
- `LIVE_AUDIT_MAX_ITERATIONS`
- `POLICY_TARGET_VALIDATED_COUNT`
- `SEARCH_MCP_WORKER_PATH`

Notes:

- live runs require an OpenAI-compatible NanoClaw gateway
- `NANOCLAW_API_KEY` must be injected by the external runtime environment; never commit or copy a live credential into source, tests, reports, or logs
- local `.env.*` files are ignored and are only a developer convenience for manual runs
- the Generic path does not require Search MCP
- `pnpm legacy-audit` is retained for compatibility with the older policy runtime

---

## 7. Runtime argument tables

### 7.1 Generic environment arguments

- `RESEARCH_QUESTION` — research question
- `RESEARCH_COMPLETION_MODE` — `target_results` or `rounds`
- `RESEARCH_MAX_ITERATIONS` — 1 to 100
- `RESEARCH_TARGET_RESULTS` — target confirmed findings, 1 to 100
- `RESEARCH_EVIDENCE_REQUIRED` — whether findings must cite fetched pages
- `RESEARCH_MIN_FETCHED_PAGES` — minimum fetched pages when evidence is required
- `RESEARCH_MAX_SEARCH_ACTIONS` and `RESEARCH_MAX_FETCH_ACTIONS` — 1 to 8 per turn

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

Legacy defaults:

- `command = node`
- `args = [vendor/search-mcp/src/stdio-server.js]`
- `searchLimit = 8`
- `fetchMaxChars = 20000`
- `engines = ['bing_cn', 'baidu', '360', 'sogou', 'bing']`

### 7.4 Generic adapters

- HTTP: `pnpm generic-http`, with `/v1/research` and `/monitor`
- MCP: `pnpm generic-mcp`, exposing the unified `research` tool
- CLI: `pnpm generic-agent` or `pnpm start`

---

## 8. Common commands

### 8.1 Build

```bash
pnpm build
```

### 8.2 Full test suite

```bash
pnpm test
```

### 8.3 Offline golden fixture regression

```bash
pnpm test:fixture
```

### 8.4 Generic CLI

```bash
pnpm start
```

Example:

```bash
RESEARCH_QUESTION='Find current public beta or waitlist access for AI developer tools' \
RESEARCH_COMPLETION_MODE=target_results \
RESEARCH_TARGET_RESULTS=10 \
RESEARCH_MAX_ITERATIONS=100 \
pnpm start
```

---

## 9. Current execution guarantees

The Generic runtime behavior is intentionally bounded and explicit:

- the default search path is Auto and all providers are registered in this repository
- search, ranking, and final output are separate layers
- the Agent chooses search/fetch/review/finish; the system executes and verifies
- targets are counted from canonical findings/evidence, not raw search snippets
- every run has a hard maximum of 100 iterations and per-turn action budgets

---

## 10. Important files

- `src/app/run-generic-agent.ts` — Generic CLI entrypoint
- `src/agent/agent-loop.ts` — model-owned research loop
- `src/search/auto/` — Auto provider registry and bounded fusion
- `src/fetch/` and `src/fetch-fusion/` — fetch providers and browser fallback
- `src/adapters/http/` and `src/adapters/mcp/` — unified external adapters
- `src/artifacts/generic-report.ts` — JSON/Markdown/HTML report rendering
- `src/legacy/` and `vendor/search-mcp/` — explicit compatibility path

---

## 11. Latest verification baseline

Recently verified outcomes include:

- the Generic Agent, Auto, provider, fetch, evidence, report, HTTP, MCP, and monitor suites are covered by the test command
- the main path is compiled by both policy and generic TypeScript projects
- real provider and LLM runs remain environment-dependent and must be reported separately from offline tests

---

## 12. Non-goals

This repository is **not** trying to do the following:

- hard-code policy conclusions into runtime logic
- treat search snippets as final evidence
- make policy-specific logic part of the Generic Agent

The intended direction is:

- broader Auto provider coverage
- clearer model/system responsibility boundaries
- more reliable evidence-grounded summary outputs
