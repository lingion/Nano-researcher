# Generic Runtime Completion Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with a focused test and review checkpoint after each task.

**Goal:** Complete the repository-local Generic runtime handoff by proving the manager persistence path, correcting stale Generic documentation, and adding a repository-native CI gate, then publish only the authorized project changes to `origin/main`.

**Architecture:** Keep `Generic Agent -> Auto search -> local fetch -> evidence -> report` as the only Generic main path. The manager test will use deterministic in-process dependencies and a temporary output/evidence root; it will verify externally visible run state and persisted artifacts without moving semantic decisions into runtime code. Documentation and CI changes will describe and validate the implemented contracts, not add domain rules or claim external provider guarantees.

**Tech Stack:** TypeScript, Node test runner via `tsx`, pnpm, GitHub Actions, Git.

## Global Constraints

- Persistent source of truth: `/Users/lingion_k/local-policy-agent`.
- Do not modify, stage, commit, or publish user-owned `tasks/`.
- Do not read macOS Keychain or expose credential values.
- Do not add preview, rollout, geography, audience, date-window, official-domain, or other domain-specific Generic runtime rules.
- Do not change versions, tags, releases, package artifacts, or deployment configuration unless separately authorized.
- External LLM/search availability remains an explicit runtime dependency; CI must use deterministic tests and must not require live credentials.

---

### Task 1: Add the manager persistence contract test

**Files:**
- Modify: `__tests__/app/run-manager.test.ts`
- Inspect: `src/app/run-manager.ts`, `src/app/run-agent.ts`, `src/evidence/file-store.ts`, `src/artifacts/generic-report.ts`

**Interfaces:**
- Consumes: `ResearchRunManager.start()`, deterministic `ResearchAgentDependencies`, temporary `outputDir` and `evidenceRoot`.
- Produces: A test proving one manager-backed run executes `search -> fetch -> finish`, reaches `completed`, writes `run.json`, writes report files through the injected writer, and writes all four evidence files.

- [ ] **Step 1: Write the failing test**

  Add a test with deterministic dependencies: the fake LLM returns `search` on the first call, `fetch` on the second call using the search URL, and `finish` on the third call with one `confirmed` finding bound to that fetched URL. Use `mkdtemp()` for separate output and evidence roots. Assert terminal status, event types, counts, report status, and the existence/contents of `run.json`, `events.jsonl`, `search-results.jsonl`, `fetched-pages.jsonl`, `agent-result.json`, and the three report files.

- [ ] **Step 2: Run the focused test to verify its baseline**

  Run:

  ```bash
  pnpm exec tsx --test __tests__/app/run-manager.test.ts
  ```

  Expected: the new test either passes against the existing implementation or fails at the first missing observable contract. If it passes immediately, retain it as a regression guard and do not add production code without a separate demonstrated gap.

- [ ] **Step 3: Implement only a demonstrated production gap**

  If the focused test exposes a missing persistence or lifecycle behavior, change only the responsible method in `src/app/run-manager.ts`, `src/app/run-agent.ts`, or `src/evidence/file-store.ts`. Preserve the existing terminal event ordering and evidence/report separation.

- [ ] **Step 4: Run focused verification**

  ```bash
  pnpm exec tsx --test __tests__/app/run-manager.test.ts
  pnpm exec tsx --test __tests__/adapters/http.test.ts __tests__/adapters/mcp.test.ts
  ```

- [ ] **Step 5: Save point**

  Review the diff and keep this task in the same eventual publication only if it contains no unrelated files.

### Task 2: Correct the Generic documentation boundary

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `docs/PRODUCTION_READY.md`
- Inspect: `src/agent/agent-loop.ts`, `src/agent/decision-protocol.ts`, `__tests__/agent/agent-loop.test.ts`

**Interfaces:**
- Consumes: The domain-neutral Generic prompt and evidence semantics implemented in source.
- Produces: English and Chinese documentation that describes model-owned semantic decisions, system-owned transport facts, and the actual limitation that external provider availability is not a correctness guarantee.

- [ ] **Step 1: Write the documentation diff**

  Replace the stale paragraph describing every Generic target finding as a test/preview/rollout event and merging sibling release pages with domain-neutral wording: each finding is a model-submitted claim with a disposition and fetched evidence binding; semantic deduplication remains model-owned and is not a runtime rule.

- [ ] **Step 2: Validate static documentation contracts**

  ```bash
  pnpm exec tsx --test __tests__/packaging.test.ts __tests__/agent/agent-loop.test.ts
  ```

  Expected: all documentation/security/link and Generic prompt tests pass.

- [ ] **Step 3: Mark the old readiness handoff as historical**

  Keep the June 2026 legacy baseline evidence intact, but change the document title and conclusion so it cannot be read as proof that the current dirty Generic worktree is production-ready. Point readers to the current README and current test/build gates for the Generic runtime.

### Task 3: Add repository-native CI validation

**Files:**
- Create: `.github/workflows/ci.yml`
- Inspect: `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `tsconfig.generic.json`

**Interfaces:**
- Consumes: Existing `pnpm test` and `pnpm build` scripts.
- Produces: A GitHub Actions workflow for pushes and pull requests that installs the frozen lockfile and runs the exact repository-native test and build commands without credentials or live providers.

- [ ] **Step 1: Add the workflow**

  Use `actions/checkout@v4`, `pnpm/action-setup@v4` with the repository's package-manager version, `actions/setup-node@v4` with pnpm cache, then run `pnpm install --frozen-lockfile`, `pnpm test`, and `pnpm build`.

- [ ] **Step 2: Validate workflow text locally**

  ```bash
  git diff --check
  rg -n "checkout|pnpm/action-setup|setup-node|frozen-lockfile|pnpm test|pnpm build" .github/workflows/ci.yml
  ```

  Expected: the workflow contains only deterministic repository gates and no secret values.

### Task 4: Full verification and publication

**Files:**
- Stage only: the reviewed project files from Tasks 1–3 plus the already-authorized Generic changes in the worktree.
- Exclude: `tasks/`, `.env*`, generated artifacts, caches, and unrelated user files.

- [ ] **Step 1: Run full validation**

  ```bash
  pnpm test
  pnpm build
  git diff --check
  ```

- [ ] **Step 2: Inspect staged scope and secrets**

  ```bash
  git status -sb
  git diff --stat
  git diff --cached --check
  git diff --cached --name-only
  git diff --cached | rg -i "api[_-]?key|authorization|bearer|token|secret|password" || true
  ```

- [ ] **Step 3: Synchronize before commit**

  ```bash
  git fetch origin main
  git rev-list --left-right --count HEAD...origin/main
  ```

  Stop if the histories diverge.

- [ ] **Step 4: Commit and push**

  Use a descriptive conventional commit, push to `origin main`, and capture the full commit SHA.

- [ ] **Step 5: Verify remotely**

  ```bash
  git ls-remote origin refs/heads/main
  gh api repos/lingion/Nano-researcher/commits/<sha> --jq '.sha'
  gh run list --repo lingion/Nano-researcher --commit <sha> --limit 10
  git status -sb
  ```

  Report CI as pending or absent if GitHub exposes no run; do not equate a successful push with CI success.
