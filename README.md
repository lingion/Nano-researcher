# local-policy-agent

Standalone local policy agent runtime built on top of transplanted NanoClaw orchestration core.

## Principles
- NanoClaw core is embedded directly.
- Search discovers candidate URLs only.
- Fetch retrieves page evidence only.
- Business judgment lives in prompts and agent outputs, not code rules.

## Zero-config startup checklist

Use this section when cloning the repository on a fresh machine.

### Runtime versions

This project is validated with:

- Node.js: `v22.21.0` (see `.nvmrc`)
- pnpm: `10.33.0`

If you use `nvm`:

```bash
nvm use
corepack enable
```

### Fresh install and build

```bash
pnpm install
pnpm build
```

`pnpm-lock.yaml` is committed and should be used as the dependency lockfile.

### Offline Golden Fixture regression

This check does not require live credentials or network access:

```bash
pnpm test:fixture
```

It validates the archived Shanghai Putuo 2026 medical subsidy trace under:

- `fixtures/live-audit/shanghai-medical-subsidy-debug-trace.json`
- `fixtures/live-audit/shanghai-medical-subsidy-golden-fixture-evaluation-baseline.html`

### Live audit configuration

Copy `.env.example` to `.env` and fill in the gateway values before running live audit:

```bash
cp .env.example .env
```

Required live variables:

- `NANOCLAW_LLM_PROVIDER=openai`
- `NANOCLAW_BASE_URL`
- `NANOCLAW_API_KEY`

Live audit runs should pin the NanoClaw gateway protocol explicitly. For the current OpenAI-compatible gateway baseline, set:

```bash
export NANOCLAW_LLM_PROVIDER=openai
export NANOCLAW_BASE_URL="https://<your-openai-compatible-gateway>/v1/chat/completions"
export NANOCLAW_API_KEY="<your-gateway-key>"
pnpm live-audit
```

`NANOCLAW_LLM_PROVIDER=openai` is part of the production startup contract: do not rely on automatic provider inference for the OpenAI-compatible gateway path.

## Dev smoke test

```bash
pnpm test
```

## Current milestone

This repository currently contains:
- transplanted NanoClaw orchestration core
- thin local host runtime
- a search fusion boundary
- a fetch fusion boundary
- a minimal task runner and artifact pipeline

## Next implementation target

1. Make the local Cloudflare-derived search MCP the first real discovery backend.
2. Harvest and evaluate stronger fetch/extraction open-source projects.
3. Wire the NanoClaw poll loop to the real search and fetch boundaries.
4. Keep all business judgment in prompts and agent outputs.
