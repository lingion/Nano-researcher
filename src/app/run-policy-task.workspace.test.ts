import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runPolicyTaskLoop } from './run-policy-task.ts';
import type { FetchTool, SearchTool } from '../runtime/tool-registry.ts';

function createNoopSearchTool(): SearchTool {
  return {
    search: async () => [],
  };
}

function createStaticFetchTool(): FetchTool {
  return {
    fetch: async (url: string) => ({
      requestedUrl: url,
      finalUrl: url,
      title: '黑龙江省企业研发投入奖补实施细则',
      content: '第一条 为支持企业研发投入，制定本细则。',
      backend: 'test-fetch',
      evidence_clues: {
        is_suspected_reprint: false,
        extracted_doc_no: '黑科规〔2026〕1号',
        potential_official_urls: [],
      },
      kerry_cleaning: {
        raw_text: '黑龙江省企业研发投入奖补实施细则 第一条 为支持企业研发投入，制定本细则。',
        cleaned_text: '第一条 为支持企业研发投入，制定本细则。',
        metadata: {
          document_number: '黑科规〔2026〕1号',
          issuing_body: '黑龙江省科学技术厅',
        },
        removed_fragments: [],
        cleaning_alerts: [],
        cleaning_stats: {
          raw_length: 40,
          cleaned_length: 20,
          removed_count: 0,
        },
      },
    }),
  };
}

async function runSingleFetch(topic: string, fetchUrl: string): Promise<void> {
  await runPolicyTaskLoop(
    { topic },
    {
      maxIterations: 2,
      searchTool: createNoopSearchTool(),
      fetchTool: createStaticFetchTool(),
      askAgent: async (state) => {
        if (state.fetchedEvidence.length === 0) {
          return {
            decision: 'continue_fetch',
            reasoning: '先抓取一份政策正文。',
            searchActions: [],
            fetchActions: [
              { url: fetchUrl, why: '抓取正文' },
            ],
            uncertainties: [],
            discardedLeads: [],
          };
        }

        return {
          decision: 'finalize',
          reasoning: '已完成抓取。',
          searchActions: [],
          fetchActions: [],
          finalPackage: {},
          uncertainties: [],
          discardedLeads: [],
        };
      },
    },
  );
}

test('runPolicyTaskLoop persists fetched evidence into workspace index and evidence file', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-policy-agent-workspace-repo-'));
  process.chdir(repoRoot);

  try {
    await runSingleFetch('黑龙江研发奖补政策', 'https://kjt.hlj.gov.cn/policy/1');

    const workspaceRoot = path.join(repoRoot, 'workspace');
    const indexPath = path.join(workspaceRoot, 'index.json');
    assert.equal(fs.existsSync(indexPath), true);

    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
      documents: Record<string, { evidence_path: string; seen_count: number }>;
    };
    const documentIds = Object.keys(index.documents);
    assert.equal(documentIds.length, 1);

    const persisted = index.documents[documentIds[0]];
    assert.equal(persisted.seen_count, 1);
    assert.equal(fs.existsSync(path.join(workspaceRoot, persisted.evidence_path)), true);
  } finally {
    process.chdir('/Users/lingion/repo-downloads/local-policy-agent');
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('runPolicyTaskLoop reuses the same document and increments seen_count on repeat fetch', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-policy-agent-workspace-repo-'));
  process.chdir(repoRoot);

  try {
    await runSingleFetch('黑龙江研发奖补政策', 'https://kjt.hlj.gov.cn/policy/1');
    await runSingleFetch('黑龙江研发奖补政策复查', 'https://kjt.hlj.gov.cn/policy/1');

    const workspaceRoot = path.join(repoRoot, 'workspace');
    const index = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'index.json'), 'utf8')) as {
      documents: Record<string, { evidence_path: string; seen_count: number; first_seen_at: string; last_seen_at: string }>;
    };
    const documentIds = Object.keys(index.documents);
    assert.equal(documentIds.length, 1);

    const persisted = index.documents[documentIds[0]];
    assert.equal(persisted.seen_count, 2);
    assert.notEqual(persisted.first_seen_at, '');
    assert.notEqual(persisted.last_seen_at, '');

    const evidenceRecord = JSON.parse(fs.readFileSync(path.join(workspaceRoot, persisted.evidence_path), 'utf8')) as {
      seen_count: number;
      record: { kerry_cleaning?: { metadata?: Record<string, unknown> } };
    };
    assert.equal(evidenceRecord.seen_count, 2);
    assert.equal(evidenceRecord.record.kerry_cleaning?.metadata?.document_number, '黑科规〔2026〕1号');
  } finally {
    process.chdir('/Users/lingion/repo-downloads/local-policy-agent');
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
