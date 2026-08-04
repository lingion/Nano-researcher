# Generic Research Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Convert the existing domain-heavy policy/early-access runtime into a domain-neutral autonomous research agent exposed through one shared application service, MCP, and HTTP.

**Architecture:** Preserve the multi-round model-directed agent behavior, but move it behind generic `ResearchTask`, `AgentDecision`, tool-result, LLM-provider, search-provider, fetch-provider, and evidence-store contracts. MCP and HTTP will be thin adapters over the same application service; policy and early-access code will leave the generic default path.

**Tech Stack:** TypeScript, Node.js 22, pnpm, `tsx --test`, `@modelcontextprotocol/sdk`, existing fetch/Readability/browser code, OpenAI-compatible and Anthropic-compatible LLM transports.

## Global Constraints

- The agent remains autonomous: the model decides search, fetch, review, and finish.
- Runtime may enforce only technical limits: protocol shape, timeout, cancellation, response size, retry, and resource limits.
- Runtime must not infer policy, officiality, geography, early access, evidence sufficiency, target counts, or business stop conditions.
- MCP and HTTP adapters must call the same application service and return the same result model.
- Provider-specific environment variables are resolved at composition roots, not inside the generic core.
- Every task ends with focused tests and `pnpm build`; checkpoints run the complete suite.
- Existing dirty-worktree changes are preserved; no reset, checkout, or broad deletion is allowed.

## Baseline and Existing Boundaries

The current repository is a dirty transition snapshot. The current live path is
`src/app/run-live-audit.ts` -> `src/app/live-audit-runtime.ts` ->
`src/app/run-policy-task.ts` -> `src/runtime/ask-real-claude.ts` and
`src/runtime/local-session-loop.ts`. Search/fetch implementations are split
between `src/search-fusion`, `src/fetch-fusion`, and the vendored
`vendor/search-mcp` worker. Domain-specific state and reports are in
`src/policy-task`, `src/policy-scanner`, `src/engine`, and `src/artifacts`.

The implementation must first create a generic path alongside these surfaces,
then switch composition roots to it. Legacy modules remain available until
compatibility tests prove that they are no longer on the generic path.

## Phase 1: Contracts and Characterization

### Task 1: Freeze the current transition snapshot

**Files:**
- Create: `docs/audits/2026-08-03-generic-agent-baseline.md`
- Inspect: `package.json`, `src/app/run-live-audit.ts`, `src/app/run-policy-task.ts`, `src/runtime/ask-real-claude.ts`, `src/runtime/local-session-loop.ts`
- Test: existing full suite

**Interfaces:**
- Produces a written baseline of current entrypoints, commands, dirty-worktree limits, and known runtime probes.

- [ ] **Step 1: Record baseline commands and results**

Run:

```bash
pnpm build
pnpm test
pnpm test:fixture
```

Record exact counts and any environment/network limitations in the audit file.

- [ ] **Step 2: Record current runtime wiring**

Trace the default calls from `run-live-audit.ts` to the model, search, fetch,
workspace, and report boundaries. Label each claim `OBSERVED`, `DOCUMENTED`, or
`UNKNOWN`.

- [ ] **Step 3: Add no implementation changes**

Verify `git diff --stat` contains no changes from this task except the baseline
document.

- [ ] **Step 4: Verify**

Run `pnpm build && pnpm test` and confirm the baseline does not alter behavior.

### Task 2: Add generic domain-neutral types

**Files:**
- Create: `src/agent/types.ts`
- Create: `src/llm/provider.ts`
- Create: `src/search/provider.ts`
- Create: `src/fetch/provider.ts`
- Create: `src/evidence/types.ts`
- Test: `__tests__/agent/types.test.ts`

**Interfaces:**

