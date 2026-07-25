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
          why: 'Lock the official_product source',
        },
      ],
      uncertainties: [],
      discardedLeads: [],
    },
    {
      decision: 'finalize',
      reasoning: 'Confident validation complete after securing official_product.',
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
              access_source_grade: 'credible_reporting',
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
  assert.equal(seenStates[1]?.discoveredCandidates[0]?.access_source_grade, 'credible_reporting');
  assert.deepEqual(
    seenStates[2]?.fetchedEvidence[0]?.evidence_clues?.potential_official_urls,
    ['https://www.suihua.gov.cn/zw/txt.html'],
  );
  assert.equal(result.currentIteration, 4);
  assert.equal(result.discoveredCandidates[0]?.access_source_grade, 'credible_reporting');
  assert.equal(result.fetchedEvidence[1]?.title, '关于印发高新技术企业租金减免政策的通知');
  assert.equal((result.decision.finalPackage as { status?: string } | undefined)?.status, 'FINAL_ASSERTION_STOP');
});

test('policy loop preserves document numbers and promotes model-provided official candidates', async () => {
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
          assert.equal(state.discoveredCandidates[0]?.access_source_grade, 'credible_reporting');
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
          assert.equal(state.fetchedEvidence[0]?.evidence_clues?.extracted_doc_no, '绥政发[2026]7号');
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

        assert.equal(state.discoveredCandidates.some((candidate) => candidate.access_source_grade === 'official_product'), true);
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
          if (query === targetDocNo || query === '绥政发[2026]7号') {
            return [
              {
                query,
                title: '绥化市人民政府关于印发高新企业减免办法的通知（绥政发〔2026〕7号）',
                url: 'https://www.suihua.gov.cn/art.html',
                snippet: '红头正文公告...',
                source: 'suihua-gov',
                access_source_grade: 'official_product',
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
              access_source_grade: 'credible_reporting',
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
  assert.deepEqual(searchCalls, ['黑龙江绥化企业减免', '绥政发[2026]7号']);
  assert.deepEqual(fetchCalls, ['https://www.chinatax.com/news.html']);
  assert.equal(seenStates[2]?.fetchedEvidence[0]?.evidence_clues?.extracted_doc_no, '绥政发[2026]7号');
  assert.equal(result.discoveredCandidates.some((candidate) => candidate.access_source_grade === 'official_product'), true);
  assert.equal(result.loop_interrupted_by_gate, undefined);
  assert.equal((result.decision.finalPackage as { status?: string } | undefined)?.status, 'FINAL_ASSERTION_STOP');
});

test('policy loop passes discovery history to the next agent decision while preserving full audit history', async () => {
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
          assert.equal(state.discoveredCandidates.length, 5);
          assert.equal(state.discoveredCandidates.every((candidate) => candidate.access_source_grade === 'credible_reporting'), true);
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

        assert.equal(state.discoveredCandidates.length, 5);
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
          access_source_grade: 'credible_reporting' as const,
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
  assert.equal(seenStates[1]?.discoveredCandidates.length, 5);
  assert.equal(result.discoveredCandidates.length, 5);
  assert.equal((result.decision.finalPackage as { status?: string } | undefined)?.status, 'FINAL_ASSERTION_STOP');
});

test('policy loop keeps all non-official candidates in the active view', async () => {
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
          assert.equal(state.discoveredCandidates.length, 4);
          assert.deepEqual(activeIds, ['garbage-news', 'gov-interpretation', 'doc-news', 'gov-homepage']);
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
          assert.equal(state.discoveredCandidates.length, 4);
        assert.deepEqual(activeIds, ['garbage-news', 'gov-interpretation', 'doc-news', 'gov-homepage']);
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
            access_source_grade: 'credible_reporting',
            kerry_quality_status: 'usable_results',
            kerry_quality_reason: 'Mixed results',
          },
          {
            query,
            title: '工信部解读',
            url: 'https://gov.cn/interp.html',
            snippet: '官方解读内容',
            source: 'gov-interpretation',
            access_source_grade: 'official_access',
            kerry_quality_status: 'usable_results',
            kerry_quality_reason: 'Mixed results',
          },
          {
            query,
            title: '带文号的高级转载',
            url: 'https://t.com/2.html',
            snippet: '转载中提到了关键文号',
            source: 'doc-news',
            access_source_grade: 'credible_reporting',
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
            access_source_grade: 'noise',
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
  assert.equal(seenStates[1]?.discoveredCandidates.length, 4);
  assert.equal(result.discoveredCandidates.length, 4);
  assert.equal((result.decision.finalPackage as { status?: string } | undefined)?.status, 'FINAL_ASSERTION_STOP');
});
test('policy loop keeps every current-turn fetch target candidate visible after fetch', async () => {
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
          assert.equal(state.discoveredCandidates.length, 3);
          assert.deepEqual(activeIds, ['high-interpretation', 'high-doc', 'low-garbage']);
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
        assert.equal(state.discoveredCandidates.length, 3);
        assert.deepEqual(activeIds, ['high-interpretation', 'high-doc', 'low-garbage']);
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
            access_source_grade: 'official_access',
            kerry_quality_status: 'usable_results',
            kerry_quality_reason: 'Mixed',
          },
          {
            query,
            title: '带文号的高级转载',
            url: 'https://t.com/doc.html',
            snippet: '转载中提到了关键文号',
            source: 'high-doc',
            access_source_grade: 'credible_reporting',
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
            access_source_grade: 'credible_reporting',
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
                access_source_grade: 'corrupted',
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
              access_source_grade: 'credible_reporting',
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
  assert.equal(result.loop_interrupted_by_gate, undefined);
  assert.equal(result.final_quality_status, undefined);
  assert.equal(result.final_quality_reason, undefined);
});


test('policy loop preserves a model summarize_and_stop decision without fetched evidence', async () => {
  const decision: PolicyAgentDecision = {
    decision: 'summarize_and_stop',
    reasoning: 'The model chose to stop.',
    searchActions: [],
    fetchActions: [],
    uncertainties: ['No evidence was fetched'],
    discardedLeads: [],
    finalPackage: { status: 'MODEL_STOP' },
  };

  const result = await runPolicyTaskLoop(
    { topic: 'model-owned stop' },
    {
      maxIterations: 3,
      targetHotspotCount: 999,
      targetValidatedEvidenceCount: 999,
      askAgent: async () => decision,
      searchTool: { search: async () => [] },
      fetchTool: { fetch: async () => { throw new Error('must not fetch'); } },
    },
  );

  assert.equal(result.decision, decision);
  assert.equal(result.final_quality_status, undefined);
  assert.equal(result.currentIteration, 1);
});

test('policy loop preserves model continuation without target shortfall gates', async () => {
  const decisions: PolicyAgentDecision[] = [
    { decision: 'continue_search', reasoning: 'model says search', searchActions: [], fetchActions: [], uncertainties: [], discardedLeads: [] },
    { decision: 'continue_fetch', reasoning: 'model says fetch', searchActions: [], fetchActions: [], uncertainties: [], discardedLeads: [] },
  ];
  let index = 0;
  const result = await runPolicyTaskLoop(
    { topic: 'model-owned continuation' },
    {
      maxIterations: 2,
      targetHotspotCount: 999,
      targetValidatedEvidenceCount: 999,
      askAgent: async () => decisions[index++]!,
      searchTool: { search: async () => [] },
      fetchTool: { fetch: async () => { throw new Error('must not fetch'); } },
    },
  );

  assert.equal(result.decision.decision, 'continue_fetch');
  assert.equal(result.final_quality_status, undefined);
  assert.equal('insufficient_target_count' in result, false);
});
