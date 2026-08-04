import { judgeCandidate } from '../policy-scanner/engine/judge-candidate.ts';
import type { DecisionContext } from './decision-context.ts';
import { classifyCandidateTier, type CandidateTier } from './tiering.ts';
import type { CandidateVerdict, EngineInput, JudgmentEngineConfig } from './types.ts';
import { validateJudgmentEngineConfig } from './validate-config.ts';

function semanticNoteForTier(tier: CandidateTier): string {
  return {
    primary_source_candidate: 'Primary official source candidate.',
    secondary_source_candidate: 'Secondary official source candidate.',
    official_repost_or_related: 'Official-domain related or repost candidate.',
    unknown: 'Untrusted or unknown source candidate.',
  }[tier];
}

function verificationStrategyFor(input: { tier: CandidateTier; isAmbiguous: boolean }): string[] {
  const strategies = [
    'If the content contradicts the tiering signal but clearly presents authoritative primary evidence, prioritize the content over the tier.',
  ];

  if (input.tier === 'primary_source_candidate') {
    strategies.push('Verify policy title, document number if present, and body relevance before final arbitration.');
  } else if (input.tier === 'secondary_source_candidate') {
    strategies.push('Check whether this page links to or summarizes a primary-source policy text.');
  } else if (input.tier === 'official_repost_or_related') {
    strategies.push('Check whether content is verbatim policy text or points to the official primary source.');
  } else {
    strategies.push('Use as clue only; require official-source confirmation before treating it as policy evidence.');
  }

  if (input.isAmbiguous) {
    strategies.push('Resolve ambiguity by comparing the page body against original policy text requirements rather than trusting tier alone.');
  }

  return strategies;
}

function modelInstructionsFor(input: { tier: CandidateTier; derivativeLike: boolean }): string[] {
  const instructions: string[] = [];

  if (input.tier === 'primary_source_candidate') {
    instructions.push('Treat as a high-authority source, but still verify title and content match the requested topic.');
  } else if (input.tier === 'secondary_source_candidate') {
    instructions.push('Use as official context, but confirm whether this is final policy text or a navigation/service page.');
  } else if (input.tier === 'official_repost_or_related') {
    instructions.push('Do not assume final policy authority solely from an official suffix; verify whether it is verbatim policy text or a pointer to the primary source.');
  } else {
    instructions.push('Do not treat as authoritative without corroborating official evidence.');
  }

  if (input.derivativeLike) {
    instructions.push('This candidate looks like a derivative or explanatory page; do not treat it as final access or eligibility evidence without stronger official product or application evidence.');
  }

  return instructions;
}

export class JudgmentEngine {
  private readonly config: JudgmentEngineConfig;

  constructor(config: JudgmentEngineConfig) {
    validateJudgmentEngineConfig(config);
    this.config = structuredClone(config);
  }

  prepareContext(input: EngineInput): DecisionContext {
    const text = [
      input.candidate.title,
      input.candidate.content,
      JSON.stringify(input.candidate.kerry_cleaning?.metadata ?? {}),
      input.candidate.finalUrl,
    ].join('\n');
    const hostname = new URL(input.candidate.finalUrl).hostname;
    const tier = classifyCandidateTier(input.candidate.finalUrl, this.config);
    const exactTitleMatch = text.includes(input.topic);
    const derivativeLike = this.config.rules.derivative_keywords.some((word) => text.slice(0, 3000).includes(word));
    const formatRisk = /%PDF-|�|We're sorry but .*JavaScript|Access Denied/i.test(String(input.candidate.content ?? '').slice(0, 500));
    const isPdf = /\.pdf(?:$|\?)/i.test(input.candidate.finalUrl);
    const isTrustedOfficialDomain = this.config.rules.trusted_domains.some((suffix) => hostname.endsWith(suffix.replace(/^\./, '')));
    const isOfficialPdf = isPdf && isTrustedOfficialDomain && this.config.rules.pdf_elevation;
    const isAmbiguous = tier === 'primary_source_candidate' && derivativeLike;

    return {
      topic: input.topic,
      candidate: {
        finalUrl: input.candidate.finalUrl,
        title: input.candidate.title,
        contentPreview: String(input.candidate.content ?? '').slice(0, 800),
      },
      source: {
        tier,
        semanticNote: semanticNoteForTier(tier),
        isTrustedOfficialDomain,
        isOfficialPdf,
      },
      signals: {
        exactTitleMatch,
        derivativeLike,
        formatRisk,
        isAmbiguous,
      },
      verificationStrategy: verificationStrategyFor({ tier, isAmbiguous }),
      modelInstructions: modelInstructionsFor({ tier, derivativeLike }),
    };
  }

  run(input: EngineInput): CandidateVerdict {
    const verdict = judgeCandidate({
      taskTopic: input.topic,
      page: input.candidate,
      config: this.config,
    });

    return {
      ok: verdict.ok,
      score: verdict.ok ? 100 : 0,
      reasons: verdict.reasons,
      rejects: verdict.rejects,
      tier: verdict.tier,
      metadata: {
        exact_title_match: verdict.exactTitle,
        derivative_or_explanatory_page: verdict.derivative,
        official_pdf_detected: verdict.isOfficialPdf,
      },
    };
  }
}
