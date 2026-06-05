import { classifyCandidateTier } from '../../engine/tiering.ts';
import type { CandidateVerdict, JudgeCandidateInput } from '../types.ts';

export function judgeCandidate(input: JudgeCandidateInput): CandidateVerdict {
  const text = [
    input.page.title,
    input.page.content,
    JSON.stringify(input.page.kerry_cleaning?.metadata ?? {}),
    input.page.finalUrl,
  ].join('\n');

  const exactTitle = text.includes(input.taskTopic);
  const derivative = input.config.rules.derivative_keywords.some((word) => text.slice(0, 3000).includes(word));
  const formatBad = /%PDF-|�|We're sorry but .*JavaScript|Access Denied/i.test(String(input.page.content ?? '').slice(0, 500));
  const isPdf = /\.pdf(?:$|\?)/i.test(input.page.finalUrl);
  const hostname = new URL(input.page.finalUrl).hostname;
  const isTrustedOfficialDomain = input.config.rules.trusted_domains.some((suffix) => hostname.endsWith(suffix.replace(/^\./, '')));
  const tier = classifyCandidateTier(input.page.finalUrl, input.config);
  const reasons: string[] = [];
  const rejects: string[] = [];

  if (isPdf && isTrustedOfficialDomain && input.config.rules.pdf_elevation) {
    return {
      ok: true,
      tier,
      reasons: ['official_pdf_detected_and_elevated', `tier:${tier}`],
      rejects: [],
      exactTitle,
      derivative,
      isOfficialPdf: true,
    };
  }

  if (exactTitle) {
    reasons.push('exact_title_match');
  } else {
    rejects.push('missing_exact_title');
  }

  if (formatBad) {
    rejects.push('format_corrupt_or_js_shell');
  }

  if (derivative) {
    rejects.push('derivative_or_explanatory_page');
  }

  if (tier !== 'primary_source_candidate') {
    rejects.push('not_primary_source_candidate');
  }

  reasons.push(`tier:${tier}`);

  return {
    ok: rejects.length === 0,
    tier,
    reasons,
    rejects,
    exactTitle,
    derivative,
    isOfficialPdf: false,
  };
}
