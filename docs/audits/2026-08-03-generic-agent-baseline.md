# Generic Agent Migration Baseline

**Observation date:** 2026-08-03
**Snapshot:** `main` at `fdf793e` with a pre-existing dirty worktree from the supplied archive
**Backup:** Created outside the repository before migration; local path and checksum intentionally omitted.

## Verification baseline

| Command | Result | Evidence |
|---|---|---|
| `pnpm build` | PASS | TypeScript compilation completed |
| `pnpm test:fixture` | PASS | 1 test passed |
| `pnpm test` | PASS | 263 tests passed before generic migration changes |
| direct local search probe | WEAK | AI-product query returned 0 candidates after about 11 seconds |
| direct gov.cn fetch probe | WEAK | HTTP succeeded but extracted content was about 105 characters of footer text |

## Observed default runtime path

```text
src/app/run-live-audit.ts
  -> createLiveAuditRuntime
  -> createSearchMcpTools
  -> runLiveAudit
  -> runPolicyTaskLoop
  -> askRealClaudeDecision
  -> local-session-loop
  -> MCP search_auto / fetch_url
  -> workspace and domain-specific report artifacts
```

The repository also contains local search/fetch implementations, but the
current composition root uses the vendored Search MCP toolset by default.

## Observed transition state

- `src/policy-scanner` and `src/engine` represent the earlier policy-scanning
  direction.
- `src/search-fusion`, `src/fetch-fusion`, early-access artifacts, and the
  current prompt represent the later product/access radar direction.
- `src/nanoclaw-core` and `vendor/search-mcp` provide host/provider-specific
  runtime behavior.
- The worktree contains large uncommitted changes and generated artifacts;
  these are preserved as migration input and are not treated as a clean
  architectural baseline.

## Migration limits

- No current LLM gateway credential is used by baseline probes.
- Real provider behavior depends on network availability and provider access.
- No business conclusion from the current policy or early-access reports is
  treated as a generic-agent requirement.
- The first implementation phase adds generic contracts without deleting
  legacy modules.
