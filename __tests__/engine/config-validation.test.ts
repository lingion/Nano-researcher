import test from 'node:test';
import assert from 'node:assert/strict';

import { JudgmentEngine } from '../../src/engine/judgment-engine.ts';
import { ConfigValidationError } from '../../src/engine/validate-config.ts';

const validConfig = {
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
};

test('JudgmentEngine rejects config missing rules.trusted_domains with a coded validation error', () => {
  assert.throws(
    () => new JudgmentEngine({
      ...validConfig,
      rules: {
        ...validConfig.rules,
        trusted_domains: undefined,
      },
    } as never),
    (error) => {
      assert.ok(error instanceof ConfigValidationError);
      assert.equal(error.code, 'ENGINE_CONFIG_INVALID');
      assert.match(error.message, /rules\.trusted_domains/);
      return true;
    },
  );
});

test('JudgmentEngine rejects config missing domains.primary_source_domains with a precise message', () => {
  assert.throws(
    () => new JudgmentEngine({
      ...validConfig,
      domains: {
        ...validConfig.domains,
        primary_source_domains: undefined,
      },
    } as never),
    /domains\.primary_source_domains/,
  );
});

test('JudgmentEngine rejects config missing domains.official_suffixes with a precise message', () => {
  assert.throws(
    () => new JudgmentEngine({
      ...validConfig,
      domains: {
        ...validConfig.domains,
        official_suffixes: undefined,
      },
    } as never),
    /domains\.official_suffixes/,
  );
});

test('JudgmentEngine snapshots config so later caller mutations do not affect verdicts', () => {
  const mutableConfig = structuredClone(validConfig);
  const engine = new JudgmentEngine(mutableConfig);
  mutableConfig.rules.pdf_elevation = false;
  mutableConfig.rules.trusted_domains.length = 0;

  const verdict = engine.run({
    topic: '上海市公共场所控制吸烟条例',
    candidate: {
      finalUrl: 'https://www.shanghai.gov.cn/example.pdf',
      title: '上海市公共场所控制吸烟条例',
      content: '%PDF-1.7 binary',
      kerry_cleaning: { metadata: {} },
    },
  });

  assert.equal(verdict.ok, true);
  assert.equal(verdict.metadata.official_pdf_detected, true);
});
