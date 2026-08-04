# Model-Owned Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `local-policy-agent` so the model owns every business decision while runtime/tools provide only protocol execution, transport reliability, transparent facts, persistence, and recovery, then validate the result with real multi-round tool calls.

**Architecture:** Keep the model-facing policy prompt and tool adapters, but replace business-gated loop transitions with a decision-neutral executor. A dedicated protocol layer validates only executable shape and returns structured errors; a transport layer performs bounded-per-attempt retries and technical fallback while exposing every attempt; an append-only event journal and model projection support replay, cancellation, and recovery. Business interpretation remains in the model and is never inferred from target counts, dates, domains, scores, or page counts by runtime.

**Tech Stack:** TypeScript, Node.js test runner via `tsx --test`, vendored Search MCP stdio worker, existing `FetchTool`/`SearchTool` interfaces, existing dotenv/runtime configuration, JSONL/JSON artifacts.

---

## File Map

Create focused modules:

- `src/runtime/decision-protocol.ts`: wire types, minimal executable-shape validation, protocol-error structures, and explicit `final_package` mapping.
- `src/runtime/action-executor.ts`: serial action execution, action/attempt IDs, partial results, cancellation, and retry event hooks.
- `src/runtime/tool-retry.ts`: transport retry classification, backoff, retry metadata, and abort-aware attempt execution.
- `src/runtime/model-turn-projection.ts`: model-visible state projection with secret/internal-field exclusion.
- `src/runtime/event-journal.ts`: append-only event writer, sequence IDs, replay helpers, and incomplete-attempt recovery markers.
- `__tests__/runtime/decision-protocol.test.ts`: protocol-only tests.
- `__tests__/runtime/action-executor.test.ts`: executor tests with deterministic fake tools for protocol behavior only.
- `__tests__/runtime/tool-retry.test.ts`: transport retry tests.
- `__tests__/runtime/model-turn-projection.test.ts`: projection and redaction tests.
- `__tests__/runtime/event-journal.test.ts`: append/replay/recovery tests.
- `scripts/real-tool-matrix.ts`: real Search MCP/fetch/fallback probe runner; never used as a fake unit test.
- `artifacts/tool-matrix/README.md`: format and interpretation of real probe artifacts.
- `docs/audits/2026-07-25-p0-p3-reaudit.md`: evidence-based post-change audit report.

Modify existing modules:

- `src/app/run-policy-task.ts`: remove target/date/quality/convergence business gates and delegate to the neutral executor.
- `src/runtime/local-session-loop.ts`: stop applying model evidence classifications, stop forcing phase decisions, and return transparent action/protocol results.
- `src/runtime/ask-real-claude.ts`: strict wire parsing, no implicit stop, no raw-output injection into business package, and explicit model failure reporting.
- `src/runtime/search-mcp-tool-adapter.ts`: preserve MCP/HTTP/empty/error facts and integrate transport retry/fallback hooks.
- `src/runtime/tool-registry.ts`: extend result/error types without adding business categories.
- `src/runtime/context-governor.ts`: remove business scoring/pruning; use only size/secret/resource-safe projection.
- `src/app/live-audit-runtime.ts` and `src/app/run-live-audit.ts`: persist accurate lifecycle status, event journal references, cancellation/failure state, and model-owned final decision without rewriting it.
- `src/policy-task/output-schema.ts` and `src/policy-task/state-schema.ts`: align canonical wire fields and transport-visible state.
- `package.json`: add real-tool probe scripts only if they do not alter the normal test path.
- `README.md`, `README.zh.md`, and `docs/PRODUCTION_READY.md`: document model authority, transport retry semantics, required real probes, and the distinction between complete transport execution and model business outcome.

---

### Task 1: Freeze the authority boundary in types and tests

**Files:**
- Modify: `src/policy-task/output-schema.ts`
- Modify: `src/policy-task/state-schema.ts`
- Create: `src/runtime/decision-protocol.ts`
- Test: `__tests__/runtime/decision-protocol.test.ts`

- [ ] **Step 1: Write failing protocol tests**

