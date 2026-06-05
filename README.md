# local-policy-agent

Standalone local policy agent runtime built on top of transplanted NanoClaw orchestration core.

## Principles
- NanoClaw core is embedded directly.
- Search discovers candidate URLs only.
- Fetch retrieves page evidence only.
- Business judgment lives in prompts and agent outputs, not code rules.

## Quick start

Live audit runs should pin the NanoClaw gateway protocol explicitly. For the current OpenAI-compatible gateway baseline, set:

```bash
export NANOCLAW_LLM_PROVIDER=openai
export NANOCLAW_BASE_URL="https://<your-openai-compatible-gateway>/v1/chat/completions"
export NANOCLAW_API_KEY="<your-gateway-key>"
pnpm live-audit
```

`NANOCLAW_LLM_PROVIDER=openai` is part of the production startup contract: do not rely on automatic provider inference for the OpenAI-compatible gateway path.

```bash
pnpm test
```

Expected once scaffolding is complete:
- the test command exists
- it runs the project test suite

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
