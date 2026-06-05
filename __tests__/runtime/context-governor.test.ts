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

test('context governor keeps official_text outside the general cap while trimming low-value candidates', () => {
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

  assert.equal(governed.length, 3);
  assert.deepEqual(governed.map((candidate) => candidate.source), [
    'official-text',
    'gov-interpretation',
    'doc-news',
  ]);
});

test('context governor grants current-turn anchor immunity to a just-targeted low-score candidate', () => {
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
    'low-garbage',
  ]);
});

test('context governor scores official interpretation above doc-bearing reprint above ordinary noise', () => {
  assert.equal(candidateEvidenceScore({ policy_grade: 'official_interpretation' } as never) > candidateEvidenceScore({ policy_grade: 'news_reprint', evidence_clues: { extracted_doc_no: '某字1号' } } as never), true);
  assert.equal(candidateEvidenceScore({ policy_grade: 'news_reprint', evidence_clues: { extracted_doc_no: '某字1号' } } as never) > candidateEvidenceScore({ policy_grade: 'portal_homepage' } as never), true);
  assert.equal(candidateEvidenceScore({ policy_grade: 'portal_homepage' } as never) > candidateEvidenceScore({ policy_grade: 'news_reprint' } as never), true);
});
