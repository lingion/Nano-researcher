import test from 'node:test';
import assert from 'node:assert/strict';

import { runPolicyTaskLoop } from '../../src/app/run-policy-task.ts';
import type { PolicyAgentDecision } from '../../src/policy-task/output-schema.ts';
import type { PolicyAgentState } from '../../src/policy-task/state-schema.ts';

test('policy loop replays search to reprint fetch to official fetch before finalizing', async () => {
  const seenStates: PolicyAgentState[] = [];
  const searchCalls: string[] = [];
  const fetchCalls: string[] = [];

  const decisions: PolicyAgentDecision[] = [
    {
      decision: 'continue_search',
      reasoning: 'Need broad radar clues first.',
      searchActions: [
        {
          query: '绥化 高新 企业 租金减免',
          why: 'Radar search for first-stage clues',
        },
      ],
      fetchActions: [],
      uncertainties: ['No fetched evidence yet'],
      discardedLeads: [],
    },
    {
      decision: 'continue_fetch',
      reasoning: 'The top result is still a news reprint so fetch is mandatory.',
      searchActions: [],
      fetchActions: [
        {
          url: 'https://news.sina.com/sh/123.html',
          why: 'Inspect the reprint for official source clues',
        },
      ],
      uncertainties: ['Need official source confirmation'],
      discardedLeads: [],
    },
    {
      decision: 'continue_fetch',
      reasoning: 'The reprint exposed an official source URL, so fetch the government original.',
      searchActions: [],
      fetchActions: [
        {
          url: 'https://www.suihua.gov.cn/zw/txt.html',
          why: 'Lock the official_text source',
        },
      ],
      uncertainties: [],
      discardedLeads: [],
    },
    {
      decision: 'finalize',
      reasoning: 'Confident validation complete after securing official_text.',
      searchActions: [],
      fetchActions: [],
      uncertainties: [],
      discardedLeads: [],
      finalPackage: {
        status: 'FINAL_ASSERTION_STOP',
      },
    },
  ];

  let decisionIndex = 0;

  const result = await runPolicyTaskLoop(
    { topic: '2026年黑龙江绥化高新技术企业租金减免政策' },
    {
      maxIterations: 4,
      askAgent: async (state) => {
        seenStates.push(structuredClone(state));
        const decision = decisions[decisionIndex];
        decisionIndex += 1;
        if (!decision) {
          throw new Error('missing mock decision');
        }
        return decision;
      },
      searchTool: {
        search: async (query) => {
          searchCalls.push(query);
          return [
            {
              query,
              title: '绥化出台租金减免新规',
              url: 'https://news.sina.com/sh/123.html',
              snippet: '日前绥化发文支持高新技术企业租金减免。',
              source: 'sina',
              policy_grade: 'news_reprint',
              kerry_quality_status: 'usable_results',
              kerry_quality_reason: 'Found news reprinted clues.',
            },
          ];
        },
      },
      fetchTool: {
        fetch: async (url) => {
          fetchCalls.push(url);
          if (url.includes('news.sina.com')) {
            return {
              requestedUrl: url,
              finalUrl: url,
              title: '绥化出台租金减免新规',
              content: '转载页提到绥政发〔2026〕7号并给出官方原文链接。',
              backend: 'fetch-backend',
              evidence_clues: {
                is_suspected_reprint: true,
                extracted_doc_no: '绥政发〔2026〕7号',
                potential_official_urls: ['https://www.suihua.gov.cn/zw/txt.html'],
              },
            };
          }

          return {
            requestedUrl: url,
            finalUrl: url,
            title: '关于印发高新技术企业租金减免政策的通知',
            content: '【官方正文】关于印发高新技术企业租金减免政策的通知。',
            backend: 'fetch-backend',
            evidence_clues: {
              is_suspected_reprint: false,
              extracted_doc_no: '绥政发〔2026〕7号',
              potential_official_urls: [],
            },
          };
        },
      },
    },
  );

  assert.equal(decisionIndex, 4);
  assert.deepEqual(searchCalls, ['绥化 高新 企业 租金减免']);
  assert.deepEqual(fetchCalls, [
    'https://news.sina.com/sh/123.html',
    'https://www.suihua.gov.cn/zw/txt.html',
  ]);
  assert.equal(seenStates.length, 4);
  assert.equal(seenStates[1]?.discoveredCandidates[0]?.policy_grade, 'news_reprint');
  assert.deepEqual(
    seenStates[2]?.fetchedEvidence[0]?.evidence_clues?.potential_official_urls,
    ['https://www.suihua.gov.cn/zw/txt.html'],
  );
  assert.equal(result.currentIteration, 4);
  assert.equal(result.discoveredCandidates[0]?.policy_grade, 'news_reprint');
  assert.equal(result.fetchedEvidence[1]?.title, '关于印发高新技术企业租金减免政策的通知');
  assert.equal((result.decision.finalPackage as { status?: string } | undefined)?.status, 'FINAL_ASSERTION_STOP');
});

