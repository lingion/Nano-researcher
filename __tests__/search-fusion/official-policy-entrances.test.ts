import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGovCnPolicyLibraryProvider,
  createMiitPolicySearchProvider,
  createNdrcPolicySearchProvider,
} from '../../src/search-fusion/official-policy-entrances.ts';

test('NDRC provider maps live-shaped query results into discovery records', async () => {
  const provider = createNdrcPolicySearchProvider({
    fetchImpl: async () => ({
      text: async () => JSON.stringify({
        ok: true,
        data: {
          resultList: [
            {
              title: '构建政府投资基金高质量发展新格局',
              url: 'https://www.ndrc.gov.cn/xxgk/jd/jd/202601/t20260112_1403201.html',
              summary: '一些地方基金投资领域交叉重叠，导致同质化竞争和资源内耗。',
              docDate: '2026-01-12',
            },
          ],
        },
      }),
    }),
  });

  const result = await provider('招商');

  assert.equal(result[0]?.source, 'ndrc-policy-search');
  assert.equal(result[0]?.url, 'https://www.ndrc.gov.cn/xxgk/jd/jd/202601/t20260112_1403201.html');
  assert.match(result[0]?.snippet ?? '', /2026-01-12/);
  assert.match(result[0]?.snippet ?? '', /同质化竞争/);
});

test('MIIT provider maps live-shaped search results into discovery records', async () => {
  const provider = createMiitPolicySearchProvider({
    fetchImpl: async () => ({
      text: async () => JSON.stringify({
        success: true,
        data: {
          searchResult: {
            dataResults: [
              {
                groupData: [
                  {
                    data: {
                      title_text: '工业和信息化部举行“推动国家高新区高质量发展”新闻发布会',
                      url: '/xwfb/xwfbh/bxwfbh/art/2026/art_1645f32c491a452489025bdb9430f490.html',
                      content: '围绕高新区高质量发展和科技创新布局进行介绍。',
                      deploytime: '2026-05-29 09:00:00',
                    },
                  },
                ],
              },
            ],
          },
        },
      }),
    }),
  });

  const result = await provider('科技招商');

  assert.equal(result[0]?.source, 'miit-policy-search');
  assert.equal(result[0]?.url, 'https://www.miit.gov.cn/xwfb/xwfbh/bxwfbh/art/2026/art_1645f32c491a452489025bdb9430f490.html');
  assert.match(result[0]?.snippet ?? '', /2026-05-29/);
  assert.match(result[0]?.snippet ?? '', /科技创新/);
});

test('gov.cn provider maps live-shaped mobile result data into discovery records', async () => {
  const provider = createGovCnPolicyLibraryProvider({
    fetchImpl: async () => ({
      text: async () => JSON.stringify({
        resultCode: { code: 200 },
        result: {
          data: {
            middle: {
              list: [
                {
                  title: '关于发布《国家移民管理局关于上海东方枢纽国际商务合作区通行管理规定（暂行）》的公告',
                  title_no_tag: '关于发布《国家移民管理局关于上海东方枢纽国际商务合作区通行管理规定（暂行）》的公告',
                  url: 'https://www.gov.cn/zhengce/zhengceku/202508/content_7034847.htm',
                  summary: '为落实《上海东方枢纽国际商务合作区建设总体方案》，支持上海东方枢纽国际商务合作区建设发展。',
                  pubcode: '2025年第3号',
                  time: '2025-08-01 12:25:00',
                },
              ],
            },
          },
        },
      }),
    }),
  });

  const result = await provider('上海');

  assert.equal(result[0]?.source, 'gov-cn-policy-library-search');
  assert.equal(result[0]?.url, 'https://www.gov.cn/zhengce/zhengceku/202508/content_7034847.htm');
  assert.match(result[0]?.snippet ?? '', /2025年第3号/);
  assert.match(result[0]?.snippet ?? '', /上海东方枢纽国际商务合作区/);
});

test('gov.cn provider tolerates dirty snippet parts without crashing and preserves useful text', async () => {
  const provider = createGovCnPolicyLibraryProvider({
    fetchImpl: async () => ({
      text: async () => JSON.stringify({
        resultCode: { code: 200 },
        result: {
          data: {
            middle: {
              list: [
                {
                  title_no_tag: '黑龙江省高新技术企业奖补通知',
                  url: 'https://www.gov.cn/example/policy.htm',
                  pubcode: null,
                  time: 20260601,
                  summary: [
                    null,
                    '保留这段有效摘要',
                    { bad: 'ignored' },
                    ['以及这段嵌套文本'],
                  ],
                },
              ],
            },
          },
        },
      }),
    }),
  });

  const result = await provider('黑龙江');

  assert.equal(result[0]?.url, 'https://www.gov.cn/example/policy.htm');
  assert.equal(result[0]?.snippet, '20260601 | 保留这段有效摘要 | 以及这段嵌套文本');
});
