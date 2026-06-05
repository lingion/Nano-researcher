# local-policy-agent

Standalone local policy research runtime with:
- NanoClaw-based live audit orchestration
- **MCP-only search/fetch backend** by default
- prompt-driven evidence judgment
- convergence flow that ends in `summarize_and_stop`

## What this repo does

`local-policy-agent` runs a policy research loop:
1. the model decides whether to search, fetch, review, or summarize
2. search discovers candidate URLs only
3. fetch retrieves page evidence only
4. evidence classification (`GOLD_STANDARD` / `SILVER_STANDARD` / `NOISE`) drives convergence
5. after enough validated evidence is collected, the runtime forces a two-step ending:
   - `post_convergence_review`
   - `final_summary`
6. the final output is a summary package, not an endless search loop

## Current architecture

### Search and fetch

The runtime is now **hard-wired to the vendored Search MCP worker** for its default owned tool path.
There is no legacy Cloudflare-style default search path in the main execution flow anymore.

Default runtime-owned backend:
- search: `search-mcp`
- fetch: `search-mcp:fetch_url`

Relevant files:
- `src/app/run-policy-task.ts`
- `src/app/run-live-audit.ts`
- `src/runtime/search-mcp-tool-adapter.ts`
- `vendor/search-mcp/src/stdio-server.js`

### Judgment model

Business judgment stays in the model contract, not in hard-coded policy rules.
The model must:
- decide when to search vs fetch
- classify fetched evidence
- avoid premature finalization after fetch
- produce the final summary package only in the summary phase

Relevant files:
- `src/policy-task/prompt-builder.ts`
- `src/runtime/ask-real-claude.ts`
- `src/runtime/local-session-loop.ts`
- `src/runtime/termination-policy.ts`

## Requirements

Validated on:
- Node.js `v22.21.0`
- pnpm `10.33.0`

If you use `nvm`:

```bash
nvm use
corepack enable
```

## Install

```bash
pnpm install
pnpm build
```

## Environment

Copy the example file first:

```bash
cp .env.example .env
```

Required live-audit variables:
- `NANOCLAW_LLM_PROVIDER=openai`
- `NANOCLAW_BASE_URL`
- `NANOCLAW_API_KEY`

Optional model override:
- `NANOCLAW_MODEL=gpt-5.4`
- `POLICY_AGENT_LLM_MODEL=gpt-5.4`

Notes:
- the runtime expects an OpenAI-compatible NanoClaw gateway for live runs
- the Search MCP worker is vendored in-repo and used by default
- you usually do **not** need to set a separate search backend flag

## Common commands

### Build

```bash
pnpm build
```

### Full test suite

```bash
pnpm test
```

### Offline golden fixture regression

```bash
pnpm test:fixture
```

### Live audit

```bash
pnpm live-audit
```

Example with explicit topic and debug:

```bash
LIVE_AUDIT_TOPIC='常州市 医疗补贴' \
LIVE_AUDIT_MAX_ITERATIONS=10 \
LIVE_AUDIT_DEBUG=1 \
pnpm live-audit
```

## Execution guarantees

The current runtime behavior is intentionally strict:
- default owned search path is MCP-only
- fetched evidence is classified before valid summary termination
- `post_convergence_review` can no longer be prematurely terminated by `finalize`
- the loop can advance into `final_summary` and end with `summarize_and_stop`

## Important repo contents

- `src/app/run-live-audit.ts` — live audit entrypoint
- `src/app/run-policy-task.ts` — outer loop controller
- `src/runtime/local-session-loop.ts` — per-iteration execution
- `src/runtime/search-mcp-tool-adapter.ts` — MCP search/fetch bridge
- `src/policy-task/prompt-builder.ts` — agent contract
- `vendor/search-mcp/` — vendored MCP worker used by the runtime

## Verification baseline for the latest search/convergence work

Recent verified outcomes:
- MCP-only default backend path is covered by regression tests
- convergence regression covers `post_convergence_review -> final_summary -> summarize_and_stop`
- live audit for `常州市 医疗补贴` now reaches `summarize_and_stop` instead of getting stuck at premature `finalize`

## Non-goals

This repo is **not** trying to:
- hard-code policy decisions in runtime logic
- treat search snippets as evidence
- preserve legacy default search behavior for compatibility

The intended direction is:
- stronger MCP search/fetch quality
- better prompt contracts
- more reliable evidence-grounded summaries
