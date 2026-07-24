# Live Audit Reliability and Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live audit observable and bounded, add model fallback retries, guarantee terminal artifacts, and rerun the mainland-China AI early-access audit.

**Architecture:** Keep the existing policy loop and MCP adapters, adding a small reusable timeout/retry/stage-observability layer at the runtime boundaries. Every stage emits timestamped start/heartbeat/end/timeout/failure events to the existing live log and debug trace; model calls retry transient failures and switch only to a configured, preflight-validated fallback model. Completion and failure are persisted before the process exits.

**Tech Stack:** TypeScript, Node `fetch`/`AbortController`, MCP stdio transport, `tsx`, Node test runner, pnpm.

---

### Task 1: Add timeout and retry primitives

**Files:**
- Create: `src/runtime/reliability.ts`
- Test: `__tests__/runtime/reliability.test.ts`

- [ ] **Step 1: Write failing tests** for `withTimeout`, retry delay calculation, and retryable error classification.
- [ ] **Step 2: Run `pnpm test -- __tests__/runtime/reliability.test.ts` and verify failure.**
- [ ] **Step 3: Implement typed timeout errors, AbortController-aware `withTimeout`, bounded retry helper, and deterministic exponential backoff with jitter injection.**
- [ ] **Step 4: Run the focused tests and verify they pass.**
- [ ] **Step 5: Commit `feat: add runtime timeout and retry primitives`.**

### Task 2: Instrument the live audit lifecycle

**Files:**
- Modify: `src/app/live-audit-runtime.ts`
- Test: `__tests__/app/live-audit-runtime.test.ts`

- [ ] **Step 1: Add failing tests** asserting stage events contain ISO timestamps, duration, heartbeat, terminal `run.complete`, and `run.failure` persistence.
- [ ] **Step 2: Run the focused tests and verify failure.**
- [ ] **Step 3: Add configurable timeout/heartbeat settings to `LiveAuditEnv`, a stage runner that emits `stage.start`, periodic `stage.heartbeat`, `stage.end`, `stage.timeout`, and `stage.failure`, and a final summary writer.**
- [ ] **Step 4: Wrap preflight and policy-loop execution in stage instrumentation; emit `run.complete` after the result is durably written and `run.failure` on every failure path.**
- [ ] **Step 5: Run focused tests and the existing live-audit tests.**
- [ ] **Step 6: Commit `feat: persist live audit stage timeline and terminal status`.**

### Task 3: Add model wall-clock timeout and fallback model switching

**Files:**
- Modify: `src/runtime/nanoclaw-bridge.ts`
- Modify: `src/app/live-audit-runtime.ts`
- Test: `__tests__/runtime/nanoclaw-bridge.test.ts`
- Test: `__tests__/app/live-audit-runtime.test.ts`

- [ ] **Step 1: Write failing tests** for fetch abort on model timeout, retry after transient timeout/status, and switch to a configured fallback model only after the primary retry budget is exhausted.
- [ ] **Step 2: Run focused tests and verify failure.**
- [ ] **Step 3: Extend runtime config with optional fallback model and timeout/retry settings; validate fallback model against the gateway model list during provenance preflight.**
- [ ] **Step 4: Implement AbortController request deadlines, retry events, and `fallback.switch` events while preserving existing empty-response diagnostics.**
- [ ] **Step 5: Run focused bridge/runtime tests and the complete unit suite.**
- [ ] **Step 6: Commit `feat: add bounded model retries and validated fallback`.**

### Task 4: Bound search, Fetch, Playwright, and MCP shutdown

**Files:**
- Modify: `src/runtime/search-mcp-tool-adapter.ts`
- Modify: `src/app/run-policy-task.ts`
- Modify: `src/runtime/local-session-loop.ts`
- Modify: `src/fetch-fusion/browser-fetch.ts`
- Test: `__tests__/runtime/search-mcp-tool-adapter.test.ts`
- Test: `__tests__/app/policy-loop-behavior.test.ts`
- Test: `__tests__/fetch-fusion/browser-fetch.test.ts`

- [ ] **Step 1: Add failing tests** proving search/fetch calls reject at the configured wall-clock deadline, retry transient MCP calls, and MCP close cannot block finalization.
- [ ] **Step 2: Run focused tests and verify failure.**
- [ ] **Step 3: Wrap tool calls with the shared timeout/retry helper and emit per-action stage events with iteration, URL/query, attempt, and duration.**
- [ ] **Step 4: Ensure Playwright timeout errors are recorded as Fetch warnings and do not leave browser processes open.**
- [ ] **Step 5: Run focused tests and the full suite.**
- [ ] **Step 6: Commit `feat: bound external audit stages and MCP cleanup`.**

### Task 5: Verify, launch, and report

**Files:**
- Modify: `README.md` and `README.zh.md` only if runtime environment variables need documentation.
- Create at runtime: `/Users/lingion/.local-policy-agent/live-audit-cn-hotspot-reliable-rerun/`

- [ ] **Step 1: Run `pnpm build` and `pnpm test`; record exact results.**
- [ ] **Step 2: Launch the audit with explicit output directory, date window, browser setting, timeout, heartbeat, primary model, and a gateway-listed fallback model.**
- [ ] **Step 3: Monitor `live.log` and `debug-trace.json` by timestamps, verifying no silent interval exceeds the heartbeat threshold without a stage heartbeat.**
- [ ] **Step 4: Wait for `run.complete` or `run.failure`; inspect all generated artifacts and count candidates, fetched evidence, validated hotspots, fallback uses, failures, and stage durations.**
- [ ] **Step 5: Produce a Chinese report containing the prior run's seven fetched official pages, the new run's complete results, and a separate section listing every observed stall point and remediation.**
