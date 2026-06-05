# Local Authority Prioritization T1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a minimal prompt-only local-authority-first rule for industrial-park/district tasks, verify it with focused prompt tests, then rerun T1 live audit and inspect whether early fetch choices demote `miit.gov.cn` in favor of local authority links.

**Architecture:** This change stays prompt-only. The core work is a small protocol addition in `src/policy-task/prompt-builder.ts`, plus focused tests in `__tests__/policy-task/prompt-builder.test.ts` that lock the instruction text in place. Validation happens in two layers: prompt test coverage first, then a real `TARGET_TASK=T1` live-audit run to inspect early-round behavior.

**Tech Stack:** TypeScript, Node test runner via `tsx --test`, local CLI live-audit script via `pnpm run live-audit`.

---

## File Structure

- **Modify:** `/Users/lingion/repo-downloads/local-policy-agent/src/policy-task/prompt-builder.ts`
  - Single source of truth for Local Policy Agent system prompt.
  - Add the Local Authority Prioritization Strategy near the existing terminal/protocol area without changing schemas or runtime logic.

- **Modify:** `/Users/lingion/repo-downloads/local-policy-agent/__tests__/policy-task/prompt-builder.test.ts`
  - Prompt-contract regression coverage.
  - Add or refine a focused test asserting the new industrial-park/district prioritization language exists and preserves fallback flexibility.

- **Inspect runtime artifact/logs only:** `/Users/lingion/repo-downloads/local-policy-agent/.current-live-audit.stdout.log`
  - Confirm whether early-round `fetchActions` suppress or demote `miit.gov.cn`.

- **Optional inspection target after run:** generated live-audit transcript/artifact files under `/Users/lingion/repo-downloads/local-policy-agent/` if the run emits a more precise trace than `.current-live-audit.stdout.log`.

---

### Task 1: Lock the new prompt contract with a failing test

**Files:**
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/__tests__/policy-task/prompt-builder.test.ts`
- Test: `/Users/lingion/repo-downloads/local-policy-agent/__tests__/policy-task/prompt-builder.test.ts`

- [ ] **Step 1: Add or tighten the local-authority prioritization test**

```ts
test('policy prompt adds local authority prioritization for industrial park and district tasks', () => {
  const prompt = buildPolicyPrompt();

  assert.match(prompt, /LOCAL AUTHORITY PRIORITIZATION STRATEGY/i);
  assert.match(prompt, /When the task is scoped to a specific local administrative zone/i);
  assert.match(prompt, /AUTHORITY PRECEDENCE/i);
  assert.match(prompt, /MINISTRY-LEVEL NOISE SUPPRESSION/i);
  assert.match(prompt, /FALLBACK EXCEPTION/i);
  assert.match(prompt, /Do not fetch them in the early rounds unless you have exhausted all promising local links/i);
});
```

- [ ] **Step 2: Run the focused prompt test to verify the current repo state**

Run:
```bash
cd /Users/lingion/repo-downloads/local-policy-agent && pnpm test __tests__/policy-task/prompt-builder.test.ts
```

Expected:
- If the prompt text is already present exactly as asserted, PASS.
- If the wording differs or the rule is missing, FAIL with an `assert.match` mismatch naming the missing clause.

- [ ] **Step 3: Commit checkpoint if this step introduced test-only edits**

If git is available in this workspace:
```bash
git add __tests__/policy-task/prompt-builder.test.ts
git commit -m "test: lock local authority prioritization prompt"
```

If git is not available in this workspace, record that commit was skipped because `/Users/lingion/repo-downloads/local-policy-agent` is not an initialized git repository.

---

### Task 2: Apply the minimal prompt-only change

**Files:**
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/src/policy-task/prompt-builder.ts`
- Test: `/Users/lingion/repo-downloads/local-policy-agent/__tests__/policy-task/prompt-builder.test.ts`

- [ ] **Step 1: Add the Local Authority Prioritization Strategy block near the terminal/protocol region**

Insert or normalize this block in `buildPolicyPrompt()`:

```ts
'### ⚓ LOCAL AUTHORITY PRIORITIZATION STRATEGY (SCOPE: INDUSTRIAL PARK/DISTRICT)',
'When the task is scoped to a specific local administrative zone such as an Industrial Park, High-Tech District, or local bureau domain:',
'AUTHORITY PRECEDENCE: prioritize links belonging to the local authority domain or policy service area, such as 园区管委会, 科技局, 发改委, or 政策服务专区.',
'MINISTRY-LEVEL NOISE SUPPRESSION: treat ministry-level policy documents, meetings, and general news as Secondary/Low-Value Signals for localized audit tasks. Do not fetch them in the early rounds unless you have exhausted all promising local links.',
'FALLBACK EXCEPTION: you may only fallback to national pages if the local authority portal provides zero actionable clues or explicitly points to a national policy framework for execution.',
```

