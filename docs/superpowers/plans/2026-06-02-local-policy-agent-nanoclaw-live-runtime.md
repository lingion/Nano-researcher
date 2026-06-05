# Local Policy Agent Nanoclaw Live Runtime Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewire the local policy agent's real LLM runtime to use a thin NanoClaw bridge that supports proxy base URLs and custom model names like `gpt-5.4`, while keeping the existing mock-driven test surface stable and adding a manual live-audit entrypoint.

**Architecture:** Keep the policy runtime boundary unchanged: `askRealClaudeDecision()` still produces a prompt, receives a raw JSON string, parses it, and normalizes a decision. Add a new `src/runtime/nanoclaw-bridge.ts` driver that owns environment-variable resolution and live transport details, then delegate `defaultCallModel()` to it. Preserve all existing injected `callModel` test seams, and add a manual live-audit entrypoint outside the normal test suite.

**Tech Stack:** TypeScript, NodeNext, `tsx --test`, embedded NanoClaw core, existing runtime debug events, Node `fetch`, optional `dotenv` for manual live runs.

---

## File Map

### Existing files to modify
- `package.json`
  - Add the live-audit script and any minimal runtime dependency needed for env loading.
- `src/runtime/ask-real-claude.ts`
  - Keep prompt assembly, debug events, raw-output capture, and `normalizeDecision()`.
  - Remove direct `@anthropic-ai/sdk` transport usage from `defaultCallModel()`.
  - Delegate real transport to the new NanoClaw bridge.
  - Expand runtime model/baseURL/provider resolution to support NanoClaw-first live runs.
- `__tests__/runtime/real-ask-agent.test.ts`
  - Preserve existing parsing tests.
  - Add assertions for NanoClaw-preferring model resolution and richer debug transport metadata.

### New files to create
- `src/runtime/nanoclaw-bridge.ts`
  - Thin live runtime bridge.
  - Resolve environment variables.
  - Resolve provider mode (`openai` vs `anthropic`).
  - Send one prompt and return one normalized text string.
- `__tests__/runtime/nanoclaw-bridge.test.ts`
  - Lock environment priority, provider mode resolution, custom model passthrough, and normalized response parsing.
- `src/app/run-live-audit.ts`
  - Manual production-like entrypoint for a real policy-loop run with `.env` support.

### Files to leave untouched
- `src/app/run-policy-task.ts`
- `src/runtime/run-local-policy-agent.ts`
- `src/runtime/local-session-loop.ts`
- `src/runtime/context-governor.ts`
- `src/runtime/termination-policy.ts`
- `__tests__/app/policy-loop-behavior.test.ts`
- `__tests__/runtime/run-local-policy-agent.test.ts`

These files are intentionally insulated from protocol and provider details.

---

### Task 1: Lock the NanoClaw bridge contract with failing tests

**Files:**
- Create: `__tests__/runtime/nanoclaw-bridge.test.ts`
- Test: `__tests__/runtime/nanoclaw-bridge.test.ts`

- [ ] **Step 1: Write the failing test for env priority and runtime config resolution**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveNanoclawRuntimeConfig,
} from '../../src/runtime/nanoclaw-bridge.ts';

