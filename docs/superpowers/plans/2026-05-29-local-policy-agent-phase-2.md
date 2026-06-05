# local-policy-agent Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the transplanted NanoClaw core into a runnable local policy-agent loop, connect it to the separate search/fetch boundaries, and add a full debug mode that records prompts, model text, tool calls, tool returns, and runtime state transitions without moving business judgment into code rules.

**Architecture:** Keep the existing `local-policy-agent` split: NanoClaw core handles orchestration, `search-fusion` discovers candidate URLs, `fetch-fusion` retrieves page evidence, and `policy-task` defines the prompt/state/output contract. Add a debug subsystem that records every raw model input/output, tool call/request/response, and runtime state change into human-inspectable artifacts so manual validation can trace the entire run.

**Tech Stack:** Node.js 20+, pnpm, ESM, TypeScript, `better-sqlite3`, transplanted NanoClaw core files, local search fusion boundary, local fetch fusion boundary, HTML/JSON artifacts, `tsx --test`.

---

## File Structure

### Existing files to modify
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/src/nanoclaw-core/poll-loop.ts`
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/src/nanoclaw-core/claude-provider.ts`
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/src/policy-task/prompt-builder.ts`
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/src/policy-task/state-schema.ts`
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/src/policy-task/output-schema.ts`
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/src/search-fusion/cloudflare-search-local.ts`
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/src/fetch-fusion/local-fetch-primary.ts`
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/src/app/run-policy-task.ts`
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/src/app/index.ts`
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/README.md`

### New files to create
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/debug/debug-config.ts`
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/debug/debug-trace.ts`
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/debug/write-debug-artifacts.ts`
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/runtime/local-session-loop.ts`
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/runtime/tool-registry.ts`
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/runtime/run-local-policy-agent.ts`
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/search-fusion/search-tool.ts`
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/fetch-fusion/fetch-tool.ts`
- Create: `/Users/lingion/repo-downloads/local-policy-agent/__tests__/debug/debug-trace.test.ts`
- Create: `/Users/lingion/repo-downloads/local-policy-agent/__tests__/runtime/run-local-policy-agent.test.ts`
- Create: `/Users/lingion/repo-downloads/local-policy-agent/__tests__/policy-task/prompt-builder.test.ts`

### Responsibility boundaries
- `policy-task/*` stays responsible only for task/state/output schema and prompt wording.
- `search-fusion/*` stays discovery-only.
- `fetch-fusion/*` stays evidence-only.
- `runtime/*` becomes the local glue between NanoClaw orchestration and our boundaries.
- `debug/*` owns trace collection and debug artifact writing.

---

### Task 1: Strengthen the policy prompt into a real operating contract

**Files:**
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/src/policy-task/prompt-builder.ts`
- Create: `/Users/lingion/repo-downloads/local-policy-agent/__tests__/policy-task/prompt-builder.test.ts`
- Test: `/Users/lingion/repo-downloads/local-policy-agent/__tests__/policy-task/prompt-builder.test.ts`

- [ ] **Step 1: Write the failing prompt-contract test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPolicyPrompt } from '../../src/policy-task/prompt-builder.ts';

test('policy prompt encodes search/fetch boundaries and agent-owned business judgment', () => {
  const prompt = buildPolicyPrompt();

  assert.match(prompt, /You are the single Local Policy Agent/i);
  assert.match(prompt, /Search discovers candidate URLs only/i);
  assert.match(prompt, /Fetch extracts page evidence only/i);
  assert.match(prompt, /The runtime only executes, records, persists, deduplicates, and renders artifacts/i);
  assert.match(prompt, /You must decide when to search, when to fetch, when evidence is sufficient, and when to finalize/i);
  assert.match(prompt, /Do not assume discovery snippets are equal to fetched evidence/i);
  assert.match(prompt, /Return JSON only/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lingion/repo-downloads/local-policy-agent && pnpm test __tests__/policy-task/prompt-builder.test.ts`
Expected: FAIL because the current prompt is too short and missing the new clauses.

- [ ] **Step 3: Replace the minimal prompt with the stronger operating prompt**

