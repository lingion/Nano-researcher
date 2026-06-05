# DecisionContext Judgment Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `DecisionContext` as the model-facing semantic preprocessing output of `JudgmentEngine` while preserving existing `run()` verdict compatibility.

**Architecture:** `JudgmentEngine.prepareContext(input)` computes deterministic metadata, source tier, semantic notes, risk signals, verification strategy, and model instructions. It does not call MCP, fetch, fs, or LLM. Existing `run(input)` remains as compatibility facade.

**Tech Stack:** TypeScript ESM, Node `node:test`, existing `JudgmentEngine`, `classifyCandidateTier`, and scanner config types.

---

## File Structure

- Create: `src/engine/decision-context.ts` — owns the `DecisionContext` interface and model-facing context types.
- Modify: `src/engine/judgment-engine.ts` — adds `prepareContext(input)` and helper logic.
- Create: `__tests__/engine/decision-context.test.ts` — TDD coverage for primary, derivative, official suffix PDF, and unknown source instructions.
- Verify: `__tests__/engine/judgment-engine.test.ts`, `__tests__/engine/tiering.test.ts`, `__tests__/engine/config-validation.test.ts`.

---

### Task 1: Add DecisionContext RED tests

**Files:**
- Create: `__tests__/engine/decision-context.test.ts`
- Create later: `src/engine/decision-context.ts`
- Modify later: `src/engine/judgment-engine.ts`

- [ ] **Step 1: Write failing tests**

Create `__tests__/engine/decision-context.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { JudgmentEngine } from '../../src/engine/judgment-engine.ts';

const config = {
  rules: {
    trusted_domains: ['.gov.cn', '.org.cn'],
    derivative_keywords: ['解读', '一图读懂'],
    pdf_elevation: true,
    default_search_engines: [],
    default_search_limit: 10,
    default_fetch_max_chars: 24000,
  },
  domains: {
    primary_source_domains: ['shanghai.gov.cn'],
    secondary_source_domains: ['service.example.cn'],
    official_suffixes: ['.gov.cn', '.org.cn'],
  },
};

test('prepareContext marks primary source candidates with high-authority model guidance', () => {
  const context = new JudgmentEngine(config).prepareContext({
    topic: '上海市公共场所控制吸烟条例',
    candidate: {
      finalUrl: 'https://www.shanghai.gov.cn/policy/detail.html',
      title: '上海市公共场所控制吸烟条例',
      content: '上海市公共场所控制吸烟条例 正文',
      kerry_cleaning: { metadata: {} },
    },
  });

  assert.equal(context.source.tier, 'primary_source_candidate');
  assert.equal(context.source.semanticNote, 'Primary official source candidate.');
  assert.equal(context.signals.exactTitleMatch, true);
  assert.ok(context.modelInstructions.some((item) => item.includes('high-authority source')));
  assert.ok(context.verificationStrategy.some((item) => item.includes('Verify policy title')));
});

test('prepareContext warns model about derivative-like candidates', () => {
  const context = new JudgmentEngine(config).prepareContext({
    topic: '上海市公共场所控制吸烟条例',
    candidate: {
      finalUrl: 'https://www.shanghai.gov.cn/policy/explain.html',
      title: '上海市公共场所控制吸烟条例 解读',
      content: '一图读懂 上海市公共场所控制吸烟条例',
      kerry_cleaning: { metadata: {} },
    },
  });

  assert.equal(context.signals.derivativeLike, true);
  assert.ok(context.modelInstructions.some((item) => item.includes('derivative or explanatory page')));
});

test('prepareContext keeps official suffix PDF outside primary as related source while marking official PDF', () => {
  const context = new JudgmentEngine(config).prepareContext({
    topic: '政策标题',
    candidate: {
      finalUrl: 'https://example.gov.cn/policy/detail.pdf',
      title: '政策标题',
      content: '%PDF-1.7 binary',
      kerry_cleaning: { metadata: {} },
    },
  });

  assert.equal(context.source.tier, 'official_repost_or_related');
  assert.equal(context.source.isOfficialPdf, true);
  assert.ok(context.modelInstructions.some((item) => item.includes('official suffix')));
});

test('prepareContext marks unknown sources as clue-only evidence', () => {
  const context = new JudgmentEngine(config).prepareContext({
    topic: '政策标题',
    candidate: {
      finalUrl: 'https://example.com/policy/detail.html',
      title: '政策标题',
      content: '政策标题 正文',
      kerry_cleaning: { metadata: {} },
    },
  });

  assert.equal(context.source.tier, 'unknown');
  assert.equal(context.source.semanticNote, 'Untrusted or unknown source candidate.');
  assert.ok(context.modelInstructions.some((item) => item.includes('Do not treat as authoritative')));
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
cd /Users/lingion/repo-downloads/local-policy-agent
pnpm exec tsx --test __tests__/engine/decision-context.test.ts
```

