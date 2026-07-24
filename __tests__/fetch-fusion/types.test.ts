import test from 'node:test';
import assert from 'node:assert/strict';
import type { AccessSignal, FreshnessStatus, PageRenderMode, FetchedPageRecord } from '../../src/fetch-fusion/types.js';
import type { FetchedEvidence } from '../../src/policy-task/state-schema.js';

test('fetched page records expose freshness and early-access evidence fields', () => {
  const page: FetchedPageRecord = {
    requestedUrl: 'https://example.com/product',
    finalUrl: 'https://example.com/product',
    title: 'Product',
    content: 'Limited rollout',
    backend: 'playwright',
    publishedAt: '2026-07-01',
    updatedAt: '2026-07-20',
    lastVerifiedAt: '2026-07-24T00:00:00Z',
    pageRenderMode: 'playwright',
    accessSignals: ['limited_rollout', 'waitlist'],
    freshnessStatus: 'in_window',
    dateEvidence: ['Updated July 20, 2026'],
    extractionWarnings: ['Rendered content may be incomplete'],
  };

  const reusedEvidence: FetchedEvidence = page;
  assert.equal(reusedEvidence.pageRenderMode, 'playwright');
  assert.deepEqual(reusedEvidence.accessSignals, ['limited_rollout', 'waitlist']);
});

test('freshness and access signal unions reject values outside the schema', () => {
  const renderMode: PageRenderMode = 'spa_extraction';
  const freshness: FreshnessStatus = 'date_unknown';
  const signal: AccessSignal = 'developer_preview';
  assert.deepEqual([renderMode, freshness, signal], ['spa_extraction', 'date_unknown', 'developer_preview']);
});
