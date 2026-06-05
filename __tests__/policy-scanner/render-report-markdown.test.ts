import test from 'node:test';
import assert from 'node:assert/strict';

import { renderReportMarkdown } from '../../src/policy-scanner/reporter/render-report-markdown.ts';
import type { DecisionContext } from '../../src/engine/decision-context.ts';

const context: DecisionContext = {
  topic: '上海市公共场所控制吸烟条例',
  candidate: {
    finalUrl: 'https://www.shanghai.gov.cn/policy/detail.html',
    title: '上海市公共场所控制吸烟条例 解读',
    contentPreview: '一图读懂 上海市公共场所控制吸烟条例',
  },
  source: {
    tier: 'primary_source_candidate',
    semanticNote: 'Primary official source candidate.',
    isTrustedOfficialDomain: true,
    isOfficialPdf: false,
  },
  signals: {
    exactTitleMatch: true,
    derivativeLike: true,
    formatRisk: false,
    isAmbiguous: true,
  },
  verificationStrategy: [
    'If the content contradicts the tiering signal but clearly presents authoritative primary evidence, prioritize the content over the tier.',
    'Resolve ambiguity by comparing the page body against original policy text requirements rather than trusting tier alone.',
  ],
  modelInstructions: [
    'Treat as a high-authority source, but still verify title and content match the requested topic.',
    'This candidate looks like a derivative or explanatory page; do not treat it as final official policy text without stronger evidence.',
  ],
};

test('renderReportMarkdown renders DecisionContext as a semantic audit report', () => {
  const report = renderReportMarkdown(context);

  assert.match(report, /^# Policy Scanner Semantic Report/m);
  assert.match(report, /## Executive Summary/);
  assert.match(report, /Verdict: Review Required/);
  assert.match(report, /Confidence: Medium/);
  assert.match(report, /Recommended Next Step: \[MANUAL_REVIEW\]/);
  assert.match(report, /上海市公共场所控制吸烟条例/);
  assert.match(report, /## Context/);
  assert.match(report, /Primary official source candidate\./);
  assert.match(report, /\| exactTitleMatch \| true \|/);
  assert.match(report, /\| derivativeLike \| true \|/);
  assert.match(report, /⚠️ Ambiguous candidate/);
  assert.match(report, /> Treat as a high-authority source/);
  assert.match(report, /prioritize the content over the tier/);
});