test('policy loop normalizes document numbers and promotes official_text after a successful document-number replay', async () => {
  const targetDocNo = '绥政发〔2026〕7号';
  const seenStates: PolicyAgentState[] = [];
  const searchCalls: string[] = [];
  const fetchCalls: string[] = [];

  let step = 0;

  const result = await runPolicyTaskLoop(
    { topic: '2026年黑龙江绥化高新技术企业租金减免政策' },
    {
      maxIterations: 4,
      askAgent: async (state) => {
        seenStates.push(structuredClone(state));
        step += 1;

        if (step === 1) {
          return {
            decision: 'continue_search',
            reasoning: 'Need broad radar clues first.',
            searchActions: [
              {
                query: '黑龙江绥化企业减免',
                why: 'Find reprint clues first',
              },
            ],
            fetchActions: [],
            uncertainties: ['No fetched evidence yet'],
            discardedLeads: [],
          };
        }

        if (step === 2) {
          assert.equal(state.discoveredCandidates[0]?.policy_grade, 'news_reprint');
          return {
            decision: 'continue_fetch',
            reasoning: 'Fetch the reprint because it may contain a policy document number.',
            searchActions: [],
            fetchActions: [
              {
                url: 'https://www.chinatax.com/news.html',
                why: 'Inspect the reprint for a policy document number',
              },
            ],
            uncertainties: ['Need document number confirmation'],
            discardedLeads: [],
          };
        }

        if (step === 3) {
          assert.equal(state.fetchedEvidence[0]?.evidence_clues?.extracted_doc_no, targetDocNo);
          return {
            decision: 'continue_search',
            reasoning: 'No official url was found, so re-search by normalized document number only.',
            searchActions: [
              {
                query: state.fetchedEvidence[0]?.evidence_clues?.extracted_doc_no ?? '',
                why: 'Use the normalized document number as the only precise query',
              },
            ],
            fetchActions: [],
            uncertainties: [],
            discardedLeads: [],
          };
        }

        assert.equal(state.discoveredCandidates.some((candidate) => candidate.policy_grade === 'official_text'), true);
        return {
          decision: 'finalize',
          reasoning: 'Official text was located through document number replay.',
          searchActions: [],
          fetchActions: [],
          uncertainties: [],
          discardedLeads: [],
          finalPackage: {
            status: 'FINAL_ASSERTION_STOP',
          },
        };
      },
      searchTool: {
        search: async (query) => {
          searchCalls.push(query);
          if (query === targetDocNo) {
            return [
              {
                query,
                title: '绥化市人民政府关于印发高新企业减免办法的通知（绥政发〔2026〕7号）',
                url: 'https://www.suihua.gov.cn/art.html',
                snippet: '红头正文公告...',
                source: 'suihua-gov',
                policy_grade: 'official_text',
                kerry_quality_status: 'usable_results',
                kerry_quality_reason: 'Official target hit via document number search.',
              },
            ];
          }

          return [
            {
              query,
              title: '绥化新政落地',
              url: 'https://www.chinatax.com/news.html',
              snippet: '转载内容...',
              source: 'chinatax',
              policy_grade: 'news_reprint',
              kerry_quality_status: 'usable_results',
              kerry_quality_reason: 'Found reprinted news.',
            },
          ];
        },
      },
      fetchTool: {
        fetch: async (url) => {
          fetchCalls.push(url);
          return {
            requestedUrl: url,
            finalUrl: url,
            title: '绥化新政落地',
            content: '根据绥政发[2026]7号文件精神，执行新的减免政策。',
            backend: 'fetch-backend',
            evidence_clues: {
              is_suspected_reprint: true,
              extracted_doc_no: '绥政发[2026]7号',
              potential_official_urls: [],
            },
          };
        },
      },
    },
  );

  assert.equal(step, 4);
  assert.deepEqual(searchCalls, ['黑龙江绥化企业减免', targetDocNo]);
  assert.deepEqual(fetchCalls, ['https://www.chinatax.com/news.html']);
  assert.equal(seenStates[2]?.fetchedEvidence[0]?.evidence_clues?.extracted_doc_no, targetDocNo);
  assert.equal(result.discoveredCandidates.some((candidate) => candidate.policy_grade === 'official_text'), true);
  assert.equal(result.loop_interrupted_by_gate, undefined);
  assert.equal((result.decision.finalPackage as { status?: string } | undefined)?.status, 'FINAL_ASSERTION_STOP');
});

