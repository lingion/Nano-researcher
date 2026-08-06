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

Nano-researcher is a portable, LLM-connected research agent. It accepts a
research question, lets the model decide when to search, fetch, review, or
finish, and returns a source-backed answer together with findings, evidence,
uncertainties, transport diagnostics, and a reproducible run report.

This document is the engineering handoff. It describes the implementation that
exists in this repository, the runtime boundaries that must be preserved, and
the exact places to look when operating or extending the system.

Chinese handoff documentation: [README.zh.md](./README.zh.md)

Repository: [lingion/Nano-researcher](https://github.com/lingion/Nano-researcher)

## Contents

- [Product Boundary](#product-boundary)
- [Architecture](#architecture)
- [End-to-End Execution](#end-to-end-execution)
- [LLM Decision Contract](#llm-decision-contract)
- [Auto Search](#auto-search)
- [Fetch and Browser Fallback](#fetch-and-browser-fallback)
- [Run Persistence and Reports](#run-persistence-and-reports)
- [HTTP Adapter](#http-adapter)
- [MCP Adapter](#mcp-adapter)
- [Configuration](#configuration)
- [Installation and Commands](#installation-and-commands)
- [Repository Layout](#repository-layout)
- [Troubleshooting](#troubleshooting)
- [Extending a Provider](#extending-a-provider)
- [Testing and Verification](#testing-and-verification)
- [Handoff Rules](#handoff-rules)

## Product Boundary

The repository has one primary product path:

```text
Generic Agent -> Auto search -> local fetch -> evidence -> report
```

The model owns semantic research decisions. The runtime owns execution facts
and technical limits.

The model decides:

- which search queries to issue;
- which discovered URLs to fetch;
- whether the current evidence is enough to review or finish;
- which findings are `confirmed`, `uncertain`, or `excluded`;
- what final answer to submit.

The runtime decides only technical matters:

- whether a tool call satisfies the protocol;
- how many actions, iterations, requests, retries, and bytes are allowed;
- how cancellation and deadlines propagate;
- how external responses are normalized and persisted;
- how reports and monitor projections are rendered.

The Generic path must not silently infer policy meaning, officiality, beta
status, geography, target satisfaction, or date-window business conclusions.
Those are model decisions. The code may expose mechanical transport facts such
as HTTP status, parser failure, render mode, content length, freshness signals,
or extraction warnings.

### Legacy boundary

The old policy/early-access runtime is still present for compatibility. It is
not the default product path. `legacy-audit`, `live-audit`, the vendored Search
MCP worker, and policy-specific cleanup remain migration-only surfaces.

Do not import the legacy worker into the Generic composition root. Do not add a
policy-specific rule to Generic code to improve one research topic. If a
legacy-only behavior is needed, keep it behind the legacy entrypoint and add a
test proving that the Generic path does not receive it.

## Architecture

```text
CLI / HTTP / MCP
       |
       v
ResearchTask validation
       |
       v
ResearchRunManager (HTTP/MCP async lifecycle)
       |
       v
Generic Agent loop
       |
       +-- OpenAI-compatible LLM
       |     `submit_research_decision` tool call
       |
       +-- search action -> AutoSearchProvider
       |       |
       |       +-- Baidu / Sogou / Bing / 360 / Quark
       |       +-- Yandex / Naver / Dogpile
       |       +-- provider normalization and diagnostics
       |       +-- mechanical fusion ranking
       |
       +-- fetch action -> local-fetch-primary
               |
               +-- WebFetch runtime hook, when available
               +-- safe static HTTP fetch
               +-- JSDOM/Readability extraction
               +-- Playwright browser fallback

Agent state + events
       |
       +-- FileEvidenceStore: evidence and event persistence
       +-- report.json / report.md / report.html
       +-- /monitor and /v1/research projections
```

### Responsibility matrix

| Layer | Main responsibility | Must not do |
| --- | --- | --- |
| Adapter | Accept input, expose status, return transport responses | Choose research candidates or alter findings |
| Task validation | Validate shape, enum values, and numeric bounds | Decide whether a question is answerable |
| Generic Agent | Ask the model for the next action and enforce completion semantics | Invent queries or semantic rankings |
| LLM provider | Send one structured decision request and report transport facts | Execute search or fetch directly |
| Auto | Run registered providers, normalize responses, deduplicate, rank mechanically | Declare truth, officiality, or evidence sufficiency |
| Fetch | Retrieve and extract page content, preserve warnings and HTTP facts | Decide whether page content proves a claim |
| EvidenceStore | Persist events, fetched evidence, and agent results | Rewrite model findings |
| Report | Serialize the final state and diagnostics | Re-run business judgment |
| Monitor | Poll projections and render events as text | Expose secrets or raw private paths |

### Important source files

| File or directory | Responsibility |
| --- | --- |
| `src/app/run-generic-agent.ts` | Generic CLI parsing and execution |
| `src/app/create-generic-dependencies.ts` | Generic LLM, Auto, and fetch composition root |
| `src/agent/agent-loop.ts` | Model-driven research loop and completion gates |
| `src/agent/decision-response-schema.ts` | LLM tool schema |
| `src/agent/decision-protocol.ts` | Strict decision parser and protocol errors |
| `src/agent/action-executor.ts` | Execute search/fetch actions and publish events |
| `src/app/run-manager.ts` | Async run lifecycle, cancellation, persistence, reports |
| `src/search/auto/auto.ts` | One bounded provider batch and Auto diagnostics |
| `src/search/auto/providers/engines.ts` | Built-in Provider registry |
| `src/search/auto/fusion-ranker.js` | Mechanical URL filtering, deduplication, and scoring |
| `src/fetch-fusion/local-fetch-primary.ts` | Static fetch, extraction, and browser fallback composition |
| `src/fetch-fusion/browser-fetch.ts` | Playwright context pool and rendered page fallback |
| `src/fetch-fusion/network-safety.ts` | URL, DNS, redirect, and private-network blocking |
| `src/evidence/file-store.ts` | File-backed evidence and event storage |
| `src/artifacts/generic-report.ts` | JSON, Markdown, and HTML report generation |
| `src/adapters/http/server.ts` | HTTP routes, auth, projections, and report serving |
| `src/adapters/http/monitor-page.ts` | Monitor HTML/CSS/JavaScript |
| `src/adapters/mcp/server.ts` | MCP `research` tool adapter |
| `vendor/search-mcp/` | Legacy compatibility worker only |

## End-to-End Execution

### 1. Input enters through an adapter

The CLI builds a `ResearchTask` from environment variables. HTTP accepts a JSON
task. MCP exposes the same task contract through the unified `research` tool.
All three paths eventually call the same `runAgent`/`runResearchAgent` logic.

The task has this shape:

```json
{
  "question": "Find public beta programs for AI developer tools",
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

`validateResearchTask` rejects unknown option fields and enforces:

- `maxIterations`: integer from 1 to 100;
- `targetResultCount`: integer from 1 to 100;
- `minFetchedPages`: integer from 1 to 100;
- each per-turn action budget: integer from 1 to 8;
- `completionMode`: `target_results` or `rounds`;
- `outputFormat`: `json` or `markdown`;
- non-empty `question` and valid boolean/string fields.

### 2. The run manager creates a bounded run

HTTP uses `ResearchRunManager`. `POST /v1/research` returns `202` and a
`runId` such as `run_<uuid>`. The manager then runs the agent asynchronously,
emits ordered events, writes `run.json`, stores evidence, writes reports, and
settles the terminal status.

The manager has a default in-memory cap of 100 runs. When the cap is reached it
prunes settled runs before rejecting a new run with `RUN_CAPACITY_EXCEEDED`.
On service restart, a persisted run that was still `queued`, `running`, or
`cancelling` is marked failed with `SERVICE_RESTARTED`; it is never silently
resumed.

### 3. The agent sends a forced structured decision request

The Generic LLM provider is OpenAI-compatible. It sends a request to the
configured endpoint, appending `/chat/completions` when the configured URL does
not already end with that path.

The agent forces exactly one tool call:

```text
submit_research_decision
```

The provider sets `tool_choice` to that function and
`parallel_tool_calls` to `false`. Free-text JSON is not the primary command
channel. If a gateway ignores the tool contract, the response becomes a
structured `LLM_INVALID_RESPONSE`/protocol diagnostic.

The provider retries this response at the transport boundary first. If the
bounded retries are exhausted, a recognized missing or malformed tool call is
returned as `protocolError: INVALID_TOOL_CALL` so the Agent can make its bounded
protocol-recovery request. The runtime never guesses a free-text answer; HTTP,
network, timeout, and malformed-envelope failures keep their provider-error
semantics.

### 4. The protocol parser validates the decision

`src/agent/decision-protocol.ts` rejects:

- invalid JSON or non-object envelopes;
- unknown top-level fields;
- missing required fields;
- unknown decisions;
- malformed or duplicate search/fetch actions;
- invalid URLs or unsupported URL protocols;
- action arrays over eight items;
- `search` decisions that do not contain only search actions;
- `fetch` decisions that do not contain only fetch actions;
- `review` or `finish` decisions that contain actions;
- findings outside the `confirmed`/`uncertain`/`excluded` enum;
- malformed or unsafe finding-level evidence URLs.

The parser also requires an explicit boolean `retry` field on every action.
Repeating an exact query or URL requires `retry: true`, and an exact action is
limited to three total attempts. Protocol recovery is bounded at two attempts;
an invalid model response is never repaired by silently guessing its meaning.

### 5. The executor runs one action family at a time

Each accepted decision is either:

- `search`: execute one to eight search actions;
- `fetch`: execute one to eight fetch actions;
- `review`: update no external source and ask the model to reason over current state;
- `finish`: submit the final answer, findings, evidence URLs, and uncertainties.

Search and fetch action results are appended to `AgentState`. The executor
preserves provider outcomes and emits events such as `search.result`,
`fetch.result`, `agent.model_request`, `agent.model_response`,
`agent.protocol_error`, and `agent.model_error`.

Prompt context is bounded for transport safety. Search records, fetched page
content, action history, and uncertainties are truncated by character budgets;
this is context transport, not a hidden relevance selector. Candidate selection
and finding judgment remain model-owned.

The Agent prompt keeps each finding bound to a model-submitted claim, its
disposition, and its fetched evidence URLs. It does not prescribe a
domain-specific unit of analysis or automatically merge pages by release,
program, audience, or date; semantic grouping remains model-owned after Fetch.
`transport_error` and `success_empty` are outcomes, not evidence. These are
model-facing transport and evidence instructions, not an automatic truth
classifier.

### 6. The loop applies completion semantics

There are two explicit user-selected completion modes:

| Mode | Completion condition |
| --- | --- |
| `target_results` | The finish decision contains at least the requested number of confirmed findings; when evidence is required, each confirmed finding must bind to fetched evidence and the requested fetched-evidence count must be reached. |
| `rounds` | The requested number of bounded research iterations has run; when evidence is required, the fetched-evidence requirement must also be reached. |

If `completionMode` is omitted, the agent uses natural finish semantics. If
`evidenceRequired` is true, a finish cannot complete without cited fetched
evidence. Search discovery alone never counts as evidence.

The target count is a requested goal, not permission for unbounded search. An
incomplete finish returns an honest `interrupted` result with
`completion_not_reached`, preserving the partial answer, findings, and
uncertainties; it is not reported as `completed`. The loop also has a hard
maximum of 100 iterations, and a hard deadline preserves the same partial state
when the model has not submitted a finish.

After search or fetch, the model must issue one bounded `review` decision before
an incomplete finish. That review must either identify a concrete evidence gap
for another search/fetch or record explicit blockers and then finish honestly;
the model must not repeat review without new evidence.

## LLM Decision Contract

The model tool schema is defined once in
`src/agent/decision-response-schema.ts`. The parser and schema tests must remain
in parity.

### Decision envelope

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

All top-level fields are required by the strict schema. `finalAnswer`,
`evidenceUrls`, and `findings` are meaningful only for `finish`. A finish
finding has this shape:

```json
{
  "id": "finding-1",
  "claim": "The provider currently exposes a public waitlist.",
  "disposition": "confirmed",
  "evidenceUrls": ["https://official.example/waitlist"]
}
```

Finding-level evidence URLs are the source of truth. The runtime validates every
finding citation and derives finish-level `evidenceUrls` from their union. The
top-level field remains in the wire envelope for compatibility and should be
submitted as `[]`; it is not compared against a second model-generated copy, so
long URLs cannot cause a protocol failure merely because the copies drift.

### LLM transport behavior

`OpenAiCompatibleProvider`:

- sends the configured model and messages;
- uses a forced tool call in Generic mode;
- bounds the response body to 2 MiB by default, with a 16 MiB hard maximum;
- supports 1 to 5 transport attempts, default 2;
- honors bounded `Retry-After` values for retryable HTTP responses;
- propagates caller cancellation;
- records request IDs, HTTP status, model, finish reason, usage, and transport attempts;
- never logs the API key or full Authorization header.

## Auto Search

Auto is the only public search entry in the Generic product. Providers from
other projects are adapted into this repository's provider contract; external
projects are not runtime dependencies of Generic.

### Built-in provider registry

The registry is `src/search/auto/providers/engines.ts`.

| Provider | Capability tags | Current implementation |
| --- | --- | --- |
| `bing` | `general-web`, `chinese-web` | HTML search against China and global Bing endpoints with market parameters |
| `baidu` | `chinese-web` | Mobile HTML, JSON, desktop HTML, and mobile fallback attempts |
| `sogou` | `chinese-web` | Desktop HTML followed by mobile HTML fallback |
| `360` | `chinese-web` | Session bootstrap plus `so.com` result-card parsing |
| `quark` | `chinese-web`, `vertical-search` | Quark mobile HTML/embedded JSON parsing |
| `yandex` | `general-web` | Adapted HTML provider |
| `naver` | `general-web`, `korean-web` | Adapted HTML provider |
| `dogpile` | `general-web`, `multi-source` | Adapted multi-source HTML provider |

The default Generic composition uses:

- `maxEngineCalls = 8`;
- `deadlineMs = 15_000`;
- provider result limit `12`;
- one bounded batch, with all eligible providers started together;
- per-provider request timeout at most 5 seconds in the built-in engine context;
- one provider-level retry with a 120 ms delay where the provider supports it.

Auto does not issue a second hidden batch because result count is low. Another
search action is the Agent's decision in a later turn. This is intentional: it
keeps latency and control visible and avoids a provider loop hidden inside the
search layer.

### Provider normalization

Every provider is normalized into `SearchResponse`:

- `outcome`: `success_with_content`, `success_empty`, `http_error`,
  `transport_error`, `timeout`, or `cancelled`;
- `results`: normalized `query`, `title`, `url`, `snippet`, `provider`, rank,
  source family, and result type;
- `error`: bounded code/message when the request or parser failed;
- `diagnostics`: status, duration, request count, retry count, parser details,
  blocked reason, and per-attempt records;
- `autoDiagnostics`: attempted engines, batches, stop reason, duplicate counts,
  filtered counts, output limiting, successes, and blocked engines.

HTTP errors stay errors even if a malformed response happens to contain a few
parseable-looking records. A valid empty response is distinct from a blocked,
timed-out, or parser-failed response.

### UA and fallback behavior

Provider HTTP helpers use stable desktop and Android UA profiles. The code does
not randomly rotate fingerprints: stable profiles make diagnosis reproducible.

Baidu tries, in order:

1. mobile HTML (`m.baidu.com` with Android UA);
2. Baidu JSON endpoint with desktop UA;
3. desktop HTML;
4. mobile HTML with a mobile referer.

Sogou tries desktop HTML first and then mobile HTML. Bing tries `cn.bing.com`
and `www.bing.com` with `zh-CN` market parameters. 360 and Quark use a bounded
provider session and their own parser contracts. Each attempt is retained in
diagnostics, including HTTP status, retry count, parser result count, and
failure classification.

### Mechanical fusion ranking

`src/search/auto/fusion-ranker.js` is a transparent mechanical ranker. It is
not an LLM judge and it is not a claim of implementing one particular research
paper's full ranking system.

The ranking pipeline is:

1. canonicalize HTTP(S) URLs, remove fragments and common tracking parameters,
   and trim trailing slashes;
2. reject invalid URLs and unresolved Baidu/Sogou/Bing wrapper links;
3. reject records without title and snippet;
4. group occurrences by canonical URL without deleting distinct URLs;
5. apply explicit query constraints such as phrases, required/excluded terms,
   `site:`, `domain:`, `filetype:`, `source:`, `type:`, `after:`, and `before:`;
6. calculate a score from title/snippet/URL lexical BM25-style matches, phrase
   matches, token coverage, declared authority score, freshness when the query
   asks for recent/current information, and a standard reciprocal-rank fusion
   contribution after canonical URL grouping. RRF is an explicit cross-provider
   agreement signal, not a replacement for lexical relevance;
7. sort deterministically by fused score, base relevance score, then URL.

Distinct URLs are retained even when their titles are similar. Semantic or
factual duplication is decided by the Agent after Fetch, where page content and
citations are available. Provider rank, resolved/display URL provenance,
publication timestamps, and unresolved-wrapper markers remain attached to
normalized records and fusion diagnostics.

The result exposes `scoreBreakdown` and `autoDiagnostics.candidateQuality` for
diagnosis. `candidateQuality` reports input, deduplicated, output, rejection,
and explicitly supplied source-provenance counts. These are transport and
ranking facts only: the ranker does not infer that a domain is official or that
a page proves the question. Provider adapters may supply `sourceProvenance`
explicitly; the producer boundary trims valid fields and drops malformed
metadata. The Agent must fetch and judge the candidate.

## Fetch and Browser Fallback

Generic fetch is implemented by `createGenericFetchProvider` in
`src/app/create-generic-dependencies.ts`, backed by
`fetchWithLocalPrimary`.

### Fetch sequence

1. Validate the URL as HTTP(S).
2. Resolve DNS and reject loopback, private, link-local, multicast, reserved,
   and other unsafe network targets.
3. Follow redirects manually, re-validating every hop, with at most five hops.
4. Use the host runtime's `WebFetch` hook when available.
5. Otherwise use bounded static HTTP fetch with a stable desktop UA and
   `zh-CN`-first language headers.
6. Extract readable content with JSDOM/Readability; large HTML is sent through
   a bounded worker pool.
7. If the page is a JavaScript shell, too short, or contains a loading marker,
   use the Playwright fallback.
8. Reuse the same HTML extraction boundary on browser HTML when available.
9. Return content, title, final URL, render mode, status, content length,
   truncation, retry count, and extraction warnings.

### Static extraction limits

- maximum raw HTML: 2,000,000 characters;
- extracted content returned to Generic: 20,000 characters;
- extraction worker pool default: 2 workers;
- extraction queue default: 16 jobs;
- extraction timeout default: 20,000 ms.

CSS/stylesheet parsing failures are recorded as `extractionWarnings`. They do
not automatically make the run look successful, and they do not prevent the
configured browser fallback from being attempted.

### Playwright behavior

Playwright is loaded dynamically only when fallback is needed. The default
browser is Chromium, headless, with:

- default navigation timeout: 20,000 ms;
- default concurrent contexts: 2;
- default waiting queue: 16 contexts;
- images, fonts, and media aborted to reduce cost;
- `domcontentloaded` rather than indefinite `networkidle` waiting;
- bounded rendered text and bounded HTML extraction;
- context and browser cleanup on cancellation and service close.

Install the bundled browser with:

```bash
pnpm install:browsers
```

Use `PLAYWRIGHT_EXECUTABLE_PATH` only when the deployment image supplies its
own Chromium. Missing Chromium is a fetch environment issue; the static result
and the browser failure warning remain distinguishable.

## Run Persistence and Reports

### Run lifecycle

Run statuses are:

```text
queued -> running -> completed
                  -> interrupted
                  -> failed
                  -> cancelled
running -> cancelling -> cancelled
```

Every event contains `runId`, a monotonic `sequence`, an ISO timestamp, a
stable event type, and a bounded payload. The monitor requests events after the
last sequence to avoid repeatedly rendering the same event.

### Files written for a run

With the default HTTP output directory, a run is stored as:

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

The evidence root is configured separately and defaults to
`<RESEARCH_OUTPUT_DIR>/evidence`. It may be shared across runs. Report paths
are derived from `reportRoot`, the validated run ID, and fixed filenames.
Persisted absolute paths are not trusted when serving a report; symlink and
path traversal escapes return 404.

### Report semantics

`buildGenericReport` separates these facts:

- discovered search candidates;
- fetched pages and fetch outcomes;
- successfully fetched content;
- evidence URLs cited by the final decision and matched to fetched pages;
- confirmed, uncertain, and excluded findings;
- final answer status;
- protocol/model errors;
- provider search and fetch outcome counts;
- Auto diagnostics and uncertainties.

`answerStatus` can be `completed`, `unavailable`, `blocked_by_evidence`,
`interrupted`, or `failed`. A report must not display `null` as a substitute
for an unavailable answer. It states why an answer is unavailable or blocked.

## HTTP Adapter

Start the async HTTP service with:

```bash
pnpm generic-http
```

Default bind: `127.0.0.1:8787`.

### Routes

| Method | Route | Behavior |
| --- | --- | --- |
| `GET` | `/v1/health` | Returns `{ "ok": true }`; available before auth |
| `POST` | `/v1/research` | Validates task, starts async run, returns `202` and run snapshot |
| `GET` | `/v1/research` | Lists current run projections |
| `GET` | `/v1/research/:runId` | Returns a bounded projection; `?include=full` returns full run state |
| `GET` | `/v1/research/:runId/events` | Returns ordered events after `afterSequence`, max 1,000 per request |
| `POST` | `/v1/research/:runId/cancel` | Requests cancellation; idempotent for an existing run |
| `GET` | `/v1/research/:runId/report/json` | Serves `report.json` |
| `GET` | `/v1/research/:runId/report/markdown` | Serves `report.md` |
| `GET` | `/v1/research/:runId/report/html` | Serves `report.html` |
| `GET` | `/monitor` | Lists current runs and refreshes every two seconds |
| `GET` | `/monitor/:runId` | Canonical monitor detail page; refreshes while active |
| `GET` | `/artifacts/*` | Legacy artifact serving under the process `artifacts/` root |
| `POST` | `/v1/search`, `/v1/fetch` | Disabled by default; enabled only by `RESEARCH_EXPOSE_ATOMIC_TOOLS=1` |

Request example:

```bash
curl -X POST http://127.0.0.1:8787/v1/research \
  -H 'content-type: application/json' \
  -d '{
    "question": "Compare current public developer previews for AI tools",
    "options": {
      "completionMode": "target_results",
      "targetResultCount": 10,
      "evidenceRequired": true,
      "minFetchedPages": 10,
      "maxIterations": 100
    }
  }'
```

The response contains a `runId`. Use it with:

```bash
curl http://127.0.0.1:8787/v1/research/<runId>
curl 'http://127.0.0.1:8787/v1/research/<runId>/events?afterSequence=0'
curl http://127.0.0.1:8787/v1/research/<runId>/report/markdown
```

### HTTP security

Loopback binding may run without `RESEARCH_HTTP_AUTH_TOKEN`. A non-loopback
bind is rejected unless a bearer token is configured. When enabled, protected
routes require `Authorization: Bearer <token>` and comparison is constant-time.
The monitor can consume a token from a URL fragment into session storage, then
removes the fragment from the visible URL. Tokens are not placed in query
parameters, local storage, logs, or rendered event text.

The request body is bounded to 1 MiB and HTTP request/header timeouts are
bounded. Do not expose the service directly to the public internet without a
separate network edge and authentication policy.

## MCP Adapter

Start the stdio MCP server with:

```bash
pnpm generic-mcp
```

The Generic MCP server exposes the unified `research` tool by default and uses
the same `ResearchTask` validation and `runAgent` path as HTTP/CLI. It does not
expose the old Search MCP worker as a parallel product.

`RESEARCH_EXPOSE_ATOMIC_TOOLS=1` may expose low-level search/fetch handlers for
controlled integration tests or diagnostics. That flag does not change the
Generic Agent's default composition or make those handlers the primary public
interface.

## Configuration

Copy the safe template before a live run:

```bash
cp .env.example .env
```

Credentials must be injected by the external runtime environment. Never commit
`.env`, `.env.live`, API keys, gateway tokens, reports containing sensitive
prompts, or raw provider credentials.

### Generic LLM

| Variable | Default / range | Purpose |
| --- | --- | --- |
| `NANOCLAW_BASE_URL` | required | OpenAI-compatible base or `/chat/completions` endpoint |
| `NANOCLAW_API_KEY` | required | Gateway credential |
| `POLICY_AGENT_LLM_MODEL` | `NANOCLAW_MODEL` or `gpt-5.4` | Model name; historical variable is retained for compatibility |
| `NANOCLAW_RESPONSE_FORMAT` | must be `tool_call` when set | Prevents free-text command mode |
| `NANOCLAW_JSON_MODE` | enabled unless `0` | Must not disable structured Generic mode |
| `NANOCLAW_LLM_MAX_ATTEMPTS` | `2`, range 1-5 | LLM transport attempts |
| `NANOCLAW_LLM_RETRY_DELAY_MS` | `250`, range 0-60,000 | Base retry delay |
| `LIVE_AUDIT_MODEL_TIMEOUT_MS` | provider default 120,000 ms | Historical timeout override consumed by Generic composition |

### Generic task and HTTP

| Variable | Default / range | Purpose |
| --- | --- | --- |
| `RESEARCH_QUESTION` | required for CLI | Question passed to the Agent |
| `RESEARCH_COMPLETION_MODE` | natural when omitted | `target_results` or `rounds` |
| `RESEARCH_TARGET_RESULTS` | CLI default 10, 1-100 | Target confirmed findings |
| `RESEARCH_MAX_ITERATIONS` | CLI default 100, 1-100 | Hard Agent iteration cap |
| `RESEARCH_EVIDENCE_REQUIRED` | true in CLI target mode, otherwise false | Require fetched evidence for completion |
| `RESEARCH_MIN_FETCHED_PAGES` | target count when evidence is required | Minimum cited fetched evidence |
| `RESEARCH_MAX_SEARCH_ACTIONS` | 8, range 1-8 | Search actions per model turn |
| `RESEARCH_MAX_FETCH_ACTIONS` | 8, range 1-8 | Fetch actions per model turn |
| `RESEARCH_LOCALE` | unset | Optional model locale hint |
| `RESEARCH_OUTPUT_FORMAT` | unset | CLI metadata: `json` or `markdown` |
| `RESEARCH_RUN_TIMEOUT_MS` | 1,800,000 ms, max 86,400,000 | Run deadline |
| `RESEARCH_HTTP_HOST` | `127.0.0.1` | HTTP bind address |
| `RESEARCH_HTTP_PORT` | `8787` | HTTP port |
| `RESEARCH_HTTP_AUTH_TOKEN` | unset on loopback | Required for non-loopback exposure |
| `RESEARCH_OUTPUT_DIR` | `./artifacts/runs` | Run and report root |
| `RESEARCH_EVIDENCE_DIR` | `<output>/evidence` | File evidence root |
| `RESEARCH_EXPOSE_ATOMIC_TOOLS` | disabled | Enables diagnostic HTTP/MCP atomic tools when `1` |

### Fetch and browser

| Variable | Default | Purpose |
| --- | --- | --- |
| `PLAYWRIGHT_EXECUTABLE_PATH` | bundled Chromium | Use an image-provided Chromium executable |
| `PLAYWRIGHT_MAX_CONTEXTS` | `2` | Concurrent browser contexts |
| `PLAYWRIGHT_CONTEXT_QUEUE_CAPACITY` | `16` | Queued browser requests |
| `FETCH_HTML_WORKER_POOL_SIZE` | `2` | HTML extraction workers |
| `FETCH_HTML_QUEUE_CAPACITY` | `16` | HTML extraction queue |
| `FETCH_HTML_TIMEOUT_MS` | `20,000` | Extraction timeout |

### Legacy-only variables

These variables affect the old policy path, not Generic composition:

`LIVE_AUDIT_TOPIC`, `LIVE_AUDIT_MAX_ITERATIONS`, `POLICY_TARGET_VALIDATED_COUNT`,
`SEARCH_MCP_WORKER_PATH`, `LIVE_AUDIT_DEBUG`, `LIVE_AUDIT_DIAG`, and the other
`LIVE_AUDIT_*` compatibility settings. Check the legacy source before changing
one; do not assume a legacy variable changes Generic behavior.

## Installation and Commands

Validated development baseline: Node.js 22 and pnpm 10.

```bash
corepack enable
pnpm install
pnpm build
pnpm test
```

Install browser binaries when testing dynamic pages:

```bash
pnpm install:browsers
```

### Command table

| Command | Purpose |
| --- | --- |
| `pnpm start` | Alias for the Generic CLI |
| `pnpm generic-agent` | Generic CLI entrypoint |
| `pnpm generic-http` | Async HTTP server on `127.0.0.1:8787` by default |
| `pnpm generic-mcp` | Generic stdio MCP server |
| `pnpm build` | Builds policy and Generic TypeScript projects |
| `pnpm build:policy` | Builds the legacy/policy TypeScript project |
| `pnpm build:generic` | Builds the Generic TypeScript project |
| `pnpm test` | Runs the full Node test suite |
| `pnpm test:fixture` | Runs the golden live-audit fixture regression |
| `pnpm install:browsers` | Installs Playwright Chromium |
| `pnpm legacy-audit` | Explicit legacy policy compatibility command |

### Generic CLI example

```bash
RESEARCH_QUESTION='Find current public beta or waitlist access for AI developer tools' \
RESEARCH_COMPLETION_MODE=target_results \
RESEARCH_TARGET_RESULTS=10 \
RESEARCH_MAX_ITERATIONS=100 \
RESEARCH_EVIDENCE_REQUIRED=1 \
pnpm start
```

The CLI prints an `AgentResult` JSON object. For persistent run state, polling,
cancel, and report files, use the HTTP adapter instead.

## Repository Layout

```text
.
├── package.json                    # scripts, dependencies, package identity
├── .env.example                    # safe configuration template
├── README.md / README.zh.md        # this handoff documentation
├── src/
│   ├── adapters/                   # HTTP, monitor, and MCP boundaries
│   ├── agent/                      # model contract, parser, loop, executor
│   ├── app/                        # composition, CLI, run manager, deadlines
│   ├── artifacts/                  # generic report writers
│   ├── evidence/                   # evidence interfaces and file store
│   ├── fetch/                      # provider interface and legacy adapters
│   ├── fetch-fusion/               # safe fetch, extraction, browser fallback
│   ├── llm/                        # LLM provider interface and OpenAI adapter
│   ├── search/                     # search interface and legacy adapters
│   ├── search/auto/                # Generic Auto provider registry and ranker
│   ├── runtime/                    # runtime bridges, logging, compatibility
│   └── legacy/                     # old domain-specific runtime surfaces
├── vendor/search-mcp/              # vendored legacy worker; not Generic default
├── __tests__/                      # unit, contract, integration, and security tests
├── fixtures/                       # checked-in legacy/golden test fixtures
└── docs/
    ├── PRODUCTION_READY.md         # prior delivery handoff
    └── superpowers/                # design and implementation decisions
```

The user-owned `tasks/` directory may exist locally and is intentionally not a
runtime dependency or publication surface.

## Troubleshooting

### `NANOCLAW_BASE_URL and NANOCLAW_API_KEY are required`

The Generic composition refuses to start without both variables. Check the
loaded environment in the same shell that starts `pnpm start` or
`pnpm generic-http`. Never solve this by committing a credential.

### `UNKNOWN_DECISION` or repeated `agent.protocol_error`

This means the model/gateway returned a decision that did not satisfy the
strict contract. Inspect the run event's `scope`, `code`, `rawLength`, and
bounded `rawPreview`. Common causes are:

- the gateway returned prose or free-text JSON instead of one tool call;
- the tool name was not `submit_research_decision`;
- a required top-level field was omitted;
- `retry` was omitted or had the wrong type;
- action type and decision type were mixed;
- the finish-level evidence union did not match finding evidence URLs.

Do not add a parser branch for every model mistake. First verify that the
OpenAI-compatible gateway honors forced tool calls and strict parameters.
Protocol recovery is intentionally limited to two attempts.

### Answer is unavailable or the report says `blocked_by_evidence`

Search results are discovery, not proof. Check:

1. `search.result` events for candidate URLs and provider outcomes;
2. `fetch.result` events for successful page content;
3. finish-level derived `evidenceUrls` and finding-level evidence bindings;
4. `answerStatus`, `answerReason`, `validatedEvidenceCount`, and
   `confirmedFindingCount` in `report.json`.

An answer is not considered evidence-backed merely because search returned ten
URLs. The Agent must fetch and cite the sources.

### CSS or HTML extraction failure

Check `extractionWarnings`, `renderMode`, `contentType`, `contentLength`, and
`truncated` in the fetch result. Static extraction can fail while the browser
fallback still succeeds. Install Chromium with `pnpm install:browsers` or set
`PLAYWRIGHT_EXECUTABLE_PATH` in the deployment image. Do not convert a warning
into a successful evidence claim.

### Provider shows `success_empty`, `http_error`, or `timeout`

These outcomes are intentionally different:

- `success_empty`: request and parser completed, no usable records. For Generic
  Fetch, this outcome also covers a short shell, challenge page, or otherwise
  weak extraction; the raw content and extraction warnings remain available for
  diagnosis but are not treated as evidence;
- `http_error`: provider returned an HTTP/blocking failure or CAPTCHA signal;
- `timeout`: provider exceeded its bounded request or Auto deadline;
- `transport_error`: network, parser, or provider execution failure;
- `cancelled`: caller cancellation propagated before completion.

Inspect the `diagnostics` array in the `search.result` event payload, then
inspect `diagnostics[*].details.attempts` when present, before changing a
provider. The diagnostics show whether the failure was HTTP, retry exhaustion,
parser failure, or a genuine empty result; `autoDiagnostics` only contains
aggregate Auto-level counters and stop information.

### HTTP server refuses a public bind

Set `RESEARCH_HTTP_AUTH_TOKEN` before using a non-loopback
`RESEARCH_HTTP_HOST`. This is a deliberate startup safety gate. For production,
put the service behind a real authenticated network edge as well.

### A run disappears after restart

The run manager persists terminal and in-flight snapshots, but it does not
resume an in-flight model conversation after process restart. Such runs are
marked `SERVICE_RESTARTED`. Start a new run and use the old report as historical
evidence only.

## Extending a Provider

Add a provider in the existing contract instead of embedding an external search
application.

1. Implement a provider module under `src/search/auto/providers/`.
2. Reuse `http.js` for bounded request size, timeout, retry, stable UA, and
   cancellation behavior.
3. Reuse `result.js` for `providerSuccess`, `providerFailure`, diagnostics, and
   attempt records.
4. Parse only the provider response into normalized records. Do not classify
   the user's domain or decide evidence sufficiency here.
5. Register the provider in `src/search/auto/providers/engines.ts` with a stable
   name and capability tags.
6. Add parser, failure, retry, cancellation, and normalization tests.
7. Run `pnpm test`, `pnpm build`, and a bounded live provider probe when the
   network environment allows it.

Provider diagnostics must preserve `status`, `durationMs`, `requestCount`,
`retryCount`, `attempts`, parser version, block reason, and outcome. Do not
return a successful result when the HTTP status or parser says the response was
blocked or invalid.

## Testing and Verification

### Local checks

```bash
pnpm test
pnpm build
git diff --check
```

The full test command covers the Generic Agent, decision protocol, action
executor, run manager, evidence store, report writers, Auto orchestration,
provider parsing/diagnostics, fetch extraction, browser fallback, HTTP routes,
MCP handlers, monitor behavior, cancellation, security boundaries, and legacy
compatibility tests.

At the last handoff verification, the suite reported `428 passed, 0 failed`.
That number is a snapshot; always run the command on the commit being handed
over rather than trusting this README count.

### Real-run verification

Offline tests prove contracts, not external service availability. A live test
must separately record:

- LLM gateway reachability and model response mode;
- provider attempt/outcome/diagnostic counts;
- static fetch and Playwright fallback behavior;
- validated evidence URLs;
- final answer status;
- report paths and HTTP status;
- protocol and model error counts.

Historical logs are not fresh live-run evidence. Keep credentials and raw
private prompts out of committed fixtures and reports.

## Handoff Rules

1. Keep `Generic Agent` as the formal main path.
2. Keep `Auto` as the only unified Generic search interface.
3. Add search engines as providers inside this repository; do not add parallel
   independent search projects or runtime dependencies.
4. Keep search discovery, fetch evidence, ranking mechanics, and final answer
   rendering as separate layers.
5. Do not replace model judgment with a growing list of domain-intent patches.
6. Preserve explicit failures: blocked, timeout, parser failure, empty result,
   cancellation, protocol error, and model error are different states.
7. Preserve hard bounds: max 100 iterations, max 8 actions per turn, bounded
   provider batches, bounded fetch/browser work, and bounded protocol recovery.
8. Treat `tasks/` as user-owned work unless its owner explicitly asks for it to
   be changed or published.
9. Update this README when a public route, environment variable, decision
   contract, provider registry, persistence layout, or operational invariant
   changes.

Design decisions and rationale are recorded in:

- [Nano-researcher unification design](./docs/superpowers/specs/2026-08-04-nano-researcher-unification-design.md)
- [Nano-researcher unification plan](./docs/superpowers/plans/2026-08-04-nano-researcher-unification.md)
- [Production-ready handoff](./docs/PRODUCTION_READY.md)