test('nanoclaw bridge prefers NANOCLAW_* env vars over ANTHROPIC_* fallbacks', () => {
  const original = {
    NANOCLAW_API_KEY: process.env.NANOCLAW_API_KEY,
    NANOCLAW_BASE_URL: process.env.NANOCLAW_BASE_URL,
    NANOCLAW_LLM_PROVIDER: process.env.NANOCLAW_LLM_PROVIDER,
    POLICY_AGENT_LLM_MODEL: process.env.POLICY_AGENT_LLM_MODEL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  };

  process.env.NANOCLAW_API_KEY = 'nano-key';
  process.env.NANOCLAW_BASE_URL = 'https://nano.example/v1';
  process.env.NANOCLAW_LLM_PROVIDER = 'openai';
  process.env.POLICY_AGENT_LLM_MODEL = 'gpt-5.4';
  process.env.ANTHROPIC_API_KEY = 'anthropic-key';
  process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
  process.env.ANTHROPIC_MODEL = 'claude-opus-4-8';

  try {
    assert.deepEqual(resolveNanoclawRuntimeConfig(), {
      apiKey: 'nano-key',
      baseURL: 'https://nano.example/v1',
      model: 'gpt-5.4',
      provider: 'openai',
    });
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
```

- [ ] **Step 2: Write the failing test for custom model passthrough and OpenAI-compatible normalization**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  callNanoclawModel,
} from '../../src/runtime/nanoclaw-bridge.ts';

test('nanoclaw bridge sends a custom model unchanged and normalizes openai-compatible text output', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  const rawText = await callNanoclawModel('prompt-body', {
    config: {
      apiKey: 'nano-key',
      baseURL: 'https://nano.example/v1',
      model: 'gpt-5.4',
      provider: 'openai',
    },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: '{"decision":"stop","reasoning":"done"}',
            },
          },
        ],
      }));
    },
  });

  assert.equal(calls[0]?.url, 'https://nano.example/v1/chat/completions');
  assert.match(String(calls[0]?.init?.body), /"model":"gpt-5\.4"/);
  assert.equal(rawText, '{"decision":"stop","reasoning":"done"}');
});
```

- [ ] **Step 3: Write the failing test for Anthropic-compatible normalization and missing-config errors**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  callNanoclawModel,
  resolveNanoclawRuntimeConfig,
} from '../../src/runtime/nanoclaw-bridge.ts';

test('nanoclaw bridge normalizes anthropic-compatible text blocks', async () => {
  const rawText = await callNanoclawModel('prompt-body', {
    config: {
      apiKey: 'nano-key',
      baseURL: 'https://nano.example',
      model: 'gpt-5.4',
      provider: 'anthropic',
    },
    fetchImpl: async () => new Response(JSON.stringify({
      content: [
        { type: 'text', text: '{"decision":"stop","reasoning":"done"}' },
      ],
    })),
  });

  assert.equal(rawText, '{"decision":"stop","reasoning":"done"}');
});

test('nanoclaw bridge throws a direct error when no live API key is configured', () => {
  const originalNano = process.env.NANOCLAW_API_KEY;
  const originalAnthropic = process.env.ANTHROPIC_API_KEY;
  delete process.env.NANOCLAW_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  try {
    assert.throws(
      () => resolveNanoclawRuntimeConfig(),
      /Missing NANOCLAW_API_KEY\/ANTHROPIC_API_KEY for live runtime/,
    );
  } finally {
    if (originalNano === undefined) delete process.env.NANOCLAW_API_KEY;
    else process.env.NANOCLAW_API_KEY = originalNano;
    if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropic;
  }
});
```

- [ ] **Step 4: Run the new bridge test file to verify it fails**

Run:

```bash
pnpm --dir /Users/lingion/repo-downloads/local-policy-agent test __tests__/runtime/nanoclaw-bridge.test.ts
```

Expected:
- FAIL because `src/runtime/nanoclaw-bridge.ts` does not exist yet
- or FAIL because exported functions are missing

- [ ] **Step 5: Commit the red test**

```bash
git add __tests__/runtime/nanoclaw-bridge.test.ts
git commit -m "test: add nanoclaw bridge contract coverage"
```

---

### Task 2: Implement the thin NanoClaw bridge with the minimum live contract

**Files:**
- Create: `src/runtime/nanoclaw-bridge.ts`
- Test: `__tests__/runtime/nanoclaw-bridge.test.ts`

- [ ] **Step 1: Create the bridge file with the runtime config types and resolver**

```ts
export interface NanoclawRuntimeConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  provider: 'openai' | 'anthropic';
}

export function resolveRuntimeModel(): string {
  return (
    process.env.POLICY_AGENT_LLM_MODEL ??
    process.env.NANOCLAW_MODEL ??
    process.env.ANTHROPIC_MODEL ??
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ??
    'claude-opus-4-8'
  );
}

export function resolveNanoclawRuntimeConfig(): NanoclawRuntimeConfig {
  const apiKey = process.env.NANOCLAW_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Missing NANOCLAW_API_KEY/ANTHROPIC_API_KEY for live runtime');
  }

  const baseURL = process.env.NANOCLAW_BASE_URL ?? process.env.ANTHROPIC_BASE_URL;
  if (!baseURL) {
    throw new Error('Missing NANOCLAW_BASE_URL/ANTHROPIC_BASE_URL for live runtime');
  }

  const provider =
    process.env.NANOCLAW_LLM_PROVIDER === 'openai' || process.env.NANOCLAW_LLM_PROVIDER === 'anthropic'
      ? process.env.NANOCLAW_LLM_PROVIDER
      : /\/chat\/completions$/i.test(baseURL) || /openai/i.test(baseURL)
        ? 'openai'
        : 'anthropic';

  return {
    apiKey,
    baseURL,
    model: resolveRuntimeModel(),
    provider,
  };
}
```

- [ ] **Step 2: Add the live call function that normalizes both response families into one string**

```ts
function joinUrl(baseURL: string, suffix: string): string {
  return `${baseURL.replace(/\/+$/, '')}${suffix}`;
}