```ts
export function buildPolicyPrompt(): string {
  return [
    'You are the single Local Policy Agent inside a local policy workbench.',
    'Your job is to produce a business-usable policy result package by directing search and fetch tools, examining evidence, and making the final judgment yourself.',
    'You are the only business decision-maker.',
    'The runtime only executes, records, persists, deduplicates, and renders artifacts.',
    'All business judgment must come from you.',
    'Search discovers candidate URLs only.',
    'Search results are hints, not proof.',
    'Fetch extracts page evidence only.',
    'Fetched evidence is the main basis for evidence judgment.',
    'Do not assume discovery snippets are equal to fetched evidence.',
    'You must decide when to search, when to fetch, when evidence is sufficient, and when to finalize.',
    'If evidence is weak, say it is weak.',
    'If evidence is conflicting, say it is conflicting.',
    'Return JSON only.',
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/lingion/repo-downloads/local-policy-agent && pnpm test __tests__/policy-task/prompt-builder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git -C /Users/lingion/repo-downloads/local-policy-agent add src/policy-task/prompt-builder.ts __tests__/policy-task/prompt-builder.test.ts
git -C /Users/lingion/repo-downloads/local-policy-agent commit -m "feat: strengthen local policy agent prompt contract"
```

---

### Task 2: Extend the state and output schemas for real agent loops

**Files:**
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/src/policy-task/state-schema.ts`
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/src/policy-task/output-schema.ts`
- Test: `/Users/lingion/repo-downloads/local-policy-agent/__tests__/runtime/run-local-policy-agent.test.ts`

- [ ] **Step 1: Write the failing schema-shape test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PolicyAgentState } from '../../src/policy-task/state-schema.ts';
import type { PolicyAgentDecision } from '../../src/policy-task/output-schema.ts';