Placement rule:
- Keep it inside the returned prompt array.
- Keep it near the later decision/closure protocol area so it has high salience.
- Do not add new JSON fields, schema changes, or runtime-side ranking logic.

- [ ] **Step 2: Re-run the focused prompt test**

Run:
```bash
cd /Users/lingion/repo-downloads/local-policy-agent && pnpm test __tests__/policy-task/prompt-builder.test.ts
```

Expected:
- PASS for the local-authority prioritization test.
- No regressions in existing prompt-builder tests.

- [ ] **Step 3: Run the full test suite to catch collateral prompt regressions**

Run:
```bash
cd /Users/lingion/repo-downloads/local-policy-agent && pnpm test
```

Expected:
- PASS across the repository test suite.
- If unrelated long-running tests stall beyond 5 minutes, stop and diagnose instead of waiting indefinitely.

- [ ] **Step 4: Commit checkpoint for the prompt change**

If git is available in this workspace:
```bash
git add src/policy-task/prompt-builder.ts __tests__/policy-task/prompt-builder.test.ts
git commit -m "feat: prioritize local authority sources for zone tasks"
```

If git is not available in this workspace, record that commit was skipped because `/Users/lingion/repo-downloads/local-policy-agent` is not an initialized git repository.

---

### Task 3: Re-run T1 and inspect early-round fetch behavior

**Files:**
- Inspect: `/Users/lingion/repo-downloads/local-policy-agent/.env.live`
- Inspect: `/Users/lingion/repo-downloads/local-policy-agent/.current-live-audit.stdout.log`

- [ ] **Step 1: Clear stale live-audit logs so the next inspection is unambiguous**

Run:
```bash
cd /Users/lingion/repo-downloads/local-policy-agent && rm -f .current-live-audit.stdout.log .current-live-audit.stderr.log
```

Expected:
- Old rolling log files removed if present.
- No effect if they were already absent.

- [ ] **Step 2: Run the T1 live audit with the live environment**

Run:
```bash
cd /Users/lingion/repo-downloads/local-policy-agent && env $(cat .env.live | xargs) TARGET_TASK=T1 pnpm run live-audit
```

Expected:
- The command starts the real live-audit flow for T1.
- New `.current-live-audit.stdout.log` and `.current-live-audit.stderr.log` files appear or are rewritten.
- The run finishes within a normal smoke-test window; if it hangs beyond 5 minutes, treat it as blocked and switch to diagnosis.

- [ ] **Step 3: Inspect the earliest logged agent decisions for `fetchActions` ordering and `miit.gov.cn` presence**

Review:
- round 1 decision
- round 2 decision
- any early `searchActions`
- any early `fetchActions`

Success criteria:
- Local authority / park / district / local bureau URLs are fetched first when plausible local links exist.
- `miit.gov.cn` is absent from the first fetch round, or appears only after local-authority options are exhausted.
- The agent still produces executable actions and does not freeze or terminate prematurely.

Failure signals:
- first or second round fetches `miit.gov.cn` despite strong local candidates
- no actionable local fetches are emitted even when local candidates are visible
- the agent stops early or regresses into pure broad-search loops

- [ ] **Step 4: Record the audit outcome in a short implementation note**

Capture:
- whether the prompt patch changed early fetch prioritization
- whether `miit.gov.cn` was suppressed, demoted, or still fetched too early
- whether the broader stop/search/fetch contract remained intact

Suggested note template:

```md
T1 rerun result:
- Round 1 fetch behavior: <summary>
- Round 2 fetch behavior: <summary>
- miit.gov.cn status: <suppressed | demoted | still early>
- Contract health: <intact | regressed>
- Next action if needed: <none | refine wording | inspect search recall>
```

- [ ] **Step 5: Commit checkpoint for audit artifacts only if they are meant to be versioned**

If no tracked source files changed after the audit, do not create a commit.
If a tracked report file was intentionally updated and git is available:
```bash
git add <tracked-report-file>
git commit -m "docs: record T1 local authority prioritization audit"
```

---

## Self-Review

- **Spec coverage:** This plan covers the prompt-only rule injection, focused prompt-contract testing, and a real T1 rerun with early-round `fetchActions` inspection.
- **Placeholder scan:** No TBD/TODO markers; all code edits, commands, and expected outcomes are concrete.
- **Type consistency:** Uses the repo’s existing names: `buildPolicyPrompt`, `searchActions`, `fetchActions`, `final_package`, and `TARGET_TASK=T1`.