```ts
export interface ResearchTask {
  question: string;
  options?: {
    maxIterations?: number;
    maxSearchActionsPerTurn?: number;
    maxFetchActionsPerTurn?: number;
    locale?: string;
    outputFormat?: 'json' | 'markdown';
  };
}

export interface AgentDecision {
  decision: 'search' | 'fetch' | 'review' | 'finish';
  reasoning?: string;
  searchActions: Array<{ query: string }>;
  fetchActions: Array<{ url: string }>;
  uncertainties: string[];
  finalAnswer?: unknown;
}

export interface LlmProvider {
  complete(input: {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    signal?: AbortSignal;
  }): Promise<{ text: string; model?: string; usage?: unknown }>;
}
```

Tool providers must return transport facts and never domain verdicts. Evidence
types must support requested URL, final URL, title, content, backend, outcome,
status, content type, truncation, warnings, timing, and retry metadata.

- [ ] **Step 1: Write failing type/shape tests** for valid task, decision,
  tool-outcome, and provider records.
- [ ] **Step 2: Run focused tests** with `pnpm exec tsx --test __tests__/agent/types.test.ts` and verify failure.
- [ ] **Step 3: Implement the minimal interfaces and literal unions.**
- [ ] **Step 4: Run focused tests and `pnpm build`.**

### Task 3: Create one canonical decision protocol

**Files:**
- Create: `src/agent/decision-protocol.ts`
- Modify: `src/runtime/decision-protocol.ts` only to delegate or mark compatibility
- Test: `__tests__/agent/decision-protocol.test.ts`

**Interfaces:**

```ts
export function parseAgentDecision(raw: string):
  | { ok: true; decision: AgentDecision }
  | { ok: false; error: { code: string; scope: 'json' | 'decision' | 'action'; message: string } };
```

The parser accepts only canonical `search`, `fetch`, `review`, and `finish`
decisions. Unknown legacy aliases remain in an explicit compatibility function,
never in the generic agent loop.

- [ ] **Step 1: Write failing tests** for valid decisions, unknown decisions,
  malformed JSON, invalid URLs, invalid queries, and sibling action isolation.
- [ ] **Step 2: Run the focused test file and verify failure.**
- [ ] **Step 3: Implement strict parsing without converting errors to `finish`.**
- [ ] **Step 4: Run focused tests and `pnpm build`.**

## Checkpoint: Contracts

- [ ] Generic types compile.
- [ ] Canonical protocol tests pass.
- [ ] Existing suite still passes.
- [ ] No domain-specific fields appear in the new contracts.

## Phase 2: Generic Agent Execution

### Task 4: Extract the action executor

**Files:**
- Create: `src/agent/action-executor.ts`
- Create: `src/agent/agent-state.ts`
- Test: `__tests__/agent/action-executor.test.ts`

**Interfaces:**

```ts
export interface AgentDependencies {
  llm: LlmProvider;
  search: SearchProvider;
  fetch: FetchProvider;
  onEvent?: (event: AgentEvent) => void;
}

export function executeAgentAction(
  state: AgentState,
  decision: AgentDecision,
  dependencies: AgentDependencies,
  signal?: AbortSignal,
): Promise<AgentState>;
```

The executor runs model actions in order, preserves successful siblings, records
technical failures, and never applies evidence or business gates.

- [ ] **Step 1: Write failing tests** for serial ordering, partial success,
  timeout, cancellation, retry metadata, and no business rewrite.
- [ ] **Step 2: Run focused tests and verify failure.**
- [ ] **Step 3: Implement the executor using the new provider contracts.**
- [ ] **Step 4: Run focused tests and `pnpm build`.**

### Task 5: Extract the generic agent loop

**Files:**
- Create: `src/agent/agent-loop.ts`
- Create: `src/agent/termination.ts`
- Test: `__tests__/agent/agent-loop.test.ts`

**Interfaces:**

```ts
export function runResearchAgent(
  task: ResearchTask,
  dependencies: AgentDependencies,
  options?: { signal?: AbortSignal; systemPrompt?: string },
): Promise<AgentResult>;
```

The loop builds model messages from generic state, parses the canonical
decision, executes actions, and returns model finish or technical interruption.
`maxIterations` is a resource limit only.

