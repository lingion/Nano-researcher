import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveEarlyAccessItems,
  writeEarlyAccessReport,
  type EarlyAccessReportItem,
} from '../../src/artifacts/write-early-access-report.ts';
import type { FetchedPageRecord } from '../../src/fetch-fusion/types.ts';

function page(overrides: Partial<FetchedPageRecord> = {}): FetchedPageRecord {
  return {
    requestedUrl: 'https://example.cn/product',
    finalUrl: 'https://example.cn/product',
    title: 'Example 内测',
    content: '2026-07-20 开启内测，申请入口见官网。',
    backend: 'fixture',
    qualityCategory: 'GOLD_STANDARD',
    freshnessStatus: 'in_window',
    publishedAt: '2026-07-20',
    ...overrides,
  };
}

const item = (overrides: Partial<EarlyAccessReportItem> = {}): EarlyAccessReportItem => ({
  product_name: 'Example',
  company: 'Example Co',
  category: 'AI core',
  country_or_region: '中国大陆',
  official_url: 'https://example.cn/product',
  source_type: 'official_product_page',
  source_title: 'Example 内测公告',
  published_or_updated_date: '2026-07-20',
  date_basis: 'structured publication date',
  access_status: 'private beta',
  access_requirement: '申请资格',
  evidence_quote_or_structured_fact: '官方页面明确说明开启内测。',
  verification_time: '2026-07-29T00:00:00Z',
  confidence: 'high',
  canonical_product_id: 'example-product',
  canonical_company_id: 'example-company',
  evidence_basis: { source: 'official' },
  access_or_application_url: 'https://example.cn/product',
  freshness_status: 'in_window',
  duplicate_of: null,
  ...overrides,
});

test('deriveEarlyAccessItems returns zero items for an empty page set', () => {
  assert.deepEqual(deriveEarlyAccessItems([]), []);
});

test('deriveEarlyAccessItems filters duplicates, noise, dates, quality, and missing signals', () => {
  const pages = [
    page(),
    page({ requestedUrl: 'https://example.cn/product?source=mirror', finalUrl: 'https://example.cn/product' }),
    page({ requestedUrl: 'https://example.cn/noise', finalUrl: 'https://example.cn/noise', qualityCategory: 'NOISE' }),
    page({ requestedUrl: 'https://example.cn/old', finalUrl: 'https://example.cn/old', updatedAt: '2025-01-01', content: '2025-01-01 开启内测。' }),
    page({ requestedUrl: 'https://example.cn/unknown', finalUrl: 'https://example.cn/unknown', publishedAt: undefined, updatedAt: undefined, title: 'Example 产品说明', content: '开放申请，暂无日期。', freshnessStatus: 'date_unknown' }),
    page({ requestedUrl: 'https://example.cn/release', finalUrl: 'https://example.cn/release', title: 'Example 正式产品', content: '2026-07-20 正式发布，面向所有用户。', freshnessStatus: 'in_window' }),
  ];

  const items = deriveEarlyAccessItems(pages, { start: '2026-07-01', end: '2026-07-31' });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.access_or_application_url, 'https://example.cn/product');
  assert.equal(items[0]?.freshness_status, 'in_window');
});

test('deriveEarlyAccessItems does not let an in-window body date override an older structured date', () => {
  const items = deriveEarlyAccessItems([
    page({
      updatedAt: '2025-01-01',
      content: '2026-07-20 开启内测，申请入口见官网。',
    }),
  ], { start: '2026-07-01', end: '2026-07-31' });

  assert.deepEqual(items, []);
});

test('deriveEarlyAccessItems uses updatedAt before publishedAt and ignores older body dates', () => {
  const items = deriveEarlyAccessItems([
    page({
      publishedAt: '2026-07-31',
      updatedAt: '2026-07-01',
      content: '2025-01-01 开启内测，申请入口见官网。',
    }),
  ], { start: '2026-07-01', end: '2026-07-31' });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.freshness_status, 'in_window');
});

test('deriveEarlyAccessItems does not infer freshness from body dates without structured dates', () => {
  const items = deriveEarlyAccessItems([
    page({ publishedAt: undefined, updatedAt: undefined, content: '2026-07-20 开启内测，申请入口见官网。' }),
  ], { start: '2026-07-01', end: '2026-07-31' });

  assert.deepEqual(items, []);
});