Expected: FAIL because `prepareContext` does not exist.

---

### Task 2: Implement DecisionContext and prepareContext

**Files:**
- Create: `src/engine/decision-context.ts`
- Modify: `src/engine/judgment-engine.ts`

- [ ] **Step 1: Create DecisionContext type**

Create `src/engine/decision-context.ts`:

```ts
import type { CandidateTier } from './tiering.ts';

export interface DecisionContext {
  topic: string;
  candidate: {
    finalUrl: string;
    title: string;
    contentPreview: string;
  };
  source: {
    tier: CandidateTier;
    semanticNote: string;
    isTrustedOfficialDomain: boolean;
    isOfficialPdf: boolean;
  };
  signals: {
    exactTitleMatch: boolean;
    derivativeLike: boolean;
    formatRisk: boolean;
  };
  verificationStrategy: string[];
  modelInstructions: string[];
}
```

- [ ] **Step 2: Add prepareContext to JudgmentEngine**

Modify `src/engine/judgment-engine.ts` to import `DecisionContext` and `classifyCandidateTier`, then add `prepareContext(input: EngineInput): DecisionContext` before `run()`.

Implementation requirements:

```ts
const text = [
  input.candidate.title,
  input.candidate.content,
  JSON.stringify(input.candidate.kerry_cleaning?.metadata ?? {}),
  input.candidate.finalUrl,
].join('\n');
const hostname = new URL(input.candidate.finalUrl).hostname;
const tier = classifyCandidateTier(input.candidate.finalUrl, this.config);
const exactTitleMatch = text.includes(input.topic);
const derivativeLike = this.config.rules.derivative_keywords.some((word) => text.slice(0, 3000).includes(word));
const formatRisk = /%PDF-|�|We're sorry but .*JavaScript|Access Denied/i.test(String(input.candidate.content ?? '').slice(0, 500));
const isPdf = /\.pdf(?:$|\?)/i.test(input.candidate.finalUrl);
const isTrustedOfficialDomain = this.config.rules.trusted_domains.some((suffix) => hostname.endsWith(suffix.replace(/^\./, '')));
const isOfficialPdf = isPdf && isTrustedOfficialDomain && this.config.rules.pdf_elevation;
```

Use explicit note/instruction mappings:

```ts
const semanticNotes = {
  primary_source_candidate: 'Primary official source candidate.',
  secondary_source_candidate: 'Secondary official source candidate.',
  official_repost_or_related: 'Official-domain related or repost candidate.',
  unknown: 'Untrusted or unknown source candidate.',
};
```

Include model instructions:

- Primary: `Treat as a high-authority source, but still verify title and content match the requested topic.`
- Secondary: `Use as official context, but confirm whether this is final policy text or a navigation/service page.`
- Official related: `Do not assume final policy authority solely from an official suffix; verify whether it is verbatim policy text or a pointer to the primary source.`
- Unknown: `Do not treat as authoritative without corroborating official evidence.`
- Derivative signal: `This candidate looks like a derivative or explanatory page; do not treat it as final official policy text without stronger evidence.`

- [ ] **Step 3: Run DecisionContext tests to verify GREEN**

Run:

```bash
cd /Users/lingion/repo-downloads/local-policy-agent
pnpm exec tsx --test __tests__/engine/decision-context.test.ts
```

Expected: `# pass 4`, `# fail 0`.

---

### Task 3: Regression verification

**Files:**
- Verify: engine tests and build.

- [ ] **Step 1: Run focused engine tests**

Run:

```bash
cd /Users/lingion/repo-downloads/local-policy-agent
pnpm exec tsx --test \
  __tests__/engine/decision-context.test.ts \
  __tests__/engine/tiering.test.ts \
  __tests__/engine/judgment-engine.test.ts \
  __tests__/engine/config-validation.test.ts \
  __tests__/policy-scanner/judge-candidate.test.ts
```

Expected: all tests pass, `# fail 0`.

- [ ] **Step 2: Run build**

Run:

```bash
cd /Users/lingion/repo-downloads/local-policy-agent
pnpm build
```

Expected: exit code 0.

---

## Self-Review

- Spec coverage: Covers `DecisionContext`, `prepareContext`, semantic notes, signal rules, verification strategy, model instructions, and compatibility with `run()`.
- Placeholder scan: No placeholder work remains; all test and implementation steps specify concrete code or exact strings.
- Type consistency: `DecisionContext`, `CandidateTier`, `EngineInput`, and `JudgmentEngine.prepareContext()` are named consistently.
