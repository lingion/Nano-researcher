# Production Ready Handoff

Generated: 2026-06-05
Project: `Nano-researcher` (legacy repository slug: `local-policy-agent`)

## 1. Final Repository State

`Nano-researcher` has been converted from an ad hoc project directory into a portable engineering delivery artifact with:

- production baseline committed to git
- explicit runtime environment documentation
- offline Golden Fixture regression
- prompt freeze documentation
- vendored Search MCP worker entrypoint
- zero-config startup checklist

Current baseline commits:

1. `ca64766 chore: lock policy agent production baseline`
   - Locked the production baseline.
   - Archived the Heavy Prompt live-audit evidence baseline.
   - Added README, fixtures, prompt-freeze documentation, core source, and tests.

2. `e37851c chore: add portable startup checks`
   - Added zero-config startup metadata.
   - Added `.nvmrc` and `.env.example`.
   - Added offline Golden Fixture regression.
   - Removed local-machine absolute path dependencies from source/test/doc surfaces.
   - Fixed the package start script.

## 2. Production Baseline Assets

### NanoClaw gateway provider lock

OpenAI-compatible gateway live runs must explicitly set:

```bash
NANOCLAW_LLM_PROVIDER=openai
```

This is part of the production startup contract. Do not rely on automatic provider inference for the OpenAI-compatible gateway path.

### Golden Fixture archive

The Shanghai Putuo 2026 medical subsidy trace is archived as the first Golden Fixture:

```text
fixtures/live-audit/shanghai-medical-subsidy-debug-trace.json
fixtures/live-audit/shanghai-medical-subsidy-golden-fixture-evaluation-baseline.html
```

The fixture validates that the Agent:

- reaches final decision `stop`
- uses the official `shpt.gov.cn` source
- identifies document ID `普卫健行办〔2026〕1号`
- identifies issuer `上海市普陀区卫生健康委员会`
- preserves 2026 applicability
- extracts multiple recipient-specific subsidy amount clauses
- preserves the boundary that this is a Putuo district-level document, not a Shanghai-wide subsidy catalogue
- preserves the boundary that this is a budget/subsidy allocation notice, not an open public application guide
- discards `shui5.cn` as a non-official source

### Prompt freeze

Prompt baseline documentation lives at:

```text
docs/prompt-freeze.md
```

Rule:

- `src/policy-task/prompt-builder.ts` is a frozen production baseline asset.
- Do not change Heavy Prompt logic unless a new regression trace demonstrates a prompt-level failure that cannot be explained by infrastructure, provider, search, fetch, parsing, or rendering behavior.
- Infrastructure changes must pass the Golden Fixture before prompt changes are considered.

## 3. Zero-Config Startup Contract

### Runtime versions

Validated environment:

```text
Node.js: v22.21.0
pnpm: 10.33.0
```

Node version is pinned in:

```text
.nvmrc
```

### Environment template

Live audit configuration template:

```text
.env.example
```

Required live variables:

```bash
NANOCLAW_LLM_PROVIDER=openai
NANOCLAW_BASE_URL=https://<your-openai-compatible-gateway>/v1/chat/completions
NANOCLAW_API_KEY=<your-gateway-key>
```

Optional variables:

```bash
POLICY_AGENT_LLM_MODEL
NANOCLAW_MODEL
SEARCH_MCP_WORKER_PATH
LIVE_AUDIT_DEBUG
LIVE_AUDIT_DIAG
```

### Dependency lockfile

`pnpm-lock.yaml` is committed and is the canonical dependency lockfile.

## 4. Fresh Machine Verification

After cloning on another machine, use:

```bash
nvm use
corepack enable
pnpm install
pnpm build
pnpm test:fixture
```

To run live audit:

```bash
cp .env.example .env
# Fill NANOCLAW_BASE_URL and NANOCLAW_API_KEY.
pnpm live-audit
```

Minimum acceptance criteria:

- `pnpm install` succeeds
- `pnpm build` succeeds
- `pnpm test:fixture` succeeds
- no local machine path is required
- offline fixture regression does not require credentials or network access
- live audit missing-env cases produce explicit configuration errors instead of silent failure

## 5. Verification Evidence

Clean-environment simulation performed:

```bash
rm -rf node_modules dist
pnpm install
pnpm build
pnpm test:fixture
```

Observed results:

```text
pnpm install: success
pnpm build: success, tsc -p tsconfig.json exit 0
pnpm test:fixture: success
```

Golden Fixture regression output:

```text
TAP version 13
# Subtest: golden fixture proves Putuo medical subsidy trace is regression-ready offline
ok 1 - golden fixture proves Putuo medical subsidy trace is regression-ready offline
1..1
# tests 1
# pass 1
# fail 0
```

Portability-focused source tests:

```bash
pnpm exec tsx --test src/runtime/search-mcp-tool-adapter.test.ts src/app/run-policy-task.workspace.test.ts
```

Observed result:

```text
1..4
# tests 4
# pass 4
# fail 0
```

Packaging portability tests:

```bash
pnpm exec tsx --test __tests__/packaging.test.ts
```

Observed result:

```text
1..3
# tests 3
# pass 3
# fail 0
```

Absolute path audit:

```bash
grep -RIn '/Users/lingion' package.json tsconfig.json src bin scripts __tests__ README.md .env.example
```

Observed result: no output.

## 6. Engineering Handoff Conclusion

The repository is ready for push or transfer as a production baseline:

- git baseline is committed
- Heavy Prompt is frozen and documented
- Golden Fixture is committed as a regression asset
- README contains the zero-config startup checklist
- `.nvmrc` and `.env.example` are committed
- local absolute-path dependencies have been removed from source/test/doc surfaces
- build and offline regression have been verified from a clean install

Use `pnpm install`, `pnpm build`, and `pnpm test:fixture` as the first acceptance gate on any new machine.