test('policy loop prunes low-value discovery history before the next agent decision while preserving full audit history', async () => {
  const seenStates: PolicyAgentState[] = [];

  let step = 0;

  const result = await runPolicyTaskLoop(
    { topic: '超量噪声测试' },
    {
      maxIterations: 3,
      askAgent: async (state) => {
        seenStates.push(structuredClone(state));
        step += 1;

        if (step === 1) {
          return {
            decision: 'continue_search',
            reasoning: 'Need broad radar clues first.',
            searchActions: [
              {
                query: '超量噪声测试',
                why: 'Create a noisy first-stage discovery pool',
              },
            ],
            fetchActions: [],
            uncertainties: ['No fetched evidence yet'],
            discardedLeads: [],
          };
        }

        if (step === 2) {
          assert.equal(state.discoveredCandidates.length, 2);
          assert.equal(state.discoveredCandidates.every((candidate) => candidate.policy_grade === 'news_reprint'), true);
          return {
            decision: 'continue_fetch',
            reasoning: 'Fetch one of the retained low-value candidates for deeper evidence.',
            searchActions: [],
            fetchActions: [
              {
                url: state.discoveredCandidates[0]?.url ?? '',
                why: 'Inspect the latest retained reprint candidate',
              },
            ],
            uncertainties: ['Need fetched evidence'],
            discardedLeads: [],
          };
        }

        assert.equal(state.discoveredCandidates.length, 2);
        return {
          decision: 'finalize',
          reasoning: 'Stop after validating the pruning boundary.',
          searchActions: [],
          fetchActions: [],
          uncertainties: [],
          discardedLeads: [],
          finalPackage: {
            status: 'FINAL_ASSERTION_STOP',
          },
        };
      },
      searchTool: {
        search: async (query) => Array.from({ length: 5 }, (_, index) => ({
          query,
          title: `臃肿新闻标题 ${index}`,
          url: `https://corrupted-news.com/${index}.html`,
          snippet: '毫无价值的转载噪声文本'.repeat(20),
          source: 'noise-media',
          policy_grade: 'news_reprint' as const,
          kerry_quality_status: 'usable_results' as const,
          kerry_quality_reason: 'Too much news',
        })),
      },
      fetchTool: {
        fetch: async (url) => ({
          requestedUrl: url,
          finalUrl: url,
          title: '核心转载页',
          content: '核心内容...',
          backend: 'fetch-backend',
          evidence_clues: {
            is_suspected_reprint: true,
            extracted_doc_no: '某政发〔2026〕1号',
            potential_official_urls: [],
          },
        }),
      },
    },
  );

  assert.equal(step, 3);
  assert.equal(seenStates[1]?.discoveredCandidates.length, 2);
  assert.equal(result.discoveredCandidates.length, 5);
  assert.equal((result.decision.finalPackage as { status?: string } | undefined)?.status, 'FINAL_ASSERTION_STOP');
});

