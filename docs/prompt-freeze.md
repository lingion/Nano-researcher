# Prompt Asset Freeze

The policy prompt builder is treated as a frozen production asset for the current baseline.

## Frozen file

- `src/policy-task/prompt-builder.ts`

## Baseline evidence

- Golden trace: `fixtures/live-audit/shanghai-medical-subsidy-debug-trace.json`
- Human audit report: `fixtures/live-audit/shanghai-medical-subsidy-golden-fixture-evaluation-baseline.html`

## Operating rule

Do not adjust Heavy Prompt logic unless a new regression trace demonstrates a prompt-level failure that cannot be explained by infrastructure, provider, search, fetch, parsing, or artifact rendering behavior.

Infrastructure changes must be validated against the Golden Fixture before proposing prompt changes.
