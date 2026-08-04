# Generic Research Agent Design

## Status

Approved direction: A, generic agent core.

This design turns `local-policy-agent` into a domain-neutral autonomous research
agent that can be hosted by any LLM integration. The agent keeps the original
multi-round behavior: it decides when to search, when to fetch, when to review
evidence, and when to finish. Domain-specific policy and product-radar behavior
is removed from the core rather than converted into profile plugins.

## Product Definition

The product accepts a research question and gives an LLM-controlled, bounded
research run with source-backed results.

```text
Research question
  -> LLM decision
  -> search and/or fetch actions
  -> normalized transport facts and evidence
  -> next LLM decision
  -> final research result
```

The product exposes the same application service through two hosts:

```text
MCP adapter  ----┐
                 +--> Agent application service --> Agent core
HTTP adapter ----┘             |                       |
                               v                       v
                         Search / Fetch          LLM provider
```

The first-class operation is `research`. `search` and `fetch` remain atomic
operations used by the agent and are also available to hosts that need direct
tool access.

## Goals

- Preserve autonomous multi-round LLM research behavior.
- Make the agent independent of NanoClaw, Claude, one model vendor, and one
  search vendor.
- Provide one core implementation behind MCP and HTTP adapters.
- Return useful source and transport facts: URLs, titles, snippets, extracted
  content, redirects, status, content type, truncation, backend, retries, and
  errors.
- Keep search and fetch replaceable through explicit provider interfaces.
- Make cancellation, timeout, retry, and partial execution observable.
- Make malformed model output a protocol failure, never an invented business
  decision.
- Support optional evidence persistence without making persistence part of the
  agent's business logic.

## Non-Goals

The generic core must not contain or infer:

- policy, subsidy, investment, or government-domain judgment;
- AI product, beta, waitlist, or early-access judgment;
- geography or regional eligibility conclusions;
- official-source business grades;
- evidence sufficiency or trust conclusions;
- date-window business filtering;
- target counts, hotspot counts, shortfall, or convergence quotas;
- domain-specific prompts, report templates, or final-package schemas;
- a mandatory NanoClaw session model;
- a mandatory MCP worker;
- a fixed LLM provider or fixed search provider.

The core may report mechanical facts such as HTTP status, page length,
redirects, parser warnings, and retries. It must not turn those facts into
domain conclusions.

## Target Module Boundaries

```text
src/
  agent/
    agent-loop.ts          autonomous turn orchestration
    agent-state.ts         canonical state and turn history
    decision-protocol.ts   strict model wire validation
    action-executor.ts     serial search/fetch execution
    termination.ts         technical limits and terminal state

  llm/
    provider.ts            provider contract
    openai-compatible.ts   OpenAI-compatible transport
    anthropic.ts           optional Anthropic transport

  search/
    service.ts             search operation and provider coordination
    provider.ts            provider contract
    normalization.ts       mechanical result normalization
    ranking.ts             mechanical relevance/rank support only

  fetch/
    service.ts             fetch operation and fallback coordination
    provider.ts            provider contract
    static-fetch.ts        HTTP retrieval and extraction
    browser-fetch.ts       optional rendered retrieval
    network-safety.ts      SSRF and unsafe-target protection

  evidence/
    types.ts               evidence and citation facts
    citations.ts           source/citation construction
    store.ts               optional persistence boundary

  adapters/
    mcp/                   MCP tools and transport mapping
    http/                  HTTP routes and transport mapping

  app/
    run-agent.ts           composition root
    cli.ts                 local command-line host
```

The current code should be migrated into these boundaries incrementally. The
existing policy scanner, policy judgment engine, early-access report writers,
and NanoClaw-specific session code are legacy surfaces and must not remain on
the generic agent's default path.

## Agent Contract

### Input

```ts
interface ResearchTask {
  question: string;
  options?: {
    maxIterations?: number;
    maxSearchActionsPerTurn?: number;
    maxFetchActionsPerTurn?: number;
    locale?: string;
    outputFormat?: 'json' | 'markdown';
  };
}
```

The question is opaque to the runtime. The runtime must not classify its
domain or inject domain-specific constraints.

### Model Decision

```ts
type AgentDecisionType = 'search' | 'fetch' | 'review' | 'finish';

interface AgentDecision {
  decision: AgentDecisionType;
  reasoning?: string;
  searchActions: Array<{ query: string }>;
  fetchActions: Array<{ url: string }>;
  uncertainties: string[];
  finalAnswer?: unknown;
}
```

The wire format uses one canonical camelCase schema. Legacy aliases are handled
only in an explicit compatibility adapter and never in the core loop.

### Tool Results

Tool results contain execution facts only:

```ts
type ToolOutcome =
  | 'success_with_content'
  | 'success_empty'
  | 'http_error'
  | 'transport_error'
  | 'timeout'
  | 'protocol_error'
  | 'cancelled';
```