Add tests proving:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDecisionEnvelope } from '../../src/runtime/decision-protocol.ts';

test('keeps a valid model decision and final_package without business rewriting', () => {
  const result = parseDecisionEnvelope(JSON.stringify({
    decision: 'continue_search',
    searchActions: [{ query: '国内工具', why: 'model choice' }],
    fetchActions: [],
    final_package: null,
    extraModelField: { keep: true },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.decision?.decision, 'continue_search');
  assert.deepEqual(result.decision?.searchActions, [{ query: '国内工具', why: 'model choice' }]);
  assert.equal((result.decision as Record<string, unknown>).extraModelField, undefined);
  assert.equal(result.decision?.finalPackage, null);
});

test('returns a protocol error instead of converting an unknown decision to stop', () => {
  const result = parseDecisionEnvelope(JSON.stringify({ decision: 'maybe', searchActions: [], fetchActions: [] }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.scope, 'decision');
  assert.equal(result.error?.code, 'UNKNOWN_DECISION');
});

test('rejects only malformed actions and accepts valid sibling actions', () => {
  const result = parseDecisionEnvelope(JSON.stringify({
    decision: 'continue_fetch',
    searchActions: [],
    fetchActions: [{ why: 'missing url' }, { url: 'https://example.com', why: 'valid' }],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.actionErrors?.length, 1);
  assert.deepEqual(result.decision?.fetchActions, [{ url: 'https://example.com', why: 'valid' }]);
});
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run:

```bash
./node_modules/.bin/tsx --test __tests__/runtime/decision-protocol.test.ts
```

Expected: FAIL because the protocol module and neutral parsing behavior do not exist.

- [ ] **Step 3: Implement the minimum protocol module**

Define canonical wire decisions, `ProtocolError`, `DecisionEnvelope`, and `parseDecisionEnvelope(raw: string)`. Accept the five existing decision strings only as a protocol enum, map only `final_package` to the internal `finalPackage` field, preserve its value unchanged, and never synthesize a decision. For malformed top-level JSON or unknown decision return `{ ok: false, error }`; for malformed sibling actions remove only those malformed actions and return `actionErrors`.

- [ ] **Step 4: Align shared types with the module**

Make `finalPackage` typed as the wire package value (`unknown | null`) only at the protocol boundary and keep business interpretation out of runtime types. Add transport facts and protocol-error types to the state without adding `official`, `noise`, `early_access`, `target_met`, or `should_stop` runtime fields.

- [ ] **Step 5: Run the focused test and commit**

Run the focused command again; expected: all protocol tests PASS.

```bash
git add src/policy-task/output-schema.ts src/policy-task/state-schema.ts src/runtime/decision-protocol.ts __tests__/runtime/decision-protocol.test.ts
git commit -m "refactor: make model decisions protocol-preserving"
```

---

### Task 2: Replace business-gated loop transitions with neutral execution

**Files:**
- Modify: `src/app/run-policy-task.ts:38-189`
- Modify: `src/runtime/local-session-loop.ts:6-261`
- Modify: `src/runtime/context-governor.ts:1-80`
- Test: `__tests__/app/policy-loop-behavior.test.ts`
- Test: `__tests__/runtime/action-executor.test.ts`

- [ ] **Step 1: Add failing authority tests**

Add tests that feed a model decision of `continue_search`, `continue_fetch`, and `summarize_and_stop` through the loop and assert that runtime returns that exact decision; also feed a result with fewer than any configured target and assert no runtime-generated `insufficient_target_count` gate or forced continuation is emitted. Add a test that a model `summarize_and_stop` remains unchanged even when the state has no fetched evidence.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
./node_modules/.bin/tsx --test __tests__/app/policy-loop-behavior.test.ts __tests__/runtime/action-executor.test.ts
```

Expected: current phase/target logic changes or overrides the asserted model decisions.

- [ ] **Step 3: Remove business gates from the loop**

Delete or bypass `countValidatedEvidence`, `withConvergencePhase`, `targetHotspotCount` shortfall returns, and `termination-policy` business termination from the model execution path. Keep configuration values only as task data exposed to the model if needed. Do not compute early-access result counts in the runtime loop. Do not force `post_convergence_review` or `final_summary` transitions. Do not apply model `evidenceAssessments` to mutate page business quality in runtime.

- [ ] **Step 4: Make context governance transport-only**

Replace candidate scoring/pruning with deterministic resource projection only: omit secrets/internal fields, enforce byte/entry limits as explicit truncation facts, and preserve the complete state in the journal. Do not rank candidates or select an anchor based on business value.

- [ ] **Step 5: Run focused and existing loop tests**

Run:

```bash
./node_modules/.bin/tsx --test __tests__/app/policy-loop-behavior.test.ts __tests__/runtime/action-executor.test.ts
```

Expected: new authority tests pass; update old tests whose assertions encode removed runtime business gates so they assert model decision preservation instead.

- [ ] **Step 6: Commit**

```bash
git add src/app/run-policy-task.ts src/runtime/local-session-loop.ts src/runtime/context-governor.ts __tests__/app/policy-loop-behavior.test.ts __tests__/runtime/action-executor.test.ts
git commit -m "refactor: remove runtime business decision gates"
```

---

### Task 3: Add action IDs and serial neutral executor

**Files:**
- Create: `src/runtime/action-executor.ts`
- Modify: `src/runtime/tool-registry.ts`
- Test: `__tests__/runtime/action-executor.test.ts`

- [ ] **Step 1: Write failing executor tests**

Cover these exact cases:

```ts
test('executes valid sibling actions in model order and preserves partial failures', async () => {
  // search #1 succeeds, search #2 returns a transport error, fetch #3 succeeds;
  // assert all three action results are returned and order is preserved.
});

test('does not silently deduplicate a repeated model action', async () => {
  // two identical fetch actions receive distinct actionIds and both execute.
});

test('does not execute malformed actions and returns action-scoped protocol errors', async () => {
  // malformed fetch is reported; valid sibling fetch still executes.
});
```

Use deterministic fake tools only for executor unit behavior; do not claim these are real-tool validation.

- [ ] **Step 2: Run tests and verify failure**

```bash
./node_modules/.bin/tsx --test __tests__/runtime/action-executor.test.ts
```

Expected: FAIL because stable IDs, partial result envelopes, and neutral execution are absent.

- [ ] **Step 3: Implement the executor**

Implement serial execution in emitted order. Generate `decisionId` per model turn, `actionId` per action, and `attemptId` per attempt. Return per-action statuses and errors. Preserve valid siblings when another action is malformed or fails. Do not invoke any target, date, evidence, domain, score, or final-decision helper.

- [ ] **Step 4: Verify and commit**

```bash
./node_modules/.bin/tsx --test __tests__/runtime/action-executor.test.ts
git add src/runtime/action-executor.ts src/runtime/tool-registry.ts __tests__/runtime/action-executor.test.ts
git commit -m "feat: add model-driven serial action executor"
```

---

### Task 4: Implement transparent transport retry and technical fallback

**Files:**
- Create: `src/runtime/tool-retry.ts`
- Modify: `src/runtime/search-mcp-tool-adapter.ts`
- Modify: `src/runtime/tool-registry.ts`
- Test: `__tests__/runtime/tool-retry.test.ts`

- [ ] **Step 1: Write failing transport tests**

Test only transport facts:

```ts
test('retries transient errors and exposes every attempt', async () => {
  // tool fails with 503 twice, succeeds on third call;
  // assert three attempts, exponential delay hook calls, and final success.
});

test('does not retry a non-transient 401 as a business decision', async () => {
  // assert one attempt with http_error and retryable false; no stop decision is produced.
});

test('preserves empty content as success_empty and allows technical fallback', async () => {
  // primary returns 200 with empty body, fallback returns content;
  // assert both backend attempts are retained under one actionId.
});
```

- [ ] **Step 2: Run tests and verify failure**

```bash
./node_modules/.bin/tsx --test __tests__/runtime/tool-retry.test.ts
```

Expected: FAIL because current adapter maps empty/error responses into insufficiently typed page records and has no attempt envelope.

- [ ] **Step 3: Implement retry facts**

Classify only transport conditions such as connection reset, DNS temporary failure, timeout, 429, and 502/503/504 as retryable. Use AbortSignal and a configurable per-attempt timeout. Emit attempt start/result/error/retry-scheduled events. Never synthesize a business decision after retries.

- [ ] **Step 4: Preserve backend outcomes**

Represent Search MCP, direct HTTP, and browser fallback as separate attempts sharing `actionId` but using distinct `attemptId` and `backend`. Preserve empty body, HTTP status, final URL, content type, truncation, and structured errors.

- [ ] **Step 5: Verify and commit**

```bash
./node_modules/.bin/tsx --test __tests__/runtime/tool-retry.test.ts
git add src/runtime/tool-retry.ts src/runtime/search-mcp-tool-adapter.ts src/runtime/tool-registry.ts __tests__/runtime/tool-retry.test.ts
git commit -m "feat: expose transparent tool retries and fallback"
```

---

### Task 5: Separate model failures and raw output from business output

**Files:**
- Modify: `src/runtime/ask-real-claude.ts`
- Modify: `src/policy-task/output-schema.ts`
- Test: `__tests__/runtime/real-ask-agent.test.ts`

- [ ] **Step 1: Add failing model protocol tests**

Cover:

- unknown decision returns protocol error, never `stop`;
- empty output returns model transport/protocol failure;
- truncated JSON is recorded as parse failure;
- valid `final_package` is preserved as the package only;
- `_raw_model_output` is absent from `finalPackage`;
- `stop_reason`/refusal/tool-use non-text responses are surfaced as model-call facts.

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
./node_modules/.bin/tsx --test __tests__/runtime/real-ask-agent.test.ts
```

Expected: current fallback and normalization behavior fails at least the unknown-decision, raw-output, and package-shape assertions.

- [ ] **Step 3: Implement strict model call handling**

Keep `rawText` only in `model.raw_output` debug events and a separately persisted redacted diagnostic field. Parse through `parseDecisionEnvelope`. Do not fallback unknown/empty output to `stop`. Inspect response stop reason and content block types. Return structured model failure to the outer runtime when no valid decision exists.

- [ ] **Step 4: Verify and commit**

```bash
./node_modules/.bin/tsx --test __tests__/runtime/real-ask-agent.test.ts
git add src/runtime/ask-real-claude.ts src/policy-task/output-schema.ts __tests__/runtime/real-ask-agent.test.ts
git commit -m "fix: preserve model decisions and isolate raw output"
```

---

### Task 6: Add model projection, redaction, append-only journal, and recovery

**Files:**
- Create: `src/runtime/model-turn-projection.ts`
- Create: `src/runtime/event-journal.ts`
- Modify: `src/app/live-audit-runtime.ts`
- Modify: `src/app/run-live-audit.ts`
- Test: `__tests__/runtime/model-turn-projection.test.ts`
- Test: `__tests__/runtime/event-journal.test.ts`

- [ ] **Step 1: Write failing projection and journal tests**

Projection tests must prove API keys, cookies, authorization headers, filesystem paths, PIDs, and retry timers are absent while URLs, body, status, content length, truncation, retry facts, and protocol errors remain. Journal tests must prove ordered append, unique sequence/event IDs, replay, duplicate-event idempotence, and interrupted attempt detection when an attempt has a start but no terminal event.

- [ ] **Step 2: Run tests and confirm failure**

```bash
./node_modules/.bin/tsx --test __tests__/runtime/model-turn-projection.test.ts __tests__/runtime/event-journal.test.ts
```

Expected: FAIL because current prompt state serializes internal runtime state and trace persistence rewrites the complete document per event.

- [ ] **Step 3: Implement projection and redaction**

Define `ModelTurnInput` and explicitly copy only business-relevant task/action/attempt/tool facts. Redact secrets before both model projection and ordinary logs. Keep raw model output out of the business package.

- [ ] **Step 4: Implement append-only event persistence**

Write one event record per append with sequence and stable IDs. Replay events in sequence order. Mark an action with `attempt.start` and no terminal attempt event as `interrupted`; expose that fact to the model without choosing retry or stop. Ensure duplicate event IDs do not duplicate state during replay.

- [ ] **Step 5: Update live runtime status**

Persist `transport_complete`, `model_protocol_failure`, `cancelled`, and `runtime_failure` distinctly from the model's business decision. Never write `status=complete` merely because a model returned `summarize_and_stop`.

- [ ] **Step 6: Verify and commit**

```bash
./node_modules/.bin/tsx --test __tests__/runtime/model-turn-projection.test.ts __tests__/runtime/event-journal.test.ts
git add src/runtime/model-turn-projection.ts src/runtime/event-journal.ts src/app/live-audit-runtime.ts src/app/run-live-audit.ts __tests__/runtime/model-turn-projection.test.ts __tests__/runtime/event-journal.test.ts
git commit -m "feat: add redacted model projection and replayable event journal"
```

---

### Task 7: Run real Search MCP and fetch cross-check matrix

**Files:**
- Create: `scripts/real-tool-matrix.ts`
- Create: `artifacts/tool-matrix/README.md`
- Modify: `package.json` only to add `probe:tools` if needed

- [ ] **Step 1: Create the real probe runner**

The script must call the actual `createSearchMcpTools()` and record JSONL events for:

- ordinary Chinese search;
- domestic official-domain search;
- known-empty query;
- repeated identical query;
- Search MCP worker restart;
- successful official HTML fetch;
- empty-content URL;
- 404 and 403/challenge;
- redirect;
- non-HTML response;
- slow/timeout path;
- repeated URL;
- browser/direct fallback where configured.

Do not use fake tools in this script. Every case records request, attempt, backend, timing, status, content length, retry facts, and error details with secrets redacted.

- [ ] **Step 2: Run the matrix against the real worker**

Run:

```bash
./node_modules/.bin/tsx scripts/real-tool-matrix.ts --output artifacts/tool-matrix/run-<timestamp>.jsonl
```

Expected: the command reports each case as `success_with_content`, `success_empty`, `http_error`, `transport_error`, `timeout`, or `cancelled`; it must never label a transport result as `official`, `noise`, `early_access`, or `should_stop`.

- [ ] **Step 3: Repeat the matrix with a second backend/configuration**

Run once with the default Search MCP worker and once with the configured browser/direct fallback. Compare the same URL/query outcomes and preserve both runs. Do not hide provider differences.

- [ ] **Step 4: Add focused regressions for each discovered transport defect**

For every reproducible adapter defect, add a deterministic test that models the exact protocol/transport failure, then fix the adapter and rerun the real matrix. Do not add tests that encode business classifications.

- [ ] **Step 5: Commit probe tooling and verified adapter changes**

```bash
git add scripts/real-tool-matrix.ts artifacts/tool-matrix/README.md package.json src/runtime/search-mcp-tool-adapter.ts __tests__
git commit -m "test: add real search and fetch cross-check matrix"
```

---

### Task 8: Re-run the live audit with model authority and verify no interference

**Files:**
- Create: `artifacts/live-audit-model-owned/README.md`
- Modify: `src/app/run-live-audit.ts` only if CLI output needs neutral lifecycle fields
- Test: `__tests__/app/run-live-audit.test.ts`

- [ ] **Step 1: Add a regression test for exact decision preservation**

Use a model stub that returns `continue_search` despite zero candidates, `continue_fetch` after an empty fetch, and `summarize_and_stop` before a configured target. Assert runtime returns the exact model decisions and executes only the actions the model emitted.

- [ ] **Step 2: Run the regression and verify failure before implementation is complete**

```bash
./node_modules/.bin/tsx --test __tests__/app/run-live-audit.test.ts
```

Expected: the old target/convergence behavior fails these assertions before the Task 2 changes are applied; after all changes it must pass.

- [ ] **Step 3: Run the real model-owned live audit**

Use the existing gateway configuration without exposing credentials in logs. Save:

- raw event journal;
- model decision sequence;
- every tool attempt and retry;
- final model decision;
- neutral lifecycle status;
- tool matrix reference.

The runtime must not inject a target shortfall, force a phase, or replace a model decision in the resulting trace.

- [ ] **Step 4: Verify trace invariants**

Use `jq` assertions to confirm:

```bash
jq -e '[.events[] | select(.type == "model.parsed_decision")] | length > 0' artifacts/live-audit-model-owned/debug-trace.json
jq -e 'all(.events[] | select(.type == "tool.retry.scheduled") ; has("payload"))' artifacts/live-audit-model-owned/debug-trace.json
jq -e 'all(.events[] | select(.type == "run.complete") ; (.payload.decision != null))' artifacts/live-audit-model-owned/debug-trace.json
```

Then manually compare each `model.parsed_decision` with the subsequent action events; no action may be added, removed, or rewritten for business reasons.

- [ ] **Step 5: Commit verified runtime integration**

```bash
git add src/app/run-live-audit.ts __tests__/app/run-live-audit.test.ts artifacts/live-audit-model-owned/README.md
git commit -m "test: verify model-owned live audit execution"
```

---

### Task 9: Re-audit and document 50+ evidence-backed issues

**Files:**
- Create: `docs/audits/2026-07-25-p0-p3-reaudit.md`
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `docs/PRODUCTION_READY.md`

- [ ] **Step 1: Build an evidence table from code and real artifacts**

For each issue record exactly:

```text
ID
severity P0-P3
layer: model/runtime/tool/preprocessing/persistence/operational
model-owned or system-owned
failure scenario
file and line
real artifact or command evidence
status: confirmed/fixed/open
```

Do not report a model choice as a runtime bug. Report a runtime bug only when it violates the authority boundary or corrupts transport/protocol facts.

- [ ] **Step 2: Reclassify the previous 50 findings**

Move target count, date, official-source, early-access, and evidence sufficiency rules out of the runtime defect list when they are intentionally model-owned. Keep only defects where code prevents the model from deciding or hides facts from it. Reclassify empty fetches, malformed decisions, raw output contamination, missing retries, missing recovery, and inaccurate lifecycle status as system findings where reproduced.

- [ ] **Step 3: Add real-tool findings from the matrix**

Include only failures reproduced by `scripts/real-tool-matrix.ts` or directly confirmed in the live event journal. Distinguish provider-specific failures from adapter defects.

- [ ] **Step 4: Add a clear residual-risk section**

Document external provider instability, model quality limitations, prompt injection in fetched content, gateway dependency, missing browser capabilities, and any tests not run because of environment/install failures.

- [ ] **Step 5: Verify documentation consistency**

Search for stale claims that runtime enforces target counts, guarantees 20 results, or calls a run successful merely because it summarized. Replace those claims with the model-authority and transport-status semantics.

- [ ] **Step 6: Commit the audit**

```bash
git add docs/audits/2026-07-25-p0-p3-reaudit.md README.md README.zh.md docs/PRODUCTION_READY.md
git commit -m "docs: publish model-authority reliability re-audit"
```

---

## Verification Checklist

- [ ] Protocol tests pass without converting malformed or unknown decisions to `stop`.
- [ ] Runtime authority tests prove model decisions are returned unchanged.
- [ ] No runtime path applies target count, date, domain, evidence, or early-access business gates.
- [ ] Every automatic retry has a visible attempt event and stable IDs.
- [ ] Empty, error, timeout, redirect, truncation, and fallback facts remain distinguishable.
- [ ] Raw model output is not present in `final_package`.
- [ ] Secrets are absent from model projection and ordinary logs.
- [ ] Append-only event replay identifies incomplete attempts.
- [ ] Real Search MCP and fetch matrix has been run at least twice with cross-backend comparison.
- [ ] A real model-owned live audit has been run and its decision/action trace reviewed.
- [ ] The final P0-P3 audit includes only evidenced findings and explicitly labels model-owned behavior separately from system defects.
