# Nano-researcher Unification Implementation Plan

## Working Rules

- Work on the existing `main` checkout without resetting unrelated changes.
- Preserve the untracked user-owned `tasks/` directory.
- Use test-first changes for each slice.
- After each slice run the focused tests, `git diff --check`, and
  `pnpm build`.
- Keep the Agent decision protocol and generic state contract stable.
- Do not package or add a second independent search project.

## Slice 1: Provider Response Semantics

Files:

- `src/search/auto/providers/engines.ts`
- `src/search/auto/engine-runner.ts`
- `src/search/auto/providers/result.js`
- `src/search/auto/providers/http.js`
- `__tests__/search/auto/`

Steps:

1. Add characterization tests for CAPTCHA, HTTP error, timeout, parser failure,
   valid empty response, retry count, request count, and metadata placement.
2. Make normalization preserve the provider's explicit diagnostics and map
   only mechanical transport states.
3. Normalize `sourceFamily` and `resultType` at the top level of every result;
   retain metadata only for additional provider facts.
4. Aggregate all attempt diagnostics in `SearchResponseEngine` instead of
   reading only the first diagnostic entry.
5. Run focused provider tests, `git diff --check`, and `pnpm build`.

## Slice 2: Auto Execution and Ranking Inputs

Files:

- `src/search/auto/auto.ts`
- `src/search/auto/engine-runner.ts`
- `src/search/auto/contracts.ts`
- `src/search/auto/fusion-ranker.js`
- `__tests__/search/auto/`

Steps:

1. Add tests proving pre-aborted signals make zero calls and sibling provider
   failures do not discard successful results.
2. Enforce the configured provider-call budget in one bounded batch of up to
   eight providers unless the caller explicitly selects a smaller limit.
3. Remove result-count-only early stopping from the default path. Keep only
   technical deadline, cancellation, provider budget, and all-engines stops.
4. Keep duplicate, filtered, and output-limit counts as separate diagnostics.
5. Verify ranker constraints against normalized top-level fields without adding
   query/domain intent rules.

## Slice 3: Fetch and Browser Fallback

Files:

- `src/fetch-fusion/local-fetch-primary.ts`
- `src/fetch-fusion/browser-fetch.ts`
- `src/fetch-fusion/html-extraction-worker.cjs`
- `src/app/create-generic-dependencies.ts`
- `__tests__/fetch-fusion/`

Steps:

1. Add tests for extraction worker failure followed by browser fallback,
   cancellation propagation, weak content, CSS warnings, and dynamic content.
2. Convert extraction failures into structured warnings when they are not
   cancellation or transport failures.
3. Preserve the static response facts while allowing the browser provider to
   produce a replacement page fact.
4. Add bounded body/content checks and rendered-page extraction without using
   an unbounded `networkidle` wait.
5. Remove generic-path domain derivation such as policy, government, beta,
   fixed date, and product-radar fields.

## Slice 4: Fetch Facts and Report Data

Files:

- `src/agent/action-executor.ts`
- `src/artifacts/generic-report.ts`
- relevant event/state types and tests

Steps:

1. Add tests that verify fetch events retain provider, requested URL, final URL,
   render mode, content type, duration, retries, and extraction warnings.
2. Carry answer and evidence data into the generic report without converting
   absent data into the string or semantic value `null`.
3. Keep transport failure, extraction weakness, and model answer status distinct
   in the report projection.
4. Verify report serialization and redaction behavior.

## Slice 5: Monitor HTTP Routes and Projection

Files:

- `src/adapters/http/server.ts`
- `src/adapters/http/monitor-page.ts`
- `__tests__/adapters/http.test.ts`

Steps:

1. Add route tests for `/monitor`, `/monitor/<id>`, unknown IDs, and legacy
   `?runId=` compatibility.
2. Keep static monitor routing before external authorization checks so the
   fragment token can be consumed by the page.
3. Add path ID parsing and canonical URL generation while retaining old query
   compatibility.
4. Keep projection fields at the top level and request full data only when
   needed by the detail page.
5. Map report artifact paths correctly whether they are stored as absolute or
   relative paths.

## Slice 6: Monitor UI and Browser Verification

Files:

- `src/adapters/http/monitor-page.ts`
- `__tests__/adapters/monitor-page.test.ts`
- browser test files if needed

Steps:

1. Replace dynamic list buttons with accessible links and a real back link.
2. Split run summary, answer/report, and events into separate semantic regions.
3. Render the top-level projection fields and full answer/evidence fields from
   actual API responses.
4. Stop polling on non-recoverable errors and expose an explicit retry action.
5. Add `aria-live`, `role=status`, `aria-busy`, `datetime`, focus-visible, and
   responsive layout rules.
6. Run JSDOM security/behavior tests and Playwright checks at five widths.

## Slice 7: Product Rename

Files:

- `package.json`
- `README.md`, `README.zh.md`
- `src/runtime/log.ts`
- `src/adapters/http/server.ts`
- `src/runtime/search-mcp-tool-adapter.ts`
- current architecture/production documents
- tests that assert current user-visible names or default paths

Steps:

1. Add characterization checks for current name and storage compatibility.
2. Change current user-visible product identifiers to `Nano-researcher`.
3. Use a new default output directory only if old directory reads remain
   compatible; otherwise keep the existing path and rename only the display
   identity in this pass.
4. Do not mechanically rewrite historical audit records or fixtures. The
   remote GitHub slug is changed only by the explicitly authorized publication
   step after local validation.
5. Run focused rename tests and inspect all remaining current-path references.

## Slice 8: Final Verification and Live Probe

Steps:

1. Run `pnpm test` and `pnpm build`.
2. Run `git diff --check` and inspect the complete diff for scope creep.
3. Start the local HTTP server on an available loopback port.
4. Verify monitor list, canonical detail, legacy URL normalization, token
   handling, polling termination, and responsive rendering in a real browser.
5. Run a bounded real provider/fetch probe using the existing local environment
   without exposing credentials or committing runtime artifacts.
6. Report current-run evidence separately from historical logs and environment
   blockers.