test('policy loop keeps the highest-value non-official candidates in the pruned active view', async () => {
  const seenStates: PolicyAgentState[] = [];

  let step = 0;

  const result = await runPolicyTaskLoop(
    { topic: '智能制造重排测试' },
    {
      maxIterations: 3,
      askAgent: async (state) => {
        seenStates.push(structuredClone(state));
        step += 1;

        if (step === 1) {
          return {
            decision: 'continue_search',
            reasoning: 'Need broad radar clues first.',
            searchActions: [
              {
                query: '智能制造重排测试',
                why: 'Create a mixed-value discovery pool',
              },
            ],
            fetchActions: [],
            uncertainties: ['No fetched evidence yet'],
            discardedLeads: [],
          };
        }

        if (step === 2) {
          const activeIds = state.discoveredCandidates.map((candidate) => candidate.source);
          assert.equal(state.discoveredCandidates.length, 2);
          assert.deepEqual(activeIds, ['gov-interpretation', 'doc-news']);
          return {
            decision: 'continue_fetch',
            reasoning: 'Fetch the retained document-bearing news item.',
            searchActions: [],
            fetchActions: [
              {
                url: state.discoveredCandidates[1]?.url ?? '',
                why: 'Inspect the retained high-value news clue',
              },
            ],
            uncertainties: ['Need fetched evidence'],
            discardedLeads: [],
          };
        }

        const activeIds = state.discoveredCandidates.map((candidate) => candidate.source);
        assert.equal(state.discoveredCandidates.length, 2);
        assert.deepEqual(activeIds, ['gov-interpretation', 'doc-news']);
        return {
          decision: 'finalize',
          reasoning: 'Stop after validating evidence-aware pruning.',
          searchActions: [],
          fetchActions: [],
          uncertainties: [],
          discardedLeads: [],
          finalPackage: {
            status: 'FINAL_ASSERTION_STOP',
          },
        };
      },
      searchTool: {
        search: async (query) => [
          {
            query,
            title: '垃圾通稿',
            url: 'https://t.com/1.html',
            snippet: '普通转载噪声',
            source: 'garbage-news',
            policy_grade: 'news_reprint',
            kerry_quality_status: 'usable_results',
            kerry_quality_reason: 'Mixed results',
          },
          {
            query,
            title: '工信部解读',
            url: 'https://gov.cn/interp.html',
            snippet: '官方解读内容',
            source: 'gov-interpretation',
            policy_grade: 'official_interpretation',
            kerry_quality_status: 'usable_results',
            kerry_quality_reason: 'Mixed results',
          },
          {
            query,
            title: '带文号的高级转载',
            url: 'https://t.com/2.html',
            snippet: '转载中提到了关键文号',
            source: 'doc-news',
            policy_grade: 'news_reprint',
            kerry_quality_status: 'usable_results',
            kerry_quality_reason: 'Mixed results',
            evidence_clues: {
              extracted_doc_no: '工信厅联装〔2026〕1号',
            },
          },
          {
            query,
            title: '政府网首页',
            url: 'https://gov.cn/index.html',
            snippet: '首页入口',
            source: 'gov-homepage',
            policy_grade: 'portal_homepage',
            kerry_quality_status: 'usable_results',
            kerry_quality_reason: 'Mixed results',
          },
        ],
      },
      fetchTool: {
        fetch: async (url) => ({
          requestedUrl: url,
          finalUrl: url,
          title: '带文号的高级转载',
          content: '洗出文号...',
          backend: 'fetch-backend',
          evidence_clues: {
            is_suspected_reprint: true,
            extracted_doc_no: '工信厅联装〔2026〕1号',
            potential_official_urls: [],
          },
        }),
      },
    },
  );

  assert.equal(step, 3);
  assert.equal(seenStates[1]?.discoveredCandidates.length, 2);
  assert.equal(result.discoveredCandidates.length, 4);
  assert.equal((result.decision.finalPackage as { status?: string } | undefined)?.status, 'FINAL_ASSERTION_STOP');
});
test('policy loop keeps the current-turn fetch target in the next active view even when its score is lowest', async () => {
  const targetGarbageUrl = 'https://garbage-media.com/noise.html';
  const seenStates: PolicyAgentState[] = [];

  let step = 0;

  const result = await runPolicyTaskLoop(
    { topic: '思维锚点测试' },
    {
      maxIterations: 3,
      askAgent: async (state) => {
        seenStates.push(structuredClone(state));
        step += 1;

        if (step === 1) {
          return {
            decision: 'continue_search',
            reasoning: 'Need broad radar clues first.',
            searchActions: [
              {
                query: '思维锚点测试',
                why: 'Create a mixed-value discovery pool',
              },
            ],
            fetchActions: [],
            uncertainties: ['No fetched evidence yet'],
            discardedLeads: [],
          };
        }

        if (step === 2) {
          const activeIds = state.discoveredCandidates.map((candidate) => candidate.source);
          assert.equal(state.discoveredCandidates.length, 2);
          assert.deepEqual(activeIds, ['high-interpretation', 'high-doc']);
          return {
            decision: 'continue_fetch',
            reasoning: 'Probe the lowest-value candidate to preserve reasoning continuity.',
            searchActions: [],
            fetchActions: [
              {
                url: targetGarbageUrl,
                why: 'Inspect the current-turn garbage anchor',
              },
            ],
            uncertainties: ['Need fetched evidence'],
            discardedLeads: [],
          };
        }

        const activeIds = state.discoveredCandidates.map((candidate) => candidate.source);
        assert.equal(state.discoveredCandidates.length, 2);
        assert.deepEqual(activeIds, ['high-interpretation', 'low-garbage']);
        return {
          decision: 'finalize',
          reasoning: 'Stop after validating anchor immunity.',
          searchActions: [],
          fetchActions: [],
          uncertainties: [],
          discardedLeads: [],
          finalPackage: {
            status: 'FINAL_ASSERTION_STOP',
          },
        };
      },
      searchTool: {
        search: async (query) => [
          {
            query,
            title: '高分官方解读',
            url: 'https://gov.cn/interp.html',
            snippet: '官方解读内容',
            source: 'high-interpretation',
            policy_grade: 'official_interpretation',
            kerry_quality_status: 'usable_results',
            kerry_quality_reason: 'Mixed',
          },
          {
            query,
            title: '带文号的高级转载',
            url: 'https://t.com/doc.html',
            snippet: '转载中提到了关键文号',
            source: 'high-doc',
            policy_grade: 'news_reprint',
            kerry_quality_status: 'usable_results',
            kerry_quality_reason: 'Mixed',
            evidence_clues: {
              extracted_doc_no: '某字1号',
            },
          },
          {
            query,
            title: '极低分垃圾通稿',
            url: targetGarbageUrl,
            snippet: '普通转载噪声',
            source: 'low-garbage',
            policy_grade: 'news_reprint',
            kerry_quality_status: 'usable_results',
            kerry_quality_reason: 'Mixed',
          },
        ],
      },
      fetchTool: {
        fetch: async (url) => ({
          requestedUrl: url,
          finalUrl: url,
          title: '极低分垃圾通稿',
          content: '毫无价值的通稿废话...',
          backend: 'fetch-backend',
          evidence_clues: {
            is_suspected_reprint: true,
            extracted_doc_no: null,
            potential_official_urls: [],
          },
        }),
      },
    },
  );

  assert.equal(step, 3);
  assert.equal(result.discoveredCandidates.length, 3);
  assert.equal((result.decision.finalPackage as { status?: string } | undefined)?.status, 'FINAL_ASSERTION_STOP');
});

