import test from 'node:test';
import assert from 'node:assert/strict';

import { JudgmentEngine } from '../../src/engine/judgment-engine.ts';

const config = {
  rules: {
    trusted_domains: ['.gov.cn', '.org.cn'],
    derivative_keywords: ['解读', '一图读懂'],
    pdf_elevation: true,
    default_search_engines: [],
    default_search_limit: 10,
    default_fetch_max_chars: 24000,
  },
  domains: {
    primary_source_domains: ['shanghai.gov.cn'],
    secondary_source_domains: ['service.example.cn'],
    official_suffixes: ['.gov.cn', '.org.cn'],
  },
};

test('prepareContext marks primary source candidates with high-authority model guidance', () => {
  const context = new JudgmentEngine(config).prepareContext({
    topic: '上海市公共场所控制吸烟条例',
    candidate: {
      finalUrl: 'https://www.shanghai.gov.cn/policy/detail.html',
      title: '上海市公共场所控制吸烟条例',
      content: '上海市公共场所控制吸烟条例 正文',
      kerry_cleaning: { metadata: {} },
    },
  });

  assert.equal(context.source.tier, 'primary_source_candidate');
  assert.equal(context.source.semanticNote, 'Primary official source candidate.');
  assert.equal(context.signals.exactTitleMatch, true);
  assert.equal(context.signals.isAmbiguous, false);
  assert.ok(context.modelInstructions.some((item) => item.includes('high-authority source')));
  assert.ok(context.verificationStrategy.some((item) => item.includes('Verify policy title')));
  assert.ok(context.verificationStrategy.some((item) => item.includes('prioritize the content over the tier')));
});

test('prepareContext warns model about derivative-like candidates without making the final rejection itself', () => {
  const context = new JudgmentEngine(config).prepareContext({
    topic: '上海市公共场所控制吸烟条例',
    candidate: {
      finalUrl: 'https://www.shanghai.gov.cn/policy/explain.html',
      title: '上海市公共场所控制吸烟条例 解读',
      content: '一图读懂 上海市公共场所控制吸烟条例',
      kerry_cleaning: { metadata: {} },
    },
  });

  assert.equal(context.signals.derivativeLike, true);
  assert.ok(context.modelInstructions.some((item) => item.includes('derivative or explanatory page')));
  assert.ok(context.modelInstructions.every((item) => !item.includes('reject')));
});

test('prepareContext keeps official suffix PDF outside primary as related source while marking official PDF', () => {
  const context = new JudgmentEngine(config).prepareContext({
    topic: '政策标题',
    candidate: {
      finalUrl: 'https://example.gov.cn/policy/detail.pdf',
      title: '政策标题',
      content: '%PDF-1.7 binary',
      kerry_cleaning: { metadata: {} },
    },
  });

  assert.equal(context.source.tier, 'official_repost_or_related');
  assert.equal(context.source.isOfficialPdf, true);
  assert.equal(context.signals.formatRisk, true);
  assert.ok(context.modelInstructions.some((item) => item.includes('official suffix')));
});

test('prepareContext marks unknown sources as clue-only evidence', () => {
  const context = new JudgmentEngine(config).prepareContext({
    topic: '政策标题',
    candidate: {
      finalUrl: 'https://example.com/policy/detail.html',
      title: '政策标题',
      content: '政策标题 正文',
      kerry_cleaning: { metadata: {} },
    },
  });

  assert.equal(context.source.tier, 'unknown');
  assert.equal(context.source.semanticNote, 'Untrusted or unknown source candidate.');
  assert.ok(context.modelInstructions.some((item) => item.includes('Do not treat as authoritative')));
});

test('prepareContext marks official-source derivative pages as ambiguous instead of forcing a final decision', () => {
  const context = new JudgmentEngine(config).prepareContext({
    topic: '政策标题',
    candidate: {
      finalUrl: 'https://www.shanghai.gov.cn/policy/explain.html',
      title: '政策标题 解读',
      content: '政策标题 解读 正文',
      kerry_cleaning: { metadata: {} },
    },
  });

  assert.equal(context.source.tier, 'primary_source_candidate');
  assert.equal(context.signals.derivativeLike, true);
  assert.equal(context.signals.isAmbiguous, true);
  assert.ok(context.verificationStrategy.some((item) => item.includes('Resolve ambiguity')));
});
