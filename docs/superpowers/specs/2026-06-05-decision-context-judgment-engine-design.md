# DecisionContext Judgment Engine Design

## Goal

Refocus `JudgmentEngine` from hard-coded scoring toward deterministic semantic preprocessing for LLM/Agent judgment. The engine should compute stable metadata and prompt guidance, then expose it as `DecisionContext` for downstream model arbitration.

## Non-Goals

- Do not connect MCP, search, fetch, or Agent Runtime inside `JudgmentEngine`.
- Do not implement numeric quality scoring or additive weights.
- Do not remove existing `run()` compatibility behavior yet.

## Architecture

`JudgmentEngine` will expose two paths:

1. `prepareContext(input: EngineInput): DecisionContext`
   - New core interface.
   - Pure deterministic preprocessing.
   - Computes tiering, authority signals, derivative/format risks, and model-facing instructions.

2. `run(input: EngineInput): CandidateVerdict`
   - Existing compatibility facade.
   - Preserves CLI and old tests while migration continues.

Data flow:

```text
EngineInput(topic + candidate + config)
  -> JudgmentEngine.prepareContext()
  -> DecisionContext
  -> Agent Runtime / LLM final arbitration later
```

## DecisionContext Contract

```ts
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

## Semantic Rules

- `primary_source_candidate`
  - `semanticNote`: `Primary official source candidate.`
  - Model instruction: treat as high-authority source, but still verify title/content match.
  - Verification strategy: verify policy title, document number if present, and body relevance.

- `secondary_source_candidate`
  - `semanticNote`: `Secondary official source candidate.`
  - Model instruction: useful official context, but confirm whether it is final policy text.
  - Verification strategy: look for links or clues pointing to primary-source text.

- `official_repost_or_related`
  - `semanticNote`: `Official-domain related or repost candidate.`
  - Model instruction: do not assume it is final policy text solely because it is on an official suffix.
  - Verification strategy: check whether content is verbatim policy text or points to the official source.

- `unknown`
  - `semanticNote`: `Untrusted or unknown source candidate.`
  - Model instruction: do not treat as authoritative without corroborating official evidence.
  - Verification strategy: use as clue only; require official-source confirmation.

## Signal Rules

- `exactTitleMatch`: candidate title/content/metadata/url includes the topic.
- `derivativeLike`: candidate first 3000 chars or metadata includes configured derivative keywords.
- `formatRisk`: candidate content begins with common corrupt, JS shell, or access-denied markers.
- `isOfficialPdf`: final URL ends in `.pdf` and hostname matches `rules.trusted_domains` while `rules.pdf_elevation` is enabled.

## Error Handling

Existing constructor validation remains the safety gate. Bad config throws `ConfigValidationError` before any context can be prepared.

## Testing

Add `__tests__/engine/decision-context.test.ts` to cover:

- Primary source context and model instruction.
- Derivative-like context warning.
- Official suffix PDF that is not primary remains `official_repost_or_related` but gets `isOfficialPdf: true`.
- Unknown source gets clue-only instruction.

## Compatibility

- Existing `run()` remains.
- Existing `judgeCandidate` facade remains.
- No Provider/MCP integration in this phase.
