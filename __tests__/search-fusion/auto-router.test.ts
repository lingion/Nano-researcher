import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assessSearchResponseQuality,
  buildDefaultAutoWebSearchArgs,
  buildPolicySearchRoutingContext,
} from '../../src/search-fusion/auto-router.ts';

test('default auto router narrows Chinese policy queries to domestic-first policy engines only', () => {
  const args = buildDefaultAutoWebSearchArgs('绥化市科技招商政策');

  assert.equal(args.auto_mode, 'full');
  assert.deepEqual(args.engines, [
    'baidu',
    'sogou',
    'bing',
    'bing_news',
    'sina_news',
    '163_news',
  ]);
});

test('default auto router treats enterprise-service policy entrance queries as domestic-first policy engines too', () => {
  const args = buildDefaultAutoWebSearchArgs('惠企政策 免申即享 政策兑现 企业服务');

  assert.equal(args.auto_mode, 'full');
  assert.deepEqual(args.engines, [
    'baidu',
    'sogou',
    'bing',
    'bing_news',
    'sina_news',
    '163_news',
  ]);
});

test('policy routing context marks policy bundle and gov.cn official-domain targeting for policy queries', () => {
  const routing = buildPolicySearchRoutingContext('绥化高新减免政策');

  assert.equal(routing.category_bundle_routed, 'policy');
  assert.deepEqual(routing.targeted_official_domains, ['gov.cn']);
});

test('search response quality marks junk-heavy policy mismatches as intent mismatch', () => {
  const quality = assessSearchResponseQuality('绥化高新减免政策', [
    {
      title: '超值租房广告',
      url: 'https://ads.example.com/rent',
      snippet: '低价租房 广告 推广',
      source: 'ad-network',
      query: '绥化高新减免政策',
      access_source_grade: 'credible_reporting',
    },
    {
      title: '今日航班特价',
      url: 'https://travel.example.com/flights',
      snippet: '航班 优惠 机票',
      source: 'travel-site',
      query: '绥化高新减免政策',
      access_source_grade: 'noise',
    },
  ]);

  assert.equal(quality.status, 'intent_mismatch');
  assert.match(quality.reason, /policy-intent/i);
});
