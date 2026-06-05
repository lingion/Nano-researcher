import test from 'node:test';
import assert from 'node:assert/strict';

import {
  candidateEvidenceScore,
  governLLMActiveView,
  normalizeDiscoveryCandidates,
} from '../../src/runtime/context-governor.ts';

test('context governor normalizes extracted document numbers in discovery candidates', () => {
  const governed = normalizeDiscoveryCandidates([
    {
      query: '智能制造',
      title: '带文号的高级转载',
      url: 'https://example.com/doc.html',
      snippet: '转载中提到了关键文号',
      source: 'doc-news',
      policy_grade: 'news_reprint',
      evidence_clues: {
        extracted_doc_no: '工信厅联装[2026]1号',
      },
    },
  ]);

  assert.equal(governed[0]?.evidence_clues?.extracted_doc_no, '工信厅联装〔2026〕1号');
});

test('context governor passes through every discovered candidate so official sources cannot be hidden from the model', () => {
  const governed = governLLMActiveView([
    {
      query: 'OPC 国家标准 国家标准委',
      title: '新手入门： OPC 社区是什么，怎么申请',
      url: 'https://zhuanlan.zhihu.com/p/2017238016758937574',
      snippet: '媒体社区页面',
      source: 'zhihu',
    },
    {
      query: 'OPC 国家标准 国家标准委',
      title: '什么是 OPC？有哪些成功的 OPC 商业模式？',
      url: 'https://www.36kr.com/p/3816858092241794',
      snippet: '媒体页面',
      source: '36kr',
    },
    {
      query: 'OPC 工业互联网 工信部 政策',
      title: '被写入多地“十五五”规划，OPC 凭什么站上风口？',
      url: 'https://www.ndrc.gov.cn/wsdwhfz/202605/t20260515_1405211.html',
      snippet: '全国已有超20个城市密集出台OPC专项扶持政策',
      source: 'ndrc',
    },
    {
      query: 'OPC 国家标准委 国家标准',
      title: '中华人民共和国国家标准',
      url: 'https://std.samr.gov.cn/dcpspTools/gbPlan/download?path=official.pdf',
      snippet: '国家标准 PDF',
      source: 'samr',
    },
  ], undefined, { maxGeneralCandidatesCount: 2 });

  assert.deepEqual(governed.map((candidate) => candidate.source), ['zhihu', '36kr', 'ndrc', 'samr']);
});
test('context governor keeps every candidate in input order while normalizing discovery candidates', () => {
  const governed = governLLMActiveView([
    {
      query: '智能制造',
      title: '政府红头正文',
      url: 'https://gov.cn/text.html',
      snippet: '红头正文',
      source: 'official-text',
      policy_grade: 'official_text',
    },
    {
      query: '智能制造',
      title: '高分官方解读',
      url: 'https://gov.cn/interp.html',
      snippet: '官方解读内容',
      source: 'gov-interpretation',
      policy_grade: 'official_interpretation',
    },
    {
      query: '智能制造',
      title: '带文号的高级转载',
      url: 'https://t.com/doc.html',
      snippet: '转载中提到了关键文号',
      source: 'doc-news',
      policy_grade: 'news_reprint',
      evidence_clues: {
        extracted_doc_no: '工信厅联装〔2026〕1号',
      },
    },
    {
      query: '智能制造',
      title: '普通垃圾新闻',
      url: 'https://t.com/noise.html',
      snippet: '普通转载噪声',
      source: 'garbage-news',
      policy_grade: 'news_reprint',
    },
  ], undefined, { maxGeneralCandidatesCount: 2 });

  assert.equal(governed.length, 4);
  assert.deepEqual(governed.map((candidate) => candidate.source), [
    'official-text',
    'gov-interpretation',
    'doc-news',
    'garbage-news',
  ]);
});

test('context governor does not hide non-anchor candidates when a current-turn anchor is present', () => {
  const governed = governLLMActiveView([
    {
      query: '思维锚点测试',
      title: '高分官方解读',
      url: 'https://gov.cn/interp.html',
      snippet: '官方解读内容',
      source: 'high-interpretation',
      policy_grade: 'official_interpretation',
    },
    {
      query: '思维锚点测试',
      title: '带文号的高级转载',
      url: 'https://t.com/doc.html',
      snippet: '转载中提到了关键文号',
      source: 'high-doc',
      policy_grade: 'news_reprint',
      evidence_clues: {
        extracted_doc_no: '某字1号',
      },
    },
    {
      query: '思维锚点测试',
      title: '极低分垃圾通稿',
      url: 'https://garbage-media.com/noise.html',
      snippet: '普通转载噪声',
      source: 'low-garbage',
      policy_grade: 'news_reprint',
    },
  ], 'https://garbage-media.com/noise.html', { maxGeneralCandidatesCount: 2 });

  assert.deepEqual(governed.map((candidate) => candidate.source), [
    'high-interpretation',
    'high-doc',
    'low-garbage',
  ]);
});

test('context governor scores official interpretation above doc-bearing reprint above ordinary noise', () => {
  assert.equal(candidateEvidenceScore({ policy_grade: 'official_interpretation' } as never) > candidateEvidenceScore({ policy_grade: 'news_reprint', evidence_clues: { extracted_doc_no: '某字1号' } } as never), true);
  assert.equal(candidateEvidenceScore({ policy_grade: 'news_reprint', evidence_clues: { extracted_doc_no: '某字1号' } } as never) > candidateEvidenceScore({ policy_grade: 'portal_homepage' } as never), true);
  assert.equal(candidateEvidenceScore({ policy_grade: 'portal_homepage' } as never) > candidateEvidenceScore({ policy_grade: 'news_reprint' } as never), true);
});
