import test from 'node:test';
import assert from 'node:assert/strict';
import { askRealClaudeDecision } from '../../src/runtime/ask-real-claude.ts';


test('real Claude askAgent maps recommendedNextActions search plans into executable search actions', async () => {
  const decision = await askRealClaudeDecision(
    {
      task: { topic: '绥化市科技招商政策' },
      discoveredCandidates: [],
      fetchedEvidence: [],
      currentIteration: 0,
      uncertainties: [],
    },
    {
      callModel: async () => JSON.stringify({
        status: 'needs_search',
        finalJudgment: {
          conclusion: '目前无可用证据，无法形成业务可用政策结论。',
        },
        recommendedNextActions: [
          {
            action: 'search',
            priority: 1,
            reason: '先定位政府官网正式政策文件。',
            queries: [
              '绥化市 科技招商 政策 site:.gov.cn',
              '绥化市 科技局 招商 政策 site:.gov.cn',
            ],
          },
        ],
        uncertainties: ['科技招商政策可能不是单独文件。'],
      }),
    },
  );

  assert.equal(decision.decision, 'continue_search');
  assert.equal(decision.searchActions.length, 2);
  assert.match(decision.searchActions[1]?.query ?? '', /科技局/);
  assert.match(decision.reasoning, /无可用证据|业务可用政策结论/);
});

test('real Claude askAgent treats NEEDS_RADAR_SEARCH with shouldStop false as continue_search even without explicit search actions', async () => {
  const decision = await askRealClaudeDecision(
    {
      task: { topic: '绥化市科技招商政策' },
      discoveredCandidates: [],
      fetchedEvidence: [],
      currentIteration: 1,
      uncertainties: [],
    },
    {
      callModel: async () => JSON.stringify({
        status: 'NEEDS_RADAR_SEARCH',
        stopDecision: {
          shouldStop: false,
          reason: '现有证据不足以支持停止，先扩大雷达搜索。',
        },
        finalJudgment: {
          conclusion: '还没有拿到足够官方正文，需要继续搜索。',
        },
        uncertainties: ['尚未定位到官方正文页面。'],
      }),
    },
  );

  assert.equal(decision.decision, 'continue_search');
  assert.deepEqual(decision.searchActions, [
    {
      query: '官方政策页面',
      why: '现有证据不足以支持停止，先扩大雷达搜索。',
    },
  ]);
  assert.match(decision.reasoning, /扩大雷达搜索|继续搜索/);
  assert.equal((decision.finalPackage as { status?: string } | undefined)?.status, 'NEEDS_RADAR_SEARCH');
});

test('real Claude askAgent preserves dynamic camelCase nextActions radar-search queries instead of collapsing to fallback query', async () => {
  const decision = await askRealClaudeDecision(
    {
      task: { topic: '黑龙江高新企业研发补贴' },
      discoveredCandidates: [],
      fetchedEvidence: [],
      currentIteration: 1,
      uncertainties: [],
    },
    {
      callModel: async () => JSON.stringify({
        status: 'NEEDS_RADAR_SEARCH',
        stopDecision: {
          shouldStop: false,
          reason: '继续沿模型给出的动态雷达搜索路线扩搜。',
        },
        nextActions: [
          {
            action: 'radar-search',
            reason: '先找省级科技厅与财政厅联合补贴线索。',
            query: '黑龙江 高新技术企业 研发投入 补贴 site:.gov.cn',
          },
          {
            action: 'search',
            reason: '补充厅局别名搜索。',
            queries: [
              '黑龙江省 科技厅 研发补助 高新企业 site:.gov.cn',
              '黑龙江省 财政厅 高新企业 研发奖补 site:.gov.cn',
            ],
          },
        ],
      }),
    },
  );

  assert.equal(decision.decision, 'continue_search');
  assert.deepEqual(decision.searchActions, [
    {
      query: '黑龙江 高新技术企业 研发投入 补贴 site:.gov.cn',
      why: '先找省级科技厅与财政厅联合补贴线索。',
    },
    {
      query: '黑龙江省 科技厅 研发补助 高新企业 site:.gov.cn',
      why: '补充厅局别名搜索。',
    },
    {
      query: '黑龙江省 财政厅 高新企业 研发奖补 site:.gov.cn',
      why: '补充厅局别名搜索。',
    },
  ]);
});

test('real Claude askAgent preserves concrete queries across snake_case and radar/search action array variants', async () => {
  const decision = await askRealClaudeDecision(
    {
      task: { topic: '山东省 制造业 技改 奖补' },
      discoveredCandidates: [],
      fetchedEvidence: [],
      currentIteration: 2,
      uncertainties: [],
    },
    {
      callModel: async () => JSON.stringify({
        status: 'CONTINUE_SEARCH',
        next_actions: [
          {
            action: 'RADAR_SEARCH',
            reason: '先做省级雷达扩搜。',
            query: '山东省 制造业 技术改造 奖补 site:.gov.cn',
          },
        ],
        radarActions: [
          {
            action: 'search',
            reason: '补充工信口径。',
            queries: [
              '山东省 工信厅 技术改造 奖补 site:.gov.cn',
              '山东省 工业和信息化厅 技改 奖补 site:.gov.cn',
            ],
          },
        ],
      }),
    },
  );

  assert.equal(decision.decision, 'continue_search');
  assert.deepEqual(decision.searchActions, [
    {
      query: '山东省 制造业 技术改造 奖补 site:.gov.cn',
      why: '先做省级雷达扩搜。',
    },
    {
      query: '山东省 工信厅 技术改造 奖补 site:.gov.cn',
      why: '补充工信口径。',
    },
    {
      query: '山东省 工业和信息化厅 技改 奖补 site:.gov.cn',
      why: '补充工信口径。',
    },
  ]);
});