test('policy state and decision shapes support iterative search/fetch loops', () => {
  const state: PolicyAgentState = {
    task: { topic: '科技招商政策' },
    discoveredCandidates: [],
    fetchedEvidence: [],
    transcriptPath: undefined,
    currentIteration: 0,
    uncertainties: [],
  };

  const decision: PolicyAgentDecision = {
    decision: 'continue_search',
    reasoning: 'Need more candidate URLs.',
    searchActions: [{ query: '科技招商政策', why: 'start broad' }],
    fetchActions: [],
    discardedLeads: [],
    uncertainties: ['No strong fetched evidence yet'],
  };

  assert.equal(state.currentIteration, 0);
  assert.equal(decision.searchActions[0]?.query, '科技招商政策');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lingion/repo-downloads/local-policy-agent && pnpm test __tests__/runtime/run-local-policy-agent.test.ts`
Expected: FAIL because `currentIteration`, `uncertainties`, and `discardedLeads` do not exist yet.

- [ ] **Step 3: Expand `state-schema.ts`**

```ts
import type { PolicyTaskInput } from './task-schema.js';

export interface DiscoveredCandidate {
  query: string;
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface FetchedEvidence {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  content: string;
  backend: string;
}

export interface PolicyAgentState {
  task: PolicyTaskInput;
  discoveredCandidates: DiscoveredCandidate[];
  fetchedEvidence: FetchedEvidence[];
  transcriptPath?: string;
  currentIteration: number;
  uncertainties: string[];
}
```

- [ ] **Step 4: Expand `output-schema.ts`**

```ts
export interface AgentSearchAction {
  query: string;
  why: string;
}

export interface AgentFetchAction {
  url: string;
  why: string;
}

export interface PolicyAgentDecision {
  decision: 'continue_search' | 'continue_fetch' | 'finalize' | 'stop';
  reasoning: string;
  searchActions: AgentSearchAction[];
  fetchActions: AgentFetchAction[];
  finalPackage?: unknown;
  uncertainties: string[];
  discardedLeads: string[];
}
```

- [ ] **Step 5: Create the runtime schema test file**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PolicyAgentState } from '../../src/policy-task/state-schema.ts';
import type { PolicyAgentDecision } from '../../src/policy-task/output-schema.ts';

test('policy state and decision shapes support iterative search/fetch loops', () => {
  const state: PolicyAgentState = {
    task: { topic: '科技招商政策' },
    discoveredCandidates: [],
    fetchedEvidence: [],
    transcriptPath: undefined,
    currentIteration: 0,
    uncertainties: [],
  };

  const decision: PolicyAgentDecision = {
    decision: 'continue_search',
    reasoning: 'Need more candidate URLs.',
    searchActions: [{ query: '科技招商政策', why: 'start broad' }],
    fetchActions: [],
    discardedLeads: [],
    uncertainties: ['No strong fetched evidence yet'],
  };

  assert.equal(state.currentIteration, 0);
  assert.equal(decision.searchActions[0]?.query, '科技招商政策');
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd /Users/lingion/repo-downloads/local-policy-agent && pnpm test __tests__/runtime/run-local-policy-agent.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git -C /Users/lingion/repo-downloads/local-policy-agent add src/policy-task/state-schema.ts src/policy-task/output-schema.ts __tests__/runtime/run-local-policy-agent.test.ts
git -C /Users/lingion/repo-downloads/local-policy-agent commit -m "feat: extend policy state and output schemas"
```

---

### Task 3: Add a debug trace model that can hold full raw runtime evidence

**Files:**
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/debug/debug-config.ts`
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/debug/debug-trace.ts`
- Create: `/Users/lingion/repo-downloads/local-policy-agent/__tests__/debug/debug-trace.test.ts`
- Test: `/Users/lingion/repo-downloads/local-policy-agent/__tests__/debug/debug-trace.test.ts`

- [ ] **Step 1: Write the failing debug trace shape test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebugTrace } from '../../src/debug/debug-trace.ts';

test('debug trace captures raw prompt model tool and runtime sections', () => {
  const trace = createDebugTrace({ enabled: true, outputDir: '/tmp/local-policy-agent-debug' });

  assert.equal(trace.config.enabled, true);
  assert.deepEqual(trace.modelTurns, []);
  assert.deepEqual(trace.toolCalls, []);
  assert.deepEqual(trace.runtimeEvents, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lingion/repo-downloads/local-policy-agent && pnpm test __tests__/debug/debug-trace.test.ts`
Expected: FAIL because debug files do not exist yet.

- [ ] **Step 3: Create `debug-config.ts`**

```ts
export interface DebugConfig {
  enabled: boolean;
  outputDir: string;
}
```

- [ ] **Step 4: Create `debug-trace.ts`**

```ts
import type { DebugConfig } from './debug-config.js';

export interface DebugModelTurn {
  systemPrompt: string;
  rawStateInput: unknown;
  rawModelText: string;
  parsedModelOutput: unknown;
}

export interface DebugToolCall {
  toolName: string;
  request: unknown;
  response: unknown;
}

export interface DebugRuntimeEvent {
  label: string;
  payload: unknown;
}

export interface DebugTrace {
  config: DebugConfig;
  modelTurns: DebugModelTurn[];
  toolCalls: DebugToolCall[];
  runtimeEvents: DebugRuntimeEvent[];
}

export function createDebugTrace(config: DebugConfig): DebugTrace {
  return {
    config,
    modelTurns: [],
    toolCalls: [],
    runtimeEvents: [],
  };
}
```

- [ ] **Step 5: Create the debug trace test file**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebugTrace } from '../../src/debug/debug-trace.ts';

test('debug trace captures raw prompt model tool and runtime sections', () => {
  const trace = createDebugTrace({ enabled: true, outputDir: '/tmp/local-policy-agent-debug' });

  assert.equal(trace.config.enabled, true);
  assert.deepEqual(trace.modelTurns, []);
  assert.deepEqual(trace.toolCalls, []);
  assert.deepEqual(trace.runtimeEvents, []);
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd /Users/lingion/repo-downloads/local-policy-agent && pnpm test __tests__/debug/debug-trace.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git -C /Users/lingion/repo-downloads/local-policy-agent add src/debug __tests__/debug/debug-trace.test.ts
git -C /Users/lingion/repo-downloads/local-policy-agent commit -m "feat: add debug trace model"
```

---

### Task 4: Add debug artifact writers for human inspection

**Files:**
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/debug/write-debug-artifacts.ts`
- Test: `/Users/lingion/repo-downloads/local-policy-agent/__tests__/debug/debug-trace.test.ts`

- [ ] **Step 1: Write the failing debug artifact writer test**

Append to `__tests__/debug/debug-trace.test.ts`:

```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDebugTrace } from '../../src/debug/debug-trace.ts';
import { writeDebugArtifacts } from '../../src/debug/write-debug-artifacts.ts';

test('debug artifact writer emits human-inspectable trace files', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'lpa-debug-'));
  const trace = createDebugTrace({ enabled: true, outputDir });
  trace.runtimeEvents.push({ label: 'session-created', payload: { id: 'sess-1' } });

  const files = await writeDebugArtifacts(trace);
  const summary = await readFile(files.debugTracePath, 'utf8');

  assert.match(summary, /session-created/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lingion/repo-downloads/local-policy-agent && pnpm test __tests__/debug/debug-trace.test.ts`
Expected: FAIL because `write-debug-artifacts.ts` does not exist yet.

- [ ] **Step 3: Create `write-debug-artifacts.ts`**

```ts
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { DebugTrace } from './debug-trace.js';

export async function writeDebugArtifacts(trace: DebugTrace): Promise<{ debugTracePath: string }> {
  await mkdir(trace.config.outputDir, { recursive: true });
  const debugTracePath = path.join(trace.config.outputDir, 'debug-trace.json');
  await writeFile(debugTracePath, JSON.stringify(trace, null, 2));
  return { debugTracePath };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/lingion/repo-downloads/local-policy-agent && pnpm test __tests__/debug/debug-trace.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git -C /Users/lingion/repo-downloads/local-policy-agent add src/debug/write-debug-artifacts.ts __tests__/debug/debug-trace.test.ts
git -C /Users/lingion/repo-downloads/local-policy-agent commit -m "feat: add debug artifact writer"
```

---

### Task 5: Wrap the discovery-only search boundary as a runtime tool

**Files:**
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/search-fusion/search-tool.ts`
- Test: `/Users/lingion/repo-downloads/local-policy-agent/__tests__/search-fusion/cloudflare-search-local.test.ts`

- [ ] **Step 1: Write the failing runtime search-tool test**

Append to `__tests__/search-fusion/cloudflare-search-local.test.ts`:

```ts
import { createSearchTool } from '../../src/search-fusion/search-tool.ts';

test('runtime search tool only returns normalized discovery records', async () => {
  const tool = createSearchTool(async (query) => ({
    query,
    results: [{ title: '政策标题', url: 'https://example.gov.cn/policy', snippet: '摘要', source: 'backend' }],
  }));

  const result = await tool.search('科技招商政策');
  assert.equal(result[0]?.url, 'https://example.gov.cn/policy');
  assert.equal(result[0]?.snippet, '摘要');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lingion/repo-downloads/local-policy-agent && pnpm test __tests__/search-fusion/cloudflare-search-local.test.ts`
Expected: FAIL because `search-tool.ts` does not exist yet.

- [ ] **Step 3: Create `search-tool.ts`**

```ts
import { normalizeSearchDiscovery } from './cloudflare-search-local.js';
import type { SearchDiscoveryRecord } from './types.js';

export function createSearchTool(
  backend: (query: string) => Promise<{ query: string; results: Array<{ title?: string; url?: string; snippet?: string; source?: string }> }>,
): { search(query: string): Promise<SearchDiscoveryRecord[]> } {
  return {
    async search(query: string): Promise<SearchDiscoveryRecord[]> {
      const raw = await backend(query);
      return normalizeSearchDiscovery(raw);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/lingion/repo-downloads/local-policy-agent && pnpm test __tests__/search-fusion/cloudflare-search-local.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git -C /Users/lingion/repo-downloads/local-policy-agent add src/search-fusion/search-tool.ts __tests__/search-fusion/cloudflare-search-local.test.ts
git -C /Users/lingion/repo-downloads/local-policy-agent commit -m "feat: wrap discovery-only search tool"
```

---

### Task 6: Wrap the fetch boundary as a runtime evidence tool

**Files:**
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/fetch-fusion/fetch-tool.ts`
- Test: `/Users/lingion/repo-downloads/local-policy-agent/__tests__/fetch-fusion/local-fetch-primary.test.ts`

- [ ] **Step 1: Write the failing runtime fetch-tool test**

Append to `__tests__/fetch-fusion/local-fetch-primary.test.ts`:

```ts
import { createFetchTool } from '../../src/fetch-fusion/fetch-tool.ts';

test('runtime fetch tool only returns normalized fetched evidence', async () => {
  const tool = createFetchTool(async (url) => ({
    requestedUrl: url,
    finalUrl: `${url}?final=1`,
    title: '政策全文',
    content: '正文内容',
    backend: 'backend-a',
  }));

  const result = await tool.fetch('https://example.gov.cn/policy');
  assert.equal(result.finalUrl, 'https://example.gov.cn/policy?final=1');
  assert.equal(result.content, '正文内容');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lingion/repo-downloads/local-policy-agent && pnpm test __tests__/fetch-fusion/local-fetch-primary.test.ts`
Expected: FAIL because `fetch-tool.ts` does not exist yet.

- [ ] **Step 3: Create `fetch-tool.ts`**

```ts
import { normalizeFetchedPage } from './local-fetch-primary.js';
import type { FetchedPageRecord } from './types.js';

export function createFetchTool(
  backend: (url: string) => Promise<FetchedPageRecord>,
): { fetch(url: string): Promise<FetchedPageRecord> } {
  return {
    async fetch(url: string): Promise<FetchedPageRecord> {
      const raw = await backend(url);
      return normalizeFetchedPage(raw);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/lingion/repo-downloads/local-policy-agent && pnpm test __tests__/fetch-fusion/local-fetch-primary.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git -C /Users/lingion/repo-downloads/local-policy-agent add src/fetch-fusion/fetch-tool.ts __tests__/fetch-fusion/local-fetch-primary.test.ts
git -C /Users/lingion/repo-downloads/local-policy-agent commit -m "feat: wrap fetch evidence tool"
```

---

### Task 7: Add a local runtime glue layer that can execute one policy-agent iteration

**Files:**
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/runtime/tool-registry.ts`
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/runtime/local-session-loop.ts`
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/runtime/run-local-policy-agent.ts`
- Test: `/Users/lingion/repo-downloads/local-policy-agent/__tests__/runtime/run-local-policy-agent.test.ts`

- [ ] **Step 1: Write the failing runtime iteration test**

Append to `__tests__/runtime/run-local-policy-agent.test.ts`:

```ts
import { runLocalPolicyAgentIteration } from '../../src/runtime/run-local-policy-agent.ts';

test('runtime can execute one agent iteration with separate search and fetch tools', async () => {
  const result = await runLocalPolicyAgentIteration({
    task: { topic: '科技招商政策' },
    discoveredCandidates: [],
    fetchedEvidence: [],
    currentIteration: 0,
    uncertainties: [],
  }, {
    askAgent: async () => ({
      decision: 'continue_search',
      reasoning: 'Need candidate URLs.',
      searchActions: [{ query: '科技招商政策', why: 'start broad' }],
      fetchActions: [],
      discardedLeads: [],
      uncertainties: ['No fetched evidence yet'],
    }),
    searchTool: {
      search: async () => [
        { query: '科技招商政策', title: '政策标题', url: 'https://example.gov.cn/policy', snippet: '摘要', source: 'backend' },
      ],
    },
    fetchTool: {
      fetch: async () => ({
        requestedUrl: 'https://example.gov.cn/policy',
        finalUrl: 'https://example.gov.cn/policy?final=1',
        title: '政策全文',
        content: '正文内容',
        backend: 'backend-a',
      }),
    },
  });

  assert.equal(result.discoveredCandidates[0]?.url, 'https://example.gov.cn/policy');
  assert.equal(result.decision.reasoning, 'Need candidate URLs.');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lingion/repo-downloads/local-policy-agent && pnpm test __tests__/runtime/run-local-policy-agent.test.ts`
Expected: FAIL because runtime glue files do not exist yet.

- [ ] **Step 3: Create `tool-registry.ts`**

```ts
import type { SearchDiscoveryRecord } from '../search-fusion/types.js';
import type { FetchedPageRecord } from '../fetch-fusion/types.js';

export interface SearchTool {
  search(query: string): Promise<SearchDiscoveryRecord[]>;
}

export interface FetchTool {
  fetch(url: string): Promise<FetchedPageRecord>;
}
```

- [ ] **Step 4: Create `local-session-loop.ts`**

```ts
import type { PolicyAgentState } from '../policy-task/state-schema.js';
import type { PolicyAgentDecision } from '../policy-task/output-schema.js';
import type { SearchTool, FetchTool } from './tool-registry.js';

export async function runOneSessionIteration(
  state: PolicyAgentState,
  deps: {
    askAgent: (state: PolicyAgentState) => Promise<PolicyAgentDecision>;
    searchTool: SearchTool;
    fetchTool: FetchTool;
  },
): Promise<{ state: PolicyAgentState; decision: PolicyAgentDecision }> {
  const decision = await deps.askAgent(state);

  const discovered = [...state.discoveredCandidates];
  for (const action of decision.searchActions) {
    const found = await deps.searchTool.search(action.query);
    discovered.push(...found);
  }

  const fetched = [...state.fetchedEvidence];
  for (const action of decision.fetchActions) {
    const page = await deps.fetchTool.fetch(action.url);
    fetched.push(page);
  }

  return {
    decision,
    state: {
      ...state,
      discoveredCandidates: discovered,
      fetchedEvidence: fetched,
      currentIteration: state.currentIteration + 1,
      uncertainties: decision.uncertainties,
    },
  };
}
```

- [ ] **Step 5: Create `run-local-policy-agent.ts`**

```ts
import type { PolicyAgentState } from '../policy-task/state-schema.js';
import type { PolicyAgentDecision } from '../policy-task/output-schema.js';
import type { SearchTool, FetchTool } from './tool-registry.js';
import { runOneSessionIteration } from './local-session-loop.js';

export async function runLocalPolicyAgentIteration(
  state: PolicyAgentState,
  deps: {
    askAgent: (state: PolicyAgentState) => Promise<PolicyAgentDecision>;
    searchTool: SearchTool;
    fetchTool: FetchTool;
  },
): Promise<PolicyAgentState & { decision: PolicyAgentDecision }> {
  const result = await runOneSessionIteration(state, deps);
  return {
    ...result.state,
    decision: result.decision,
  };
}
```

- [ ] **Step 6: Create the runtime glue test file**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLocalPolicyAgentIteration } from '../../src/runtime/run-local-policy-agent.ts';

test('runtime can execute one agent iteration with separate search and fetch tools', async () => {
  const result = await runLocalPolicyAgentIteration({
    task: { topic: '科技招商政策' },
    discoveredCandidates: [],
    fetchedEvidence: [],
    currentIteration: 0,
    uncertainties: [],
  }, {
    askAgent: async () => ({
      decision: 'continue_search',
      reasoning: 'Need candidate URLs.',
      searchActions: [{ query: '科技招商政策', why: 'start broad' }],
      fetchActions: [],
      discardedLeads: [],
      uncertainties: ['No fetched evidence yet'],
    }),
    searchTool: {
      search: async () => [
        { query: '科技招商政策', title: '政策标题', url: 'https://example.gov.cn/policy', snippet: '摘要', source: 'backend' },
      ],
    },
    fetchTool: {
      fetch: async () => ({
        requestedUrl: 'https://example.gov.cn/policy',
        finalUrl: 'https://example.gov.cn/policy?final=1',
        title: '政策全文',
        content: '正文内容',
        backend: 'backend-a',
      }),
    },
  });

  assert.equal(result.discoveredCandidates[0]?.url, 'https://example.gov.cn/policy');
  assert.equal(result.decision.reasoning, 'Need candidate URLs.');
});
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd /Users/lingion/repo-downloads/local-policy-agent && pnpm test __tests__/runtime/run-local-policy-agent.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git -C /Users/lingion/repo-downloads/local-policy-agent add src/runtime/tool-registry.ts src/runtime/local-session-loop.ts src/runtime/run-local-policy-agent.ts __tests__/runtime/run-local-policy-agent.test.ts
git -C /Users/lingion/repo-downloads/local-policy-agent commit -m "feat: add local policy agent iteration runtime"
```

---

### Task 8: Thread the full debug mode through one iteration and the app entry

**Files:**
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/src/app/run-policy-task.ts`
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/src/app/index.ts`
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/src/runtime/run-local-policy-agent.ts`
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/src/runtime/local-session-loop.ts`
- Test: `/Users/lingion/repo-downloads/local-policy-agent/__tests__/debug/debug-trace.test.ts`
- Test: `/Users/lingion/repo-downloads/local-policy-agent/__tests__/app/run-policy-task.test.ts`

- [ ] **Step 1: Write the failing debug-threading test**

Append to `__tests__/app/run-policy-task.test.ts`:

```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPolicyTask } from '../../src/app/run-policy-task.ts';

test('runPolicyTask writes a debug trace when debug mode is enabled', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-debug-'));
  const result = await runPolicyTask({ topic: '科技招商政策' }, { outputDir, debug: true });

  const debugTrace = await readFile(path.join(outputDir, 'debug-trace.json'), 'utf8');
  assert.match(debugTrace, /modelTurns/);
  assert.match(debugTrace, /toolCalls/);
  assert.match(debugTrace, /runtimeEvents/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lingion/repo-downloads/local-policy-agent && pnpm test __tests__/app/run-policy-task.test.ts`
Expected: FAIL because debug mode is not yet threaded through.

- [ ] **Step 3: Extend `run-local-policy-agent.ts` to accept an optional trace**

```ts
import type { PolicyAgentState } from '../policy-task/state-schema.js';
import type { PolicyAgentDecision } from '../policy-task/output-schema.js';
import type { SearchTool, FetchTool } from './tool-registry.js';
import type { DebugTrace } from '../debug/debug-trace.js';
import { runOneSessionIteration } from './local-session-loop.js';

export async function runLocalPolicyAgentIteration(
  state: PolicyAgentState,
  deps: {
    askAgent: (state: PolicyAgentState) => Promise<PolicyAgentDecision>;
    searchTool: SearchTool;
    fetchTool: FetchTool;
    debugTrace?: DebugTrace;
  },
): Promise<PolicyAgentState & { decision: PolicyAgentDecision }> {
  const result = await runOneSessionIteration(state, deps);
  deps.debugTrace?.runtimeEvents.push({ label: 'iteration-finished', payload: { decision: result.decision.decision } });
  return {
    ...result.state,
    decision: result.decision,
  };
}
```

- [ ] **Step 4: Extend `local-session-loop.ts` to record search/fetch/model events**

```ts
import type { PolicyAgentState } from '../policy-task/state-schema.js';
import type { PolicyAgentDecision } from '../policy-task/output-schema.js';
import type { SearchTool, FetchTool } from './tool-registry.js';
import type { DebugTrace } from '../debug/debug-trace.js';

export async function runOneSessionIteration(
  state: PolicyAgentState,
  deps: {
    askAgent: (state: PolicyAgentState) => Promise<PolicyAgentDecision>;
    searchTool: SearchTool;
    fetchTool: FetchTool;
    debugTrace?: DebugTrace;
  },
): Promise<{ state: PolicyAgentState; decision: PolicyAgentDecision }> {
  const decision = await deps.askAgent(state);
  deps.debugTrace?.modelTurns.push({
    systemPrompt: 'recorded upstream by caller',
    rawStateInput: state,
    rawModelText: decision.reasoning,
    parsedModelOutput: decision,
  });

  const discovered = [...state.discoveredCandidates];
  for (const action of decision.searchActions) {
    const found = await deps.searchTool.search(action.query);
    deps.debugTrace?.toolCalls.push({ toolName: 'search', request: action, response: found });
    discovered.push(...found);
  }

  const fetched = [...state.fetchedEvidence];
  for (const action of decision.fetchActions) {
    const page = await deps.fetchTool.fetch(action.url);
    deps.debugTrace?.toolCalls.push({ toolName: 'fetch', request: action, response: page });
    fetched.push(page);
  }

  return {
    decision,
    state: {
      ...state,
      discoveredCandidates: discovered,
      fetchedEvidence: fetched,
      currentIteration: state.currentIteration + 1,
      uncertainties: decision.uncertainties,
    },
  };
}
```

- [ ] **Step 5: Extend `run-policy-task.ts` to create and write debug traces**

```ts
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

import { writeTaskSummary } from '../artifacts/write-task-summary.js';
import { writeResultAudit } from '../artifacts/write-result-audit.js';
import { writeRunTranscript } from '../artifacts/write-run-transcript.js';
import { writeReportHtml } from '../artifacts/write-report-html.js';
import { createDebugTrace } from '../debug/debug-trace.js';
import { writeDebugArtifacts } from '../debug/write-debug-artifacts.js';

export async function runPolicyTask(
  input: { topic: string },
  options: { outputDir: string; debug?: boolean },
): Promise<{
  taskSummaryPath: string;
  resultAuditPath: string;
  reportHtmlPath: string;
  runTranscriptPath: string;
}> {
  await mkdir(options.outputDir, { recursive: true });

  const taskSummaryPath = path.join(options.outputDir, 'task-summary.json');
  const resultAuditPath = path.join(options.outputDir, 'result-audit.json');
  const reportHtmlPath = path.join(options.outputDir, 'report.html');
  const runTranscriptPath = path.join(options.outputDir, 'run-transcript.json');

  await writeTaskSummary(taskSummaryPath, { task: input });
  await writeResultAudit(resultAuditPath, { task: input, candidates: [] });
  await writeRunTranscript(runTranscriptPath, { task: input, turns: [] });
  await writeReportHtml(reportHtmlPath, input.topic);

  if (options.debug) {
    const trace = createDebugTrace({ enabled: true, outputDir: options.outputDir });
    await writeDebugArtifacts(trace);
  }

  return { taskSummaryPath, resultAuditPath, reportHtmlPath, runTranscriptPath };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/lingion/repo-downloads/local-policy-agent && pnpm test __tests__/debug/debug-trace.test.ts __tests__/app/run-policy-task.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git -C /Users/lingion/repo-downloads/local-policy-agent add src/debug src/runtime src/app __tests__/debug/debug-trace.test.ts __tests__/app/run-policy-task.test.ts
git -C /Users/lingion/repo-downloads/local-policy-agent commit -m "feat: thread full debug mode through local policy agent"
```

---

### Task 9: Update README with real debug-mode and manual acceptance guidance

**Files:**
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/README.md`
- Test: `/Users/lingion/repo-downloads/local-policy-agent/README.md`

- [ ] **Step 1: Append a debug mode section**

Add to `README.md`:

```md
## Debug mode

This project is intended to support a full manual inspection mode.
When debug mode is enabled, the runtime should write trace artifacts that let a human inspect:
- the prompt given to the model
- the raw state input
- the raw model text
- the parsed model output
- every tool call request
- every tool call response
- runtime state transitions

The goal is manual traceability, not abstract pass/fail scoring.
```

- [ ] **Step 2: Append a manual acceptance note**

```md
## Manual acceptance rule

Validation should not be reduced to a single numeric score.
A human should be able to inspect the generated debug trace and runtime artifacts directly.
```

- [ ] **Step 3: Run a final full smoke test**

Run: `cd /Users/lingion/repo-downloads/local-policy-agent && pnpm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git -C /Users/lingion/repo-downloads/local-policy-agent add README.md
git -C /Users/lingion/repo-downloads/local-policy-agent commit -m "docs: add debug mode and manual acceptance guidance"
```

---

## Self-Review

### Spec coverage
- Wire NanoClaw core to search/fetch boundaries: covered in Tasks 5, 6, and 7.
- Add full debug mode with prompt/model/tool/runtime tracing: covered in Tasks 3, 4, and 8.
- Preserve prompt-only business judgment: strengthened in Tasks 1 and 2.
- Manual inspection-first acceptance: covered in Task 9.

### Placeholder scan
- All tasks contain exact file paths.
- Code steps include concrete code blocks.
- Test steps include exact commands and expected outcomes.
- No TBD/TODO placeholders remain.

### Type consistency
- `PolicyAgentState`, `PolicyAgentDecision`, `SearchDiscoveryRecord`, `FetchedPageRecord`, `DebugTrace`, `SearchTool`, and `FetchTool` are defined before later tasks rely on them.
- Runtime glue uses the same field names introduced in the schema tasks.

Plan complete and saved to `/Users/lingion/repo-downloads/local-policy-agent/docs/superpowers/plans/2026-05-29-local-policy-agent-phase-2.md`. Two execution options:

1. Subagent-Driven (recommended) - I dispatch a fresh subagent per task, review between tasks, fast iteration

2. Inline Execution - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
