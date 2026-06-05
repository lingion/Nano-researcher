import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyCandidateTier } from '../../src/engine/tiering.ts';

const config = {
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
    secondary_source_domains: ['service.example.cn'],
    official_suffixes: ['.gov.cn', '.org.cn'],
  },
};

test('classifyCandidateTier classifies primary source domains from config', () => {
  assert.equal(
    classifyCandidateTier('https://www.shanghai.gov.cn/policy/detail.html', config),
    'primary_source_candidate',
  );
});

test('classifyCandidateTier classifies secondary source domains from config', () => {
  assert.equal(
    classifyCandidateTier('https://service.example.cn/policy/detail.html', config),
    'secondary_source_candidate',
  );
});

test('classifyCandidateTier classifies official suffix pages that are not configured primary or secondary', () => {
  assert.equal(
    classifyCandidateTier('https://example.gov.cn/policy/detail.html', config),
    'official_repost_or_related',
  );
});

test('classifyCandidateTier classifies non-official unknown pages', () => {
  assert.equal(
    classifyCandidateTier('https://example.com/policy/detail.html', config),
    'unknown',
  );
});

test('classifyCandidateTier keeps official PDF on non-primary official suffix as official related tier', () => {
  assert.equal(
    classifyCandidateTier('https://example.gov.cn/policy/detail.pdf', config),
    'official_repost_or_related',
  );
});