test('policy loop interrupts at maxIterations when blocked retries would otherwise continue forever', async () => {
  const seenStates: PolicyAgentState[] = [];
  const searchCalls: string[] = [];
  const fetchCalls: string[] = [];

  const decisions: PolicyAgentDecision[] = [
    {
      decision: 'continue_search',
      reasoning: 'Need broad radar clues first.',
      searchActions: [
        {
          query: '绥化企业减免',
          why: 'Find reprint clues first',
        },
      ],
      fetchActions: [],
      uncertainties: ['No fetched evidence yet'],
      discardedLeads: [],
    },
    {
      decision: 'continue_fetch',
      reasoning: 'Fetch the reprint because it may contain a policy document number.',
      searchActions: [],
      fetchActions: [
        {
          url: 'https://www.chinatax.com/news.html',
          why: 'Inspect the reprint for a policy document number',
        },
      ],
      uncertainties: ['Need document number confirmation'],
      discardedLeads: [],
    },
    {
      decision: 'continue_search',
      reasoning: 'Retry once with the normalized document number despite the network block.',
      searchActions: [
        {
          query: '绥政发〔2026〕7号',
          why: 'Retry with the normalized document number only',
        },
      ],
      fetchActions: [],
      uncertainties: ['Administrative WAF still blocks official retrieval'],
      discardedLeads: [],
    },
    {
      decision: 'continue_search',
      reasoning: 'One more retry would happen if the loop guard failed.',
      searchActions: [
        {
          query: '绥政发20267号 官网',
          why: 'This retry must never execute',
        },
      ],
      fetchActions: [],
      uncertainties: ['Should never be seen'],
      discardedLeads: [],
    },
  ];

  let decisionIndex = 0;

  const result = await runPolicyTaskLoop(
    { topic: '2026年黑龙江绥化高新技术企业租金减免政策' },
    {
      maxIterations: 3,
      askAgent: async (state) => {
        seenStates.push(structuredClone(state));
        const decision = decisions[decisionIndex];
        decisionIndex += 1;
        if (!decision) {
          throw new Error('missing mock decision');
        }
        return decision;
      },
      searchTool: {
        search: async (query) => {
          searchCalls.push(query);
          if (query === '绥政发〔2026〕7号') {
            return [
              {
                query,
                title: '访问受阻',
                url: 'https://waf.example/blocked',
                snippet: '行政站点触发 WAF 校验，暂时无法获取正文。',
                source: 'waf-probe',
                policy_grade: 'corrupted',
                kerry_quality_status: 'blocked_by_waf',
                kerry_quality_reason: 'Administrative WAF blocked repeated document-number retrieval.',
              },
            ];
          }

          return [
            {
              query,
              title: '绥化新政落地',
              url: 'https://www.chinatax.com/news.html',
              snippet: '转载内容...',
              source: 'chinatax',
              policy_grade: 'news_reprint',
              kerry_quality_status: 'usable_results',
              kerry_quality_reason: 'Found reprinted news.',
            },
          ];
        },
      },
      fetchTool: {
        fetch: async (url) => {
          fetchCalls.push(url);
          return {
            requestedUrl: url,
            finalUrl: url,
            title: '绥化新政落地',
            content: '根据绥政发〔2026〕7号文件精神，执行新的减免政策。',
            backend: 'fetch-backend',
            evidence_clues: {
              is_suspected_reprint: true,
              extracted_doc_no: '绥政发〔2026〕7号',
              potential_official_urls: [],
            },
          };
        },
      },
    },
  );

  assert.equal(decisionIndex, 3);
  assert.equal(seenStates.length, 3);
  assert.deepEqual(searchCalls, ['绥化企业减免', '绥政发〔2026〕7号']);
  assert.deepEqual(fetchCalls, ['https://www.chinatax.com/news.html']);
  assert.equal(result.currentIteration, 3);
  assert.equal(result.loop_interrupted_by_gate, true);
  assert.equal(result.final_quality_status, 'blocked_by_waf');
  assert.equal(result.final_quality_reason, 'Administrative WAF blocked repeated document-number retrieval.');
});
