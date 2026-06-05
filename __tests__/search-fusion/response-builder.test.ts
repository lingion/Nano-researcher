import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCloudflareAlignedSearchResponse,
  mapCloudflareStatusToKerryStatus,
} from '../../src/search-fusion/response-builder.ts';

test('response builder assembles the standard four-layer Cloudflare-aligned contract shape', () => {
  const response = buildCloudflareAlignedSearchResponse({
    query: '绥化高新减免政策',
    currentRound: 2,
    rawFoundCount: 2,
    rawResults: [
      {
        query: '绥化高新减免政策',
        title: '绥化市人民政府关于高新减免的通知',
        url: 'https://www.suihua.gov.cn/policy/1.html',
        snippet: '官方正文摘要',
        source: 'suihua-gov',
        policy_grade: 'official_text',
      },
      {
        query: '绥化高新减免政策',
        title: '绥化高新减免政策解读',
        url: 'https://www.suihua.gov.cn/interp/1.html',
        snippet: '政策解读摘要',
        source: 'suihua-gov',
        policy_grade: 'official_interpretation',
      },
    ],
    metricsOverrides: {
      fallback_used: false,
      filtered_count: 1,
      merged_count: 3,
      deduped_count: 1,
    },
  });

  assert.equal(response.task_context.target_query, '绥化高新减免政策');
  assert.equal(response.task_context.current_attempt_round, 2);
  assert.equal(response.task_context.category_bundle_routed, 'policy');
  assert.deepEqual(response.task_context.targeted_official_domains, ['gov.cn']);
  assert.equal(response.metrics.total_raw_found, 2);
  assert.equal(response.metrics.fallback_used, false);
  assert.equal(response.metrics.filtered_count, 1);
  assert.equal(response.metrics.merged_count, 3);
  assert.equal(response.metrics.deduped_count, 1);
  assert.equal(response.quality_state.status, 'green');
  assert.equal(response.results.length, 2);
});

test('response builder preserves explicit metric overrides instead of defaulting them away', () => {
  const response = buildCloudflareAlignedSearchResponse({
    query: '绥化高新减免政策',
    currentRound: 1,
    rawFoundCount: 5,
    rawResults: [
      {
        query: '绥化高新减免政策',
        title: '绥化市人民政府关于高新减免的通知',
        url: 'https://www.suihua.gov.cn/policy/1.html',
        snippet: '官方正文摘要',
        source: 'suihua-gov',
        policy_grade: 'official_text',
      },
    ],
    metricsOverrides: {
      fallback_used: true,
      filtered_count: 4,
      merged_count: 5,
      deduped_count: 0,
    },
  });

  assert.deepEqual(response.metrics, {
    total_raw_found: 5,
    fallback_used: true,
    filtered_count: 4,
    merged_count: 5,
    deduped_count: 0,
  });
});

test('response builder deterministically derives Kerry result statuses from the Cloudflare quality state', () => {
  const response = buildCloudflareAlignedSearchResponse({
    query: '招聘租房广告',
    currentRound: 1,
    rawFoundCount: 2,
    rawResults: [
      {
        query: '招聘租房广告',
        title: '招聘广告合集',
        url: 'https://example.com/jobs',
        snippet: '招聘 租房 广告',
        source: 'search_auto',
        kerry_quality_status: 'usable_results',
        kerry_quality_reason: 'stale legacy status that should be overwritten',
      },
      {
        query: '招聘租房广告',
        title: '酒店机票优惠',
        url: 'https://example.com/travel',
        snippet: '酒店 机票 优惠',
        source: 'search_auto',
      },
    ],
  });

  assert.equal(response.quality_state.status, 'junk');
  assert.deepEqual(
    response.results.map((result) => result.kerry_quality_status),
    ['junk_heavy', 'junk_heavy'],
  );
  assert.match(response.results[0]?.kerry_quality_reason ?? '', /commercial noise|intent mismatch/i);
});

test('Cloudflare to Kerry status mapping follows the locked derivation matrix', () => {
  assert.deepEqual(mapCloudflareStatusToKerryStatus('green'), {
    status: 'usable_results',
    reason: 'Search result quality verified.',
  });
  assert.deepEqual(mapCloudflareStatusToKerryStatus('yellow'), {
    status: 'usable_results',
    reason: 'Search result quality verified.',
  });
  assert.deepEqual(mapCloudflareStatusToKerryStatus('blocked'), {
    status: 'blocked_by_waf',
    reason: 'WAF administrative barrier detected.',
  });
  assert.deepEqual(mapCloudflareStatusToKerryStatus('empty'), {
    status: 'empty',
    reason: 'Zero results returned from radar search.',
  });
  assert.deepEqual(mapCloudflareStatusToKerryStatus('intent_mismatch'), {
    status: 'intent_mismatch',
    reason: 'Commercial noise or intent mismatch detected.',
  });
  assert.deepEqual(mapCloudflareStatusToKerryStatus('junk'), {
    status: 'junk_heavy',
    reason: 'Commercial noise or intent mismatch detected.',
  });
});