test('deriveEarlyAccessItems keeps the inclusive structured date boundaries', () => {
  const items = deriveEarlyAccessItems([
    page({
      updatedAt: '2026-07-01',
      content: '2025-01-01 开启内测，申请入口见官网。',
    }),
    page({
      requestedUrl: 'https://example.cn/end',
      finalUrl: 'https://example.cn/end',
      updatedAt: '2026-07-31',
      content: '2025-01-01 开启内测，申请入口见官网。',
    }),
  ], { start: '2026-07-01', end: '2026-07-31' });

  assert.equal(items.length, 2);
});

test('writeEarlyAccessReport counts validated reportable items, not duplicate or malformed entries', () => {
  const report = writeEarlyAccessReport({
    target: 3,
    items: [
      item(),
      item({ access_or_application_url: 'https://EXAMPLE.cn/second-product/#details', official_url: 'https://EXAMPLE.cn/second-product', canonical_product_id: 'example-second-product' }),
      item({ product_name: '   ' }),
      { product_name: 'No URL item' },
    ],
  });

  assert.equal(report.target, 3);
  assert.equal(report.validCount, 2);
  assert.equal(report.shortfall, 1);
  assert.match(report.markdown, /valid_count: 2/);
  assert.match(report.markdown, /shortfall: 1/);
  assert.equal((report.markdown.match(/^## /gm) ?? []).length, 2);
});

test('writeEarlyAccessReport accepts derived items without model-only metadata', () => {
  const report = writeEarlyAccessReport({
    target: 1,
    items: [item({ company: undefined })],
  });

  assert.equal(report.validCount, 1);
  assert.equal(report.shortfall, 0);
});

test('writeEarlyAccessReport renders model final package without reapplying page filters', () => {
  const report = writeEarlyAccessReport({
    target: 20,
    items: [
      {
        product_name: 'Model judged beta',
        official_source_urls: ['https://example.cn/beta'],
        release_or_update_date: 'unknown',
        access_status: 'BETA',
        evidence_basis: 'Model-validated official evidence',
        uncertainty_notes: 'Date metadata was not exposed by the fetch adapter.',
      } as unknown as EarlyAccessReportItem,
    ],
  });

  assert.equal(report.validCount, 1);
  assert.equal(report.shortfall, 19);
  assert.match(report.markdown, /Model judged beta/);
});

test('writeEarlyAccessReport preserves model package entries with no derived page metadata', () => {
  const report = writeEarlyAccessReport({
    target: 1,
    items: [{ product_name: 'Model-only result' } as EarlyAccessReportItem],
  });

  assert.equal(report.validCount, 1);
  assert.match(report.markdown, /Model-only result/);
});

test('writeEarlyAccessReport handles empty, partial, and satisfied targets', () => {
  assert.equal(writeEarlyAccessReport({ target: 3, items: [] }).shortfall, 3);
  assert.equal(writeEarlyAccessReport({ target: 3, items: [item()] }).shortfall, 2);
  assert.equal(writeEarlyAccessReport({ target: 1, items: [item()] }).shortfall, 0);
});

test('writeEarlyAccessReport normalizes invalid targets without NaN or negative counts', () => {
  const negative = writeEarlyAccessReport({ target: -4, items: [item()] });
  const nonFinite = writeEarlyAccessReport({ target: Number.NaN, items: [item()] });
  const fractional = writeEarlyAccessReport({ target: 2.9, items: [item()] });

  assert.equal(negative.target, 0);
  assert.equal(negative.shortfall, 0);
  assert.equal(nonFinite.target, 0);
  assert.equal(nonFinite.shortfall, 0);
  assert.equal(fractional.target, 2);
  assert.equal(fractional.shortfall, 1);
  assert.doesNotMatch(nonFinite.markdown, /NaN|Infinity/);
});

test('writeEarlyAccessReport tolerates malformed runtime input at its boundary', () => {
  const report = writeEarlyAccessReport({
    target: 2,
    items: null as unknown as EarlyAccessReportItem[],
  });

  assert.equal(report.validCount, 0);
  assert.equal(report.shortfall, 2);
});