- [ ] **Step 1: Write failing tests** for search -> fetch -> review -> finish,
  model finish without actions, malformed model output, max-iteration
  interruption, and external abort.
- [ ] **Step 2: Run focused tests and verify failure.**
- [ ] **Step 3: Implement the loop on top of the executor.**
- [ ] **Step 4: Run focused tests and `pnpm build`.**

### Task 6: Move LLM access behind providers

**Files:**
- Create: `src/llm/openai-compatible.ts`
- Create: `src/llm/anthropic.ts`
- Modify: `src/runtime/nanoclaw-bridge.ts` to become an adapter or delegate
- Modify: `src/runtime/ask-real-claude.ts` to use `LlmProvider` through a
  compatibility boundary
- Test: `__tests__/llm/providers.test.ts`

- [ ] **Step 1: Write failing provider contract tests** with deterministic fake
  HTTP responses, abort, timeout, and malformed response cases.
- [ ] **Step 2: Run focused tests and verify failure.**
- [ ] **Step 3: Implement provider adapters and keep API keys out of core state.**
- [ ] **Step 4: Run focused tests and `pnpm build`.**

## Phase 3: Provider and Evidence Extraction

### Task 7: Move search fusion behind generic providers

**Files:**
- Create: `src/search/service.ts`
- Create: `src/search/normalization.ts`
- Modify: `src/search-fusion/*` through adapters only
- Test: `__tests__/search/service.test.ts`, `__tests__/search/real-provider-matrix.test.ts`

- [ ] **Step 1: Write failing tests** for provider ordering, result
  normalization, duplicate URL handling, provider failure, and empty results.
- [ ] **Step 2: Run focused tests and verify failure.**
- [ ] **Step 3: Implement provider-neutral search service.**
- [ ] **Step 4: Run focused tests and one explicit external provider probe.**

The service may expose rank and provider metadata, but must not assign domain
quality or officiality.

### Task 8: Move fetch and browser fallback behind generic providers

**Files:**
- Create: `src/fetch/service.ts`
- Create: `src/fetch/static-fetch.ts`
- Move/adapt: `src/fetch-fusion/local-fetch-primary.ts`, `browser-fetch.ts`,
  `network-safety.ts`
- Test: `__tests__/fetch/service.test.ts`, `__tests__/fetch/real-fetch-matrix.test.ts`

- [ ] **Step 1: Write failing tests** for HTTP success, empty body, weak
  extraction, redirect, SSRF rejection, browser fallback, timeout, and abort.
- [ ] **Step 2: Run focused tests and verify failure.**
- [ ] **Step 3: Implement explicit transport outcomes and extraction warnings.**
- [ ] **Step 4: Run focused tests and real fetch probes against stable public URLs.**

An HTTP 200 response with only footer/navigation or below-threshold extracted
content must be represented as weak/empty extraction facts, never as a domain
success.

## Checkpoint: Core Agent

- [ ] Generic agent completes a fake multi-round research task.
- [ ] LLM, search, and fetch dependencies are swappable.
- [ ] Technical interruptions are distinguishable from model finish.
- [ ] Provider tests and real probes pass or record explicit environment limits.

## Phase 4: Shared Application Service and Hosts

### Task 9: Add the application composition root

**Files:**
- Create: `src/app/run-agent.ts`
- Create: `src/evidence/store.ts`
- Modify: `src/app/index.ts`
- Test: `__tests__/app/run-agent.test.ts`

- [ ] **Step 1: Write failing tests** proving direct application invocation
  uses one shared result shape and optional persistence.
- [ ] **Step 2: Run focused tests and verify failure.**
- [ ] **Step 3: Implement composition of LLM, search, fetch, and evidence store.**
- [ ] **Step 4: Run focused tests and `pnpm build`.**

### Task 10: Add MCP adapter

**Files:**
- Create: `src/adapters/mcp/server.ts`
- Create: `src/adapters/mcp/tools.ts`
- Test: `__tests__/adapters/mcp.test.ts`

