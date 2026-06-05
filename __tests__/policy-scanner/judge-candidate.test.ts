import test from 'node:test';
import assert from 'node:assert/strict';

import { judgeCandidate } from '../../src/policy-scanner/engine/judge-candidate.ts';

test('judgeCandidate elevates official PDF on trusted domain', () => {
  const verdict = judgeCandidate({
    taskTopic: '上海市公共场所控制吸烟条例',
    page: {
      finalUrl: 'https://www.shanghai.gov.cn/example.pdf',
      title: '上海市公共场所控制吸烟条例',
      content: '%PDF-1.7 binary',
      kerry_cleaning: { metadata: {} },
    },
    config: {
      rules: {
        trusted_domains: ['.gov.cn', '.org.cn'],
        derivative_keywords: ['解读'],
        pdf_elevation: true,
        default_search_engines: [],
        default_search_limit: 10,
        default_fetch_max_chars: 24000,
      },
      domains: {
        primary_source_domains: ['shanghai.gov.cn'],
        secondary_source_domains: [],
        official_suffixes: ['.gov.cn', '.org.cn'],
      },
    },
  });

  assert.equal(verdict.ok, true);
  assert.ok(verdict.reasons.includes('official_pdf_detected_and_elevated'));
});