test('real Claude askAgent preserves recommended and explicit search action arrays with alternate keyword field', async () => {
  const decision = await askRealClaudeDecision(
    {
      task: { topic: '南京市 专精特新 企业 政策' },
      discoveredCandidates: [],
      fetchedEvidence: [],
      currentIteration: 2,
      uncertainties: [],
    },
    {
      callModel: async () => JSON.stringify({
        status: 'NEEDS_SEARCH',
        recommendedNextActions: [
          {
            action: 'search',
            reason: '先补市级口径。',
            keyword: '南京市 专精特新 企业 政策 site:.gov.cn',
          },
        ],
        searchActions: [
          {
            action: 'radar-search',
            reason: '再扩搜工信部门专题页。',
            query: '南京市 工信局 专精特新 site:.gov.cn',
          },
        ],
      }),
    },
  );

  assert.equal(decision.decision, 'continue_search');
  assert.deepEqual(decision.searchActions, [
    {
      query: '南京市 专精特新 企业 政策 site:.gov.cn',
      why: '先补市级口径。',
    },
    {
      query: '南京市 工信局 专精特新 site:.gov.cn',
      why: '再扩搜工信部门专题页。',
    },
  ]);
});

test('real Claude askAgent preserves composite combinedActions search and fetch actions without fallback pollution', async () => {
  const decision = await askRealClaudeDecision(
    {
      task: { topic: '黑龙江高新企业研发补贴' },
      discoveredCandidates: [],
      fetchedEvidence: [],
      currentIteration: 2,
      uncertainties: [],
    },
    {
      callModel: async () => JSON.stringify({
        status: 'CONTINUE_SEARCH_AND_FETCH',
        rationale: '继续并行搜索政策关键词并抓取已命中的官方详情页。',
        combinedActions: [
          {
            action: 'search',
            reason: '扩搜省级科技厅政策表述。',
            query: '黑龙江省 高新技术企业 研发投入补贴 site:gov.cn',
          },
          {
            action: 'fetch',
            why: '抓取命中的官方正文页面。',
            url: 'https://example.gov.cn/policy-1',
          },
        ],
      }),
    },
  );

  assert.equal(decision.decision, 'continue_search');
  assert.deepEqual(decision.searchActions, [
    {
      query: '黑龙江省 高新技术企业 研发投入补贴 site:gov.cn',
      why: '扩搜省级科技厅政策表述。',
    },
  ]);
  assert.deepEqual(decision.fetchActions, [
    {
      url: 'https://example.gov.cn/policy-1',
      why: '抓取命中的官方正文页面。',
    },
  ]);
  assert.equal(decision.searchActions.some((action) => action.query === '官方政策页面'), false);
});

test('real Claude askAgent revives search actions from composite fetch contextQuery without injecting fallback query', async () => {
  const decision = await askRealClaudeDecision(
    {
      task: { topic: '黑龙江高新企业研发补贴' },
      discoveredCandidates: [],
      fetchedEvidence: [],
      currentIteration: 2,
      uncertainties: [],
    },
    {
      callModel: async () => JSON.stringify({
        status: 'SEARCH_AND_FETCH',
        rationale: '这一轮主要抓详情，但仍需要保留检索上下文。',
        fetchActions: [
          {
            action: 'fetch',
            why: '先抓黑龙江省科技厅命中的政策详情。',
            url: 'https://example.gov.cn/policy-2',
            contextQuery: '黑龙江省科技厅',
          },
        ],
      }),
    },
  );

  assert.equal(decision.decision, 'continue_search');
  assert.deepEqual(decision.searchActions, [
    {
      query: '黑龙江省科技厅',
      why: '先抓黑龙江省科技厅命中的政策详情。',
    },
  ]);
  assert.deepEqual(decision.fetchActions, [
    {
      url: 'https://example.gov.cn/policy-2',
      why: '先抓黑龙江省科技厅命中的政策详情。',
    },
  ]);
  assert.equal(decision.searchActions.some((action) => action.query === '官方政策页面'), false);
});