- [ ] **Step 1: Write failing tests** for `research`, `search`, `fetch`,
  structured results, malformed input, and tool errors.
- [ ] **Step 2: Run focused tests and verify failure.**
- [ ] **Step 3: Implement thin MCP translation to `runAgent`.**
- [ ] **Step 4: Run focused tests and launch the local MCP server with a fake provider.**

### Task 11: Add HTTP adapter

**Files:**
- Create: `src/adapters/http/server.ts`
- Create: `src/adapters/http/routes.ts`
- Create/modify: `package.json` only if an existing dependency cannot serve HTTP
- Test: `__tests__/adapters/http.test.ts`

- [ ] **Step 1: Write failing tests** for `POST /v1/research`, `POST /v1/search`,
  `POST /v1/fetch`, health, invalid JSON, request timeout, and abort.
- [ ] **Step 2: Run focused tests and verify failure.**
- [ ] **Step 3: Implement the HTTP adapter using Node's existing HTTP APIs unless
  the repository already has a framework requirement.**
- [ ] **Step 4: Run focused tests and launch the server locally.**

## Phase 5: Legacy Isolation and Acceptance

### Task 12: Remove domain logic from the generic default path

**Files:**
- Modify: `src/app/run-live-audit.ts`
- Modify: `src/app/run-policy-task.ts`
- Modify: `src/policy-task/*` only where compatibility types block the generic path
- Modify: `src/policy-scanner/*` only to mark or isolate legacy entrypoints
- Modify: `src/artifacts/*` only to remove generic-path domain reports
- Test: `__tests__/legacy/default-path-isolation.test.ts`

- [ ] **Step 1: Write failing isolation tests** proving the generic path does
  not import policy scanner, early-access target gates, or NanoClaw-specific
  lifecycle code.
- [ ] **Step 2: Run focused tests and verify failure.**
- [ ] **Step 3: Switch the default composition root to generic agent services.**
- [ ] **Step 4: Keep legacy CLI behavior behind an explicit compatibility entrypoint.**
- [ ] **Step 5: Run the focused suite and inspect the dependency graph.**

### Task 13: Real end-to-end acceptance matrix

**Files:**
- Create: `scripts/real-agent-matrix.ts`
- Create: `docs/audits/2026-08-03-generic-agent-acceptance.md`
- Test: `__tests__/acceptance/generic-agent.test.ts`

- [ ] **Step 1: Define three tasks:** a generic factual question, a multi-source
  comparison, and a page requiring fetch after discovery.
- [ ] **Step 2: Run each task through direct app, MCP, and HTTP adapters.**
- [ ] **Step 3: Record candidates, fetch outcomes, citations, retries, latency,
  interruptions, and final model output.**
- [ ] **Step 4: Mark failures by layer: LLM, search, fetch, extraction, agent
  protocol, adapter, or persistence.**
- [ ] **Step 5: Run `pnpm build`, `pnpm test`, and `pnpm test:fixture`.**

## Final Checkpoint

- [ ] The generic agent is the default application path.
- [ ] MCP and HTTP adapters call the same application service.
- [ ] Domain-specific code is isolated from generic core execution.
- [ ] At least one real research task succeeds through every host.
- [ ] Technical failures remain visible and are not converted into successful
  business conclusions.
- [ ] Documentation describes the actual generic agent path.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Current worktree contains a large uncommitted transition | High | Preserve the backup, isolate new generic modules, and verify diffs after every task. |
| Existing tests encode domain behavior | High | Add generic characterization tests before removing or changing old contracts. |
| LLM provider response formats differ | High | Strict provider adapters with deterministic contract tests. |
| Search providers are unreliable or blocked | High | Provider matrix, explicit transport outcomes, bounded fallback, and real probes. |
| HTTP and MCP adapters drift | Medium | Route both through the same application service and compare result fixtures. |
| Legacy code remains reachable accidentally | High | Import-level isolation tests and explicit compatibility entrypoints. |
| Browser dependency is optional or unavailable | Medium | Static extraction remains available; weak extraction is reported transparently. |
