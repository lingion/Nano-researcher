import type { DecisionContext } from '../../engine/decision-context.ts';

function bool(value: boolean): string {
  return value ? 'true' : 'false';
}

function list(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

function quote(items: string[]): string {
  return items.map((item) => `> ${item}`).join('\n');
}

function recommendedNextStep(context: DecisionContext): string {
  if (context.signals.isAmbiguous) return '[MANUAL_REVIEW] Manual/model arbitration required before final acceptance.';
  if (context.source.tier === 'unknown' && !context.signals.exactTitleMatch) return '[DEEP_SEARCH] Continue searching for official corroborating evidence.';
  return '[AUTO_VERIFY] Proceed with standard title/content verification.';
}

function confidence(context: DecisionContext): string {
  if (context.signals.isAmbiguous || context.signals.formatRisk) return 'Medium';
  if (context.source.tier === 'primary_source_candidate' && context.signals.exactTitleMatch && !context.signals.derivativeLike) return 'High';
  return 'Low';
}

function verdictLabel(context: DecisionContext): string {
  if (context.signals.isAmbiguous || context.signals.formatRisk) return 'Review Required';
  if (context.source.tier === 'unknown') return 'Review Required';
  return 'Passed';
}

export function renderReportMarkdown(context: DecisionContext): string {
  const ambiguity = context.signals.isAmbiguous
    ? '\n\n> ⚠️ Ambiguous candidate: source tier and content signals need model or human arbitration.'
    : '';

  return `# Policy Scanner Semantic Report

## Executive Summary

- Verdict: ${verdictLabel(context)}
- Confidence: ${confidence(context)}
- Recommended Next Step: ${recommendedNextStep(context)}

## Header

- Topic: ${context.topic}
- URL: ${context.candidate.finalUrl}
- Title: ${context.candidate.title}

## Context

- Tier: ${context.source.tier}
- Semantic note: ${context.source.semanticNote}
- Trusted official domain: ${bool(context.source.isTrustedOfficialDomain)}
- Official PDF: ${bool(context.source.isOfficialPdf)}${ambiguity}

## Signal Table

| Signal | Value |
| --- | --- |
| exactTitleMatch | ${bool(context.signals.exactTitleMatch)} |
| derivativeLike | ${bool(context.signals.derivativeLike)} |
| formatRisk | ${bool(context.signals.formatRisk)} |
| isAmbiguous | ${bool(context.signals.isAmbiguous)} |

## Verification Strategy

${list(context.verificationStrategy)}

## Instructions Block

${quote(context.modelInstructions)}

## Content Preview

${context.candidate.contentPreview}
`;
}