function extractOpenAIText(payload: unknown): string {
  const text = (payload as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  }).choices?.[0]?.message?.content;

  if (typeof text === 'string') return text;
  if (Array.isArray(text)) {
    return text
      .filter((item) => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('');
  }
  return '';
}

function extractAnthropicText(payload: unknown): string {
  const content = (payload as {
    content?: Array<{ type?: string; text?: string }>;
  }).content;

  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

export async function callNanoclawModel(
  prompt: string,
  options: {
    config?: NanoclawRuntimeConfig;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<string> {
  const config = options.config ?? resolveNanoclawRuntimeConfig();
  const fetchImpl = options.fetchImpl ?? fetch;

  const endpoint = config.provider === 'openai'
    ? joinUrl(config.baseURL, '/chat/completions')
    : joinUrl(config.baseURL, '/messages');

  const body = config.provider === 'openai'
    ? {
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
      }
    : {
        model: config.model,
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      };

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
      ...(config.provider === 'anthropic'
        ? { 'anthropic-version': '2023-06-01' }
        : {}),
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json() as unknown;
  const rawText = config.provider === 'openai'
    ? extractOpenAIText(payload)
    : extractAnthropicText(payload);

  if (!rawText) {
    throw new Error('Nanoclaw returned empty text response');
  }

  return rawText;
}
```

- [ ] **Step 3: Run the bridge test file to verify it passes**

Run:

```bash
pnpm --dir /Users/lingion/repo-downloads/local-policy-agent test __tests__/runtime/nanoclaw-bridge.test.ts
```

Expected:
- PASS

- [ ] **Step 4: Refactor only if needed to keep the file thin**

If the file starts growing, keep only these responsibilities:
- env resolution
- provider detection
- request execution
- text normalization

Do **not** add decision parsing, debug-event emission, or policy-loop logic here.

- [ ] **Step 5: Commit the green bridge implementation**

```bash
git add src/runtime/nanoclaw-bridge.ts __tests__/runtime/nanoclaw-bridge.test.ts
git commit -m "feat: add thin nanoclaw runtime bridge"
```

---

### Task 3: Rewire ask-real-claude.ts to delegate transport to the bridge

**Files:**
- Modify: `src/runtime/ask-real-claude.ts`
- Test: `__tests__/runtime/real-ask-agent.test.ts`
- Test: `__tests__/runtime/run-local-policy-agent.test.ts`
- Test: `__tests__/app/policy-loop-behavior.test.ts`

- [ ] **Step 1: Write the failing test for NanoClaw-first model resolution and debug transport metadata**

Add these tests to `__tests__/runtime/real-ask-agent.test.ts`:

```ts
test('runtime model resolution prefers POLICY_AGENT_LLM_MODEL over Anthropic defaults', () => {
  const originalPolicy = process.env.POLICY_AGENT_LLM_MODEL;
  const originalAnthropic = process.env.ANTHROPIC_MODEL;
  const originalDefaultOpusModel = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;

  process.env.POLICY_AGENT_LLM_MODEL = 'gpt-5.4';
  process.env.ANTHROPIC_MODEL = 'claude-opus-4-8';
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-sonnet-4-6';

  try {
    assert.equal(resolveRuntimeModel(), 'gpt-5.4');
  } finally {
    if (originalPolicy === undefined) delete process.env.POLICY_AGENT_LLM_MODEL;
    else process.env.POLICY_AGENT_LLM_MODEL = originalPolicy;
    if (originalAnthropic === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = originalAnthropic;
    if (originalDefaultOpusModel === undefined) delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
    else process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = originalDefaultOpusModel;
  }
});

test('real Claude askAgent emits injected transport metadata when callModel is stubbed', async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

  await askRealClaudeDecision(
    {
      task: { topic: '科技招商政策' },
      discoveredCandidates: [],
      fetchedEvidence: [],
      currentIteration: 0,
      uncertainties: [],
    },
    {
      callModel: async () => JSON.stringify({
        decision: 'stop',
        reasoning: 'done',
        searchActions: [],
        fetchActions: [],
        uncertainties: [],
        discardedLeads: [],
      }),
      onDebugEvent: (event) => {
        events.push(event);
      },
    },
  );

  const configEvent = events.find((event) => event.type === 'model.config');
  assert.equal(configEvent?.payload.transport, 'injected-callModel');
});
```

- [ ] **Step 2: Run the focused real-ask-agent test file to verify the new assertions fail first**

Run:

```bash
pnpm --dir /Users/lingion/repo-downloads/local-policy-agent test __tests__/runtime/real-ask-agent.test.ts
```

Expected:
- FAIL because `resolveRuntimeModel()` still ignores `POLICY_AGENT_LLM_MODEL`
- or FAIL because transport metadata is incomplete / duplicated incorrectly

- [ ] **Step 3: Replace the direct Anthropic SDK transport with the NanoClaw bridge**

Update `src/runtime/ask-real-claude.ts` so it imports from the bridge and narrows its responsibilities:

```ts
import { buildPolicyPrompt } from '../policy-task/prompt-builder.js';
import type { PolicyAgentState } from '../policy-task/state-schema.js';
import type { PolicyAgentDecision } from '../policy-task/output-schema.js';
import {
  callNanoclawModel,
  resolveNanoclawRuntimeConfig,
  resolveRuntimeModel,
} from './nanoclaw-bridge.js';
```

Replace the old `defaultCallModel()` implementation with:

```ts
async function defaultCallModel(
  prompt: string,
  options: {
    onDebugEvent?: (event: DebugEvent) => void;
  } = {},
): Promise<string> {
  const config = resolveNanoclawRuntimeConfig();

  options.onDebugEvent?.({
    type: 'model.config',
    payload: {
      model: config.model,
      baseURL: config.baseURL,
      provider: config.provider,
      transport: 'nanoclaw',
    },
  });

  return await callNanoclawModel(prompt, { config });
}
```

Update the `askRealClaudeDecision()` preflight debug event so it stays honest about the transport path:

```ts
options.onDebugEvent?.({
  type: 'model.config',
  payload: options.callModel
    ? {
        model: resolveRuntimeModel(),
        transport: 'injected-callModel',
      }
    : (() => {
        const config = resolveNanoclawRuntimeConfig();
        return {
          model: config.model,
          baseURL: config.baseURL,
          provider: config.provider,
          transport: 'nanoclaw',
        };
      })(),
});
```

Keep everything else unchanged:
- `buildPolicyPrompt()` usage
- `buildUserState()`
- `normalizeDecision()`
- `model.raw_output`
- `model.parse_failure`
- `model.failure`

- [ ] **Step 4: Run the real-ask-agent tests to verify they pass**

Run:

```bash
pnpm --dir /Users/lingion/repo-downloads/local-policy-agent test __tests__/runtime/real-ask-agent.test.ts
```

Expected:
- PASS

- [ ] **Step 5: Run impacted runtime and policy-loop regression tests**

Run:

```bash
pnpm --dir /Users/lingion/repo-downloads/local-policy-agent test __tests__/runtime/run-local-policy-agent.test.ts __tests__/app/policy-loop-behavior.test.ts
```

Expected:
- PASS
- No behavior change in the injected `callModel` path

- [ ] **Step 6: Commit the runtime rewire**

```bash
git add src/runtime/ask-real-claude.ts __tests__/runtime/real-ask-agent.test.ts
git commit -m "refactor: route live ask-real-claude transport through nanoclaw bridge"
```

---

### Task 4: Add a manual live-audit entrypoint without disturbing the test suite

**Files:**
- Create: `src/app/run-live-audit.ts`
- Modify: `package.json`
- Test: manual command only

- [ ] **Step 1: Add a tiny env-loaded live-audit runner**

Create `src/app/run-live-audit.ts` with this minimal shape:

```ts
import 'dotenv/config';

import { runPolicyTaskLoop } from './run-policy-task.ts';

async function main(): Promise<void> {
  const topic = process.env.LIVE_AUDIT_TOPIC ?? '2026年黑龙江省高新技术企业租金减免及研发投入补贴政策最新规定';
  const maxIterations = Number(process.env.LIVE_AUDIT_MAX_ITERATIONS ?? '4');

  const result = await runPolicyTaskLoop(
    { topic },
    { maxIterations },
  );

  console.log(JSON.stringify({
    topic,
    loop_interrupted_by_gate: result.loop_interrupted_by_gate ?? false,
    final_quality_status: result.final_quality_status ?? null,
    final_quality_reason: result.final_quality_reason ?? null,
    current_iteration: result.currentIteration,
    discovered_candidates: result.discoveredCandidates.length,
    fetched_evidence: result.fetchedEvidence.length,
    final_decision: result.decision.decision,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Add the runtime dependency and script**

Update `package.json`:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "tsx --test",
    "start": "node ./dist/app/index.js",
    "live-audit": "tsx src/app/run-live-audit.ts"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.3.154",
    "@anthropic-ai/sdk": "^0.100.1",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "@mozilla/readability": "^0.6.0",
    "better-sqlite3": "^11.8.1",
    "dotenv": "^16.4.7",
    "jsdom": "^29.1.1"
  }
}
```

- [ ] **Step 3: Verify the standard test suite still runs without the live entrypoint affecting it**

Run:

```bash
pnpm --dir /Users/lingion/repo-downloads/local-policy-agent test __tests__/runtime/nanoclaw-bridge.test.ts __tests__/runtime/real-ask-agent.test.ts __tests__/runtime/run-local-policy-agent.test.ts __tests__/app/policy-loop-behavior.test.ts
```

Expected:
- PASS
- No network calls required

- [ ] **Step 4: Smoke-test the live-audit command shape without real credentials**

Run:

```bash
pnpm --dir /Users/lingion/repo-downloads/local-policy-agent live-audit
```

Expected:
- FAIL fast with a direct config error such as:
  - `Missing NANOCLAW_API_KEY/ANTHROPIC_API_KEY for live runtime`
  - or `Missing NANOCLAW_BASE_URL/ANTHROPIC_BASE_URL for live runtime`

That is the desired failure mode on an unconfigured machine.

- [ ] **Step 5: Commit the live runner**

```bash
git add src/app/run-live-audit.ts package.json
git commit -m "feat: add manual live audit entrypoint"
```

---

### Task 5: Run the final regression wall and document the live configuration contract

**Files:**
- Modify: `README.md`
- Test: `__tests__/runtime/nanoclaw-bridge.test.ts`
- Test: `__tests__/runtime/real-ask-agent.test.ts`
- Test: `__tests__/runtime/run-local-policy-agent.test.ts`
- Test: `__tests__/app/policy-loop-behavior.test.ts`

- [ ] **Step 1: Add a minimal README section for the live NanoClaw runtime contract**

Append a short section to `README.md`:

```md
## Live runtime via NanoClaw bridge

The real policy-loop runtime uses a thin NanoClaw bridge at `src/runtime/nanoclaw-bridge.ts`.

Preferred environment variables:

```bash
NANOCLAW_API_KEY="..."
NANOCLAW_BASE_URL="https://your-proxy.example/v1"
NANOCLAW_LLM_PROVIDER="openai" # or anthropic
POLICY_AGENT_LLM_MODEL="gpt-5.4"
```

Fallback variables still supported for compatibility:

```bash
ANTHROPIC_API_KEY="..."
ANTHROPIC_BASE_URL="..."
ANTHROPIC_MODEL="..."
```

Manual live run:

```bash
pnpm live-audit
```
```

- [ ] **Step 2: Run the targeted final verification set**

Run:

```bash
pnpm --dir /Users/lingion/repo-downloads/local-policy-agent test __tests__/runtime/nanoclaw-bridge.test.ts __tests__/runtime/real-ask-agent.test.ts __tests__/runtime/run-local-policy-agent.test.ts __tests__/app/policy-loop-behavior.test.ts __tests__/app/run-policy-task.test.ts __tests__/search-fusion/cloudflare-search-local.test.ts __tests__/search-fusion/response-builder.test.ts
```

Expected:
- PASS
- Existing search/runtime governance tests remain green
- The new bridge tests pass

- [ ] **Step 3: Optionally run the full suite if the targeted wall is green**

Run:

```bash
pnpm --dir /Users/lingion/repo-downloads/local-policy-agent test
```

Expected:
- PASS
- Test count should be higher than before because the NanoClaw bridge coverage was added

- [ ] **Step 4: Commit the docs and final regression state**

```bash
git add README.md
git commit -m "docs: describe nanoclaw live runtime contract"
```

---

## Spec Coverage Check

This plan covers:
- a thin NanoClaw bridge instead of a local protocol-compat layer
- preservation of the `askRealClaudeDecision()` prompt/string boundary
- support for proxy base URLs and custom models like `gpt-5.4`
- NanoClaw-first env vars with Anthropic fallbacks
- richer debug transport metadata
- zero changes to the policy loop / pruning / termination core
- a manual live-audit entrypoint outside normal tests

No spec gaps found.

## Placeholder Scan

Checked for:
- `TODO`
- `TBD`
- “appropriate error handling” without exact behavior
- “similar to above” references
- omitted commands

No placeholders remain.

## Type Consistency Check

Locked names used consistently across tasks:
- `resolveRuntimeModel()`
- `resolveNanoclawRuntimeConfig()`
- `callNanoclawModel()`
- `NanoclawRuntimeConfig`
- `transport: 'nanoclaw' | 'injected-callModel'`

Plan complete and saved to `docs/superpowers/plans/2026-06-02-local-policy-agent-nanoclaw-live-runtime.md`.

Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
