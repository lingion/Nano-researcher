# Model-Owned Decision Execution Architecture

## Goal

Make the model the sole owner of business decisions in `local-policy-agent`. Runtime and tools must execute, observe, transport, persist, and report facts without deciding whether to continue, stop, trust evidence, classify a product, or satisfy a business target.

## Non-goals

- Do not add runtime rules for mainland scope, date windows, early-access scoring, official-source scoring, evidence sufficiency, result counts, or product deduplication.
- Do not force search or fetch because a configured target is not met.
- Do not force summary because a validation count is met.
- Do not silently rewrite a model decision into `stop`, `summarize_and_stop`, or another business decision.

## Authority boundary

### Model

The model decides search and fetch strategy, repeated actions, source and evidence interpretation, date and geography meaning, access status, product/entity grouping, final package content, and whether to continue or stop.

### Runtime

The runtime parses model output, validates only the minimum executable protocol shape, schedules actions, creates stable decision/action/attempt IDs, projects transport state into the next model turn, handles cancellation/recovery, and persists events. It must not apply business gates or rewrite decisions.

### Tools

Search, fetch, and browser adapters perform real calls and report transport facts: request parameters, status, redirects, content type, content length, body, truncation, empty responses, provider errors, and retry attempts. They may retry transport failures and switch technical backends, but must not classify business meaning.

### Preprocessing and persistence

Preprocessing may mechanically extract text, links, metadata, and date strings without interpreting them. Persistence stores append-only events, supports replay, and separates raw/debug data from business output with secret redaction.

## Decision protocol

Model output is retained as:

- `model.raw_output`
- `model.parsed_output`
- `model.protocol_error` when applicable

Canonical action fields use one schema consistently. `final_package` is the wire field; compatibility conversion must be explicit and tested. Unknown business fields are preserved. Unknown or missing decisions are protocol errors, never implicit `stop`.

Protocol validation is limited to executable shape:

- top-level JSON must parse;
- action collections must be arrays when present;
- search `query` must be a string;
- fetch `url` must be a syntactically parseable URL;
- required transport values must be representable.

A malformed action yields an action-scoped protocol error while valid sibling actions may execute. A malformed top-level decision executes no actions and returns a decision-scoped protocol error to the model. No protocol error becomes a business stop.

## Action and attempt lifecycle

Each model turn receives a `decisionId`. Each emitted action receives an `actionId`. Each execution attempt receives an `attemptId` and an `attemptKind`:

- `automatic_retry`
- `model_reissue`
- `recovery`

Repeated model actions are not silently deduplicated. They are new actions and remain attributable to the model. Automatic retries belong to the same action and are visible in the next model input.

Default execution is serial in model output order. A failed action does not discard successful sibling actions. If cancellation occurs, unstarted actions remain unstarted and in-flight actions report cancellation; runtime does not manufacture a business decision.

## Tool result protocol

Tool results describe execution facts only:

- `success_with_content`
- `success_empty`
- `http_error`
- `transport_error`
- `timeout`
- `protocol_error`
- `cancelled`

Each result includes action/attempt identity, backend, requested and final URL where relevant, status, content type, content length, truncation state, retryability, retry metadata, and a structured error where applicable. It must never emit `official`, `noise`, `evidence_sufficient`, `early_access`, `out_of_scope`, `should_continue`, or `should_stop` as a runtime conclusion.

## Retry and fallback

Adapters may automatically retry transient transport failures such as connection errors, timeouts, 429, and 5xx. Each attempt and scheduled retry is persisted and exposed to the model. Exhausting an adapter's current retry sequence returns a transparent transport result; it does not stop the run. The model may issue the action again.

Browser or direct HTTP fallback is a technical backend attempt with the same action ID and a new attempt ID. All backend outcomes remain available; one backend result must not overwrite another. Empty content is a transport fact and may trigger a technical fallback, but the model decides what the content means.

## Model turn projection

A dedicated `ModelTurnInput` excludes secrets and internal implementation fields while retaining all business-relevant facts:

- task and prior model decisions;
- action and attempt history;
- tool results and errors;
- content, status, redirect, truncation, and retry facts;
- protocol errors;
- cancellation and recovery facts.

API keys, cookies, authorization headers, internal paths, process identifiers, and raw sensitive headers never enter model context or ordinary logs. Raw model output is stored separately and never injected into `final_package`.

## Event persistence and recovery

Events are append-only and carry event ID, sequence, timestamp, decision ID, action ID when applicable, attempt ID when applicable, type, and payload. Recovery replays complete events. An attempt with a start but no terminal event is marked interrupted; runtime reports that fact and does not infer whether to retry or stop. Writes must be crash-safe and idempotently replayable.

## Testing and verification

The implementation must be verified with real calls, not only fake tools:

1. Search MCP startup, handshake, successful search, empty search, provider error, timeout, repeated query, worker restart, and retry.
2. Fetch success, empty body, 404, 403/challenge, 5xx, redirect, non-HTML, slow response, repeated URL, and retry.
3. Browser/direct fallback success and failure, preserving all attempts.
4. Real gateway decisions for valid search/fetch/summary, malformed action, unknown decision, empty/truncated output, partial action success, retry-visible turns, cancellation, and recovery.
5. Assertions that runtime never rewrites business decisions, applies target/date/evidence gates, or converts protocol/transport failures into stop.

The audit report must separate model-owned decisions from runtime/tool defects and rank only reproduced or directly evidenced issues P0-P3.