Every result records the operation, requested input, backend, outcome, timing,
retry attempts, error details safe for model visibility, and content metadata.
Fetch evidence may include extracted text, title, requested URL, final URL,
content type, byte/character counts, truncation, render mode, and extraction
warnings. It must not include a runtime verdict such as `official`, `noise`,
`relevant`, `should_stop`, or `evidence_sufficient`.

## Execution Semantics

- The model owns the next action and final business interpretation.
- The runtime executes actions in model-provided order by default.
- Successful sibling actions are preserved when another action fails.
- Automatic retries belong to the same action and are visible as attempts.
- A model reissue is a new action and is not silently deduplicated.
- Cancellation stops unstarted actions and reports in-flight cancellation.
- Maximum iterations, request deadlines, response limits, and concurrency
  limits are technical resource guards, not business stop conditions.
- A technical interruption is returned as `interrupted`, never as a successful
  `finish` decision.
- The agent may finish without a domain-specific final package. The final
  answer is owned by the model and returned as opaque structured content plus
  citations and execution metadata.

## Search and Fetch Providers

Search providers return normalized discovery facts. Provider-specific behavior,
credentials, engines, and fallback order stay behind `SearchProvider`.

Fetch providers return normalized page facts. Static HTTP retrieval, Readability,
browser rendering, and technical fallback remain replaceable implementations
behind `FetchProvider`.

The vendored Search MCP worker is not the agent core. It may be retained as one
provider or compatibility adapter, but it must not own agent state, termination,
or business interpretation.

Weak extraction must be explicit. An HTTP 200 page with only navigation,
footer, an empty body, or content below the extractor threshold is a successful
transport request with a weak/empty extraction outcome, not valid evidence by
default. The model receives the warning and decides what to do next.

## LLM Providers

The agent depends on an `LlmProvider` contract rather than NanoClaw globals:

```ts
interface LlmProvider {
  complete(input: {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    signal?: AbortSignal;
  }): Promise<{ text: string; model?: string; usage?: unknown }>;
}
```

OpenAI-compatible and Anthropic adapters may implement this contract. The core
does not read provider-specific environment variables directly.

## MCP and HTTP Adapters

Both adapters call the same application service and only translate transport
shapes.

MCP tools:

- `research`
- `search`
- `fetch`

HTTP endpoints:

- `POST /v1/research`
- `POST /v1/search`
- `POST /v1/fetch`
- `GET /v1/health`

The adapters do not contain separate agent loops, provider logic, evidence
rules, or termination behavior. HTTP errors map to HTTP status codes; MCP
errors map to MCP tool errors; the underlying structured result remains the
same.

## Persistence and Observability

Persistence is optional and injected through an evidence store interface. The
agent can run without a workspace directory.

When enabled, persistence stores:

- task identity;
- model turns and protocol errors;
- action and attempt history;
- normalized search results;
- fetch records and citations;
- final answer;
- interruption or failure state.

Secrets, API keys, raw authorization headers, and provider credentials never
enter model-visible state or debug artifacts.

## Migration Strategy

1. Freeze current behavior with characterization tests and record the existing
   dirty worktree as a transition snapshot.
2. Define the generic contracts for task, decision, tool result, LLM provider,
   search provider, fetch provider, and evidence store.
3. Extract the current decision protocol and action executor without changing
   the autonomous loop semantics.
4. Move current local search and fetch implementations behind provider
   interfaces; keep MCP as an explicit provider/adapter.
5. Replace NanoClaw-specific model access in the core with `LlmProvider`.
6. Add the shared application service and expose it through MCP and HTTP.
7. Remove domain-specific fields and gates from the generic state and loop.
8. Move old policy and early-access entrypoints out of the default path and mark
   them as legacy compatibility surfaces.
9. Run offline, provider-contract, adapter, and real external-tool acceptance
   tests.

Each step must leave the build and focused tests passing. No migration step may
silently change a model decision into a business decision made by runtime code.

## Acceptance Criteria

- A generic question completes a multi-round search/fetch/review/finish run.
- The same task behavior is reachable through a direct application call, MCP,
  and HTTP.
- MCP and HTTP use the same core result shape.
- At least two LLM provider adapters can satisfy the core contract through
  deterministic tests.
- Search and fetch providers can be swapped with fakes without changing the
  agent loop.
- Network failures, empty responses, weak extraction, timeouts, retries, and
  cancellation are visible and never reported as successful business answers.
- The core contains no policy, early-access, geography, target-count, or
  domain-specific final-package logic.
- Existing domain-specific code is either migrated out of the default path or
  explicitly labeled as legacy and covered by compatibility tests.
- A real external search/fetch matrix demonstrates at least one successful
  research run and records failures by provider and stage.

## Open Implementation Constraint

This spec intentionally does not select a particular HTTP framework or MCP SDK
version. The implementation must reuse the repository's existing TypeScript,
Node.js, MCP SDK, and test conventions unless a concrete limitation requires a
change.
