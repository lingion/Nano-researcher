# Nano-researcher Unification Design

## Status

Approved implementation direction: A, generic autonomous research agent.

This change keeps the original product intent: one model-directed research
agent that decides when to search, when to fetch, when to review evidence, and
when to finish. The runtime executes those decisions and records technical
facts. Search, fetch, ranking, and presentation are separate layers.

## Product Boundary

The product name shown by the package, HTTP monitor, MCP client metadata, logs,
README, and current architecture documents is `Nano-researcher`.

The default public operation remains the unified `Auto` search provider. Other
engines are provider implementations inside this repository. SearXNG and
other projects are not embedded as applications; only selected provider logic
is adapted into the existing provider contract.

The GitHub repository is being renamed from `lingion/local-policy-agent` to
`lingion/Nano-researcher` as a separate, explicitly authorized repository
operation after local validation. The old URL remains a GitHub redirect for
existing links, while the repository's canonical remote and documentation use
the new slug.

## Non-Negotiable Constraints

1. The Agent remains the authority for search, fetch, review, and finish.
2. The runtime may enforce only technical limits: cancellation, deadlines,
   response size, request budgets, concurrency, and protocol validity.
3. The generic path must not infer policy, beta status, officiality, geography,
   evidence sufficiency, target counts, or date-window business conclusions.
4. Search discovery is not fetch evidence. Fetch success and extraction quality
   are reported separately.
5. Provider failures must remain distinguishable from a valid empty result.
6. The existing decision wire protocol and canonical result schema are not
   changed as part of this pass.
7. The existing `tasks/` directory is user-owned and is not modified, staged,
   deleted, or included in commits.

## Layered Runtime

```text
Agent decision
  -> Auto search provider
       -> provider requests (at most the caller budget, default 8)
       -> provider normalization and attempt diagnostics
       -> mechanical fusion ranking
  -> fetch provider
       -> bounded static request
       -> structured extraction warning or browser fallback
       -> normalized page facts
  -> monitor projection and report
```

### Search provider layer

Every engine returns a normalized response containing outcome, results,
duration, retry count, request count, attempted URL facts, parser version, and
blocked or parse diagnostics. `success_empty` means the request and parser
completed normally and no records were found. HTTP, transport, timeout,
blocked, and parser failures remain explicit.

`sourceFamily` and `resultType` are normalized at the result boundary so the
fusion ranker sees the same fields regardless of which provider produced them.
The ranker may use query text, provider rank, duplication, and declared source
metadata as mechanical signals. It does not assign domain truth or officiality.

### Auto orchestration layer

Auto executes one bounded batch of eligible providers, with a caller-selected
maximum of eight by default for the current request. It records all attempted
providers and failures. It does not stop merely because an arbitrary number of
results was reached, and it does not add domain-specific query expansion.
Provider order is a configuration concern. The Agent decides whether another
search action is needed in a later turn.

### Fetch layer

Static transport, HTML extraction, and browser rendering are technical fetch
steps. A static extraction failure produces a structured warning and may allow
the configured browser fallback to run. Cancellation is propagated directly.
Browser rendering uses `domcontentloaded` plus bounded content checks; it does
not wait indefinitely for `networkidle`. Rendered HTML or text is passed to the
same generic extraction boundary when available.

No government-domain, policy-number, early-access, waitlist, or fixed-date
classification is performed by the generic fetch path. Those legacy behaviors
remain isolated from the generic composition root.

### Monitor layer

`GET /monitor` displays current runs. Each run is a real link to
`/monitor/<runId>`. The detail route uses the projection endpoint first and
requests `?include=full` only when the answer or full evidence is needed.

`GET /monitor/<runId>` is canonical. `GET /monitor?runId=<runId>` remains a
compatibility entry point and is normalized to the path form in the browser.
The fragment token flow remains supported without putting credentials in URLs,
localStorage, logs, or rendered text.

The page has separate regions for run summary, answer/report, and event stream.
All untrusted values are rendered as text. Terminal errors stop polling and
offer an explicit retry. Status and event updates use accessible live regions.

## Acceptance Criteria

- A provider HTTP 403, CAPTCHA, timeout, network failure, parse failure, and
  valid empty response produce different outcomes and diagnostics.
- Auto does not issue more provider calls than the configured maximum and
  preserves sibling successes when one provider fails.
- A pre-aborted request makes zero provider calls and returns a cancellation
  outcome without scheduling a retry loop.
- CSS or stylesheet parsing failure is an extraction warning; browser fallback
  is attempted when enabled and the failure is visible in facts.
- Generic fetch facts include requested URL, final URL, render mode, content
  type, duration, retries, and extraction warnings where available.
- `/monitor`, `/monitor/<runId>`, and the legacy query URL render the same run
  using the actual projection fields. Answer and report links do not display as
  `null` when the API has data.
- Monitor behavior is verified at 320, 375, 768, 1024, and 1440 CSS pixels.
- `pnpm test`, `pnpm build`, and focused browser checks pass after changes.
- User-facing current product text says `Nano-researcher`; old storage paths
  remain readable where changing them would break existing runs.