test('real Claude askAgent treats continue plus need_fetch status and fetch-only next_actions as continue_fetch', async () => {
  const decision = await askRealClaudeDecision(
    {
      task: { topic: '黑龙江高新企业研发补贴' },
      discoveredCandidates: [
        {
          query: '黑龙江 高新技术企业 租金减免 2026',
          title: 'hlj.gov.cn https://www.hlj.gov.cn',
          url: 'https://www.hlj.gov.cn/',
          snippet: '官方站点线索',
          source: 'cloudflare-search-local',
        },
      ],
      fetchedEvidence: [],
      currentIteration: 3,
      uncertainties: [],
    },
    {
      callModel: async () => JSON.stringify({
        decision: 'continue',
        status: 'need_fetch_official_candidates_before_further_search',
        reason: '已存在未访问的官方域名候选URL，必须先进入FETCH。',
        next_actions: [
          {
            type: 'FETCH',
            url: 'https://www.hlj.gov.cn/',
            why: '唯一强相关官方入口，应立即抓取正文证据。',
          },
        ],
      }),
    },
  );

  assert.equal(decision.decision, 'continue_fetch');
  assert.deepEqual(decision.fetchActions, [
    {
      url: 'https://www.hlj.gov.cn/',
      why: '唯一强相关官方入口，应立即抓取正文证据。',
    },
  ]);
  assert.equal((decision.finalPackage as { _raw_model_output?: string } | undefined)?._raw_model_output?.includes('https://www.hlj.gov.cn/'), true);
});

test('real Claude askAgent captures fetch alias actions such as visit_url fetch_page browse and read-url', async () => {
  const decision = await askRealClaudeDecision(
    {
      task: { topic: '黑龙江高新企业研发补贴' },
      discoveredCandidates: [],
      fetchedEvidence: [],
      currentIteration: 2,
      uncertainties: [],
    },
    {
      callModel: async () => JSON.stringify({
        status: 'SEARCH_AND_FETCH',
        rationale: '需要立刻抓取已发现的正文页面。',
        next_actions: [
          { type: 'visit_url', url: 'https://hlj.gov.cn/1', why: '抓正文 1' },
          { type: 'fetch_page', url: 'https://hlj.gov.cn/2', why: '抓正文 2' },
          { type: 'browse', url: 'https://hlj.gov.cn/3', why: '抓正文 3' },
          { type: 'read-url', url: 'https://hlj.gov.cn/4', why: '抓正文 4' },
        ],
      }),
    },
  );

  assert.equal(decision.fetchActions.length, 4);
  assert.deepEqual(decision.fetchActions.map((item) => item.url), [
    'https://hlj.gov.cn/1',
    'https://hlj.gov.cn/2',
    'https://hlj.gov.cn/3',
    'https://hlj.gov.cn/4',
  ]);
});

test('real Claude askAgent patches live-shape CONTINUE decision with type SEARCH and judgment summary into standard continue_search actions', async () => {
  const decision = await askRealClaudeDecision(
    {
      task: { topic: '哈尔滨工程大学电子信息工程（中英）3+1培养项目政策实施细则' },
      discoveredCandidates: [],
      fetchedEvidence: [],
      currentIteration: 1,
      uncertainties: [],
    },
    {
      callModel: async () => JSON.stringify({
        decision: 'CONTINUE',
        judgment: {
          summary: 'Located the HEU 3+1 program specification successfully.',
        },
        next_actions: [
          {
            type: 'SEARCH',
            query: '哈尔滨工程大学 电子信息工程 3+1 实施细则',
            reason: 'Need official url anchors',
          },
        ],
      }),
    },
  );

  assert.equal(decision.decision, 'continue_search');
  assert.deepEqual(decision.searchActions, [
    {
      query: '哈尔滨工程大学 电子信息工程 3+1 实施细则',
      why: 'Need official url anchors',
    },
  ]);
  assert.equal(decision.reasoning, 'Located the HEU 3+1 program specification successfully.');
});

test('real Claude askAgent preserves canonical continue_fetch fetchActions emitted by the prompt contract', async () => {
  const decision = await askRealClaudeDecision(
    {
      task: { topic: '黑龙江高新企业研发补贴' },
      discoveredCandidates: [
        {
          query: '黑龙江 高新技术企业 租金减免 2026',
          title: 'hlj.gov.cn https://www.hlj.gov.cn',
          url: 'https://www.hlj.gov.cn/',
          snippet: '官方站点线索',
          source: 'cloudflare-search-local',
        },
      ],
      fetchedEvidence: [],
      currentIteration: 2,
      uncertainties: [],
    },
    {
      callModel: async () => JSON.stringify({
        decision: 'continue_fetch',
        reasoning: 'Official candidate URLs are already available, so fetch them before more search.',
        searchActions: [],
        fetchActions: [
          {
            url: 'https://www.hlj.gov.cn/',
            why: 'Copy the exact discovered official URL into the canonical fetchActions array.',
          },
        ],
        uncertainties: [],
        discardedLeads: [],
      }),
    },
  );

  assert.equal(decision.decision, 'continue_fetch');
  assert.deepEqual(decision.searchActions, []);
  assert.deepEqual(decision.fetchActions, [
    {
      url: 'https://www.hlj.gov.cn/',
      why: 'Copy the exact discovered official URL into the canonical fetchActions array.',
    },
  ]);
});

