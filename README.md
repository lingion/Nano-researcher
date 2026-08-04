# local-policy-agent

Standalone AI product and access radar runtime with the following core properties:

- NanoClaw-style live-radar orchestration core
- default **MCP-first / MCP-only** search and fetch backend
- prompt-driven product, release, access, waitlist, and eligibility evidence judgment
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

This repository runs an AI product and access radar loop:

1. the model decides whether the next step should be search, fetch, review, or summarize
2. search discovers candidate product, announcement, documentation, or application URLs only
3. fetch retrieves page evidence only
4. fetched evidence is classified as `GOLD_STANDARD`, `SILVER_STANDARD`, or `NOISE`
5. the model separates product existence from current access eligibility
6. the final output distinguishes release, beta, preview, waitlist, invitation, region limits, and application paths

---

## 2. Current architecture

### 2.1 Search and fetch layer

The default owned runtime path is hard-wired to the vendored Search MCP worker.
There is no legacy Cloudflare-style default search path left in the main execution flow.

Default backend:

- search: `search-mcp`
- fetch: `search-mcp:fetch_url`

Relevant files:

- `src/app/run-policy-task.ts`
- `src/app/run-live-audit.ts`
- `src/runtime/search-mcp-tool-adapter.ts`
- `vendor/search-mcp/src/stdio-server.js`

### 2.2 Judgment and convergence layer

Business judgment is intentionally kept in the model contract rather than hard-coded runtime rules.

The model is responsible for:

- deciding when to search vs fetch
- classifying fetched evidence
- avoiding premature finalize right after fetch
- producing the final summary package only in the summary phase

Relevant files:

- `src/policy-task/prompt-builder.ts`
- `src/runtime/ask-real-claude.ts`
- `src/runtime/local-session-loop.ts`
- `src/runtime/termination-policy.ts`

---

## 3. Prompt contract highlights

The current prompt contract explicitly constrains inputs, outputs, and fetch cadence.

### 3.1 Input state

The model should rely only on these input fields:

- `task`
- `currentIteration`
- `discoveredCandidates`
- `fetchedEvidence`
- `uncertainties`
- `convergencePhase`
- `targetValidatedEvidenceCount`

This means the summary phase and validated-evidence threshold are part of the visible prompt contract, not hidden runtime context.

### 3.2 fetchActions rules

A `continue_fetch` output must satisfy all of the following:

- `fetchActions` must not be empty
- if `discoveredCandidates` already contains official URLs, they must be copied into `fetchActions` verbatim
- a round normally allows only **1–2 fetchActions**
- more than 2 is only allowed when the prompt explicitly enters a forced multi-fetch transition

This limit exists to prevent over-fetching in one round and degrading context quality and evidence judgment.

### 3.3 Final validated evidence target

The most important end-state threshold is:

- `POLICY_TARGET_VALIDATED_COUNT`

This is the required count of validated fetched evidence items before convergence begins.
Only evidence classified as:

- `GOLD_STANDARD`
- `SILVER_STANDARD`

counts toward this threshold.
`NOISE` does not count.

Default behavior:

- default threshold: `3`
- override via runtime option: `targetValidatedEvidenceCount`
- override via environment variable: `POLICY_TARGET_VALIDATED_COUNT`

This is a validated evidence target, not a raw fetch count.

---

## 4. Requirements

Validated runtime versions:

- Node.js `v22.21.0`
- pnpm `10.33.0`

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

Required variables for live audit:

- `LIVE_AUDIT_TOPIC`
- `LIVE_AUDIT_MAX_ITERATIONS`
- `NANOCLAW_LLM_PROVIDER=openai`
- `NANOCLAW_BASE_URL`
- `NANOCLAW_API_KEY`

Optional live-audit variables:

- `LIVE_AUDIT_OUTPUT_DIR`
- `LIVE_AUDIT_DEBUG`
- `LIVE_AUDIT_DIAG`
- `POLICY_TARGET_VALIDATED_COUNT`

Optional model overrides:

- `NANOCLAW_MODEL=gpt-5.4`
- `POLICY_AGENT_LLM_MODEL=gpt-5.4`

Optional Search MCP override:

- `SEARCH_MCP_WORKER_PATH`

Notes:

- live runs require an OpenAI-compatible NanoClaw gateway
- `NANOCLAW_API_KEY` must be injected by the external runtime environment; never commit or copy a live credential into source, tests, reports, or logs
- local `.env.*` files are ignored and are only a developer convenience for manual runs
- the Search MCP worker is vendored inside the repo and used by default
- in normal usage, you do not need to switch search backend flags

---

## 7. Runtime argument tables

### 7.1 Live-audit environment arguments

- `LIVE_AUDIT_TOPIC` — live audit topic
- `LIVE_AUDIT_MAX_ITERATIONS` — maximum loop count, must be a positive integer
- `LIVE_AUDIT_OUTPUT_DIR` — optional output directory
- `LIVE_AUDIT_DEBUG` — optional verbose debug mode
- `LIVE_AUDIT_DIAG` — optional diagnostics mode
- `POLICY_TARGET_VALIDATED_COUNT` — required validated evidence target before convergence

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

Defaults:

- `command = node`
- `args = [vendor/search-mcp/src/stdio-server.js]`
- `searchLimit = 8`
- `fetchMaxChars = 20000`
- `engines = ['bing_cn', 'baidu', '360', 'sogou', 'bing']`

### 7.4 Downstream MCP tool call arguments

Search adapter calls:

- tool: `search_auto`
- args:
  - `query`
  - `limit`
  - `engines`

Fetch adapter calls:

- tool: `fetch_url`
- args:
  - `url`
  - `maxChars`

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

### 8.4 Live audit

```bash
pnpm live-audit
```

Example:

```bash
LIVE_AUDIT_TOPIC='最新 AI 模型、Agent、API、Beta/Preview、Waitlist 和内测资格' \
LIVE_AUDIT_MAX_ITERATIONS=10 \
POLICY_TARGET_VALIDATED_COUNT=4 \
LIVE_AUDIT_DEBUG=1 \
pnpm live-audit
```

---

## 9. Current execution guarantees

The current runtime behavior is intentionally stricter than before:

- the default owned search path is MCP-only
- fetched evidence must be classified before valid summary termination
- `post_convergence_review` can no longer be prematurely terminated by `finalize`
- the loop can advance into `final_summary` and terminate with `summarize_and_stop`

---

## 10. Important files

- `src/app/run-live-audit.ts` — live audit entrypoint
- `src/app/run-policy-task.ts` — outer loop controller
- `src/runtime/local-session-loop.ts` — per-iteration execution logic
- `src/runtime/search-mcp-tool-adapter.ts` — MCP search/fetch bridge
- `src/policy-task/prompt-builder.ts` — agent contract definition
- `vendor/search-mcp/` — vendored MCP worker used by the runtime

---

## 11. Latest verification baseline

Recently verified outcomes include:

- the MCP-only default backend path is covered by regression tests
- convergence regression covers:
  - `post_convergence_review`
  - `final_summary`
  - `summarize_and_stop`
- the latest AI product/access radar reaches `summarize_and_stop` with release and eligibility evidence
- it no longer gets stuck at premature `finalize`

---

## 12. Non-goals

This repository is **not** trying to do the following:

- hard-code policy conclusions into runtime logic
- treat search snippets as final evidence
- preserve legacy default search behavior for compatibility

The intended direction is:

- stronger MCP search/fetch quality
- clearer prompt contracts
- more reliable evidence-grounded summary outputs
