import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EvidenceManager, ReportManager } from '../../src/workspace/index.ts';
import type { FetchedPageRecord } from '../../src/fetch-fusion/types.ts';

function sampleRecord(
  url = 'https://gxt.hlj.gov.cn/gxt/c106958/202401/c00_31700952.shtml',
  options: {
    title?: string;
    documentNumber?: string | null;
    sourceDomain?: string;
  } = {},
): FetchedPageRecord {
  return {
    requestedUrl: url,
    finalUrl: url,
    title: options.title ?? '关于印发《黑龙江省企业研发投入奖补实施细则》的通知',
    content: '第一条 为支持企业研发投入，制定本细则。',
    backend: 'search-mcp:fetch_url',
    evidence_clues: {
      is_suspected_reprint: false,
      extracted_doc_no: options.documentNumber ?? null,
      potential_official_urls: [],
    },
    kerry_cleaning: {
      raw_text: 'raw policy text',
      cleaned_text: '第一条 为支持企业研发投入，制定本细则。',
      metadata: {
        normalized_url: url,
        source_domain: options.sourceDomain ?? 'gxt.hlj.gov.cn',
      },
      removed_fragments: [],
      cleaning_alerts: [],
      cleaning_stats: {
        raw_length: 15,
        cleaned_length: 20,
      },
    },
  };
}

test('EvidenceManager saves fetch results, returns index, and finds records by URL', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-manager-'));

  try {
    const manager = new EvidenceManager(workspaceDir);
    const documentId = await manager.saveFetchResult(sampleRecord(), '黑龙江研发奖补政策');

    assert.match(documentId, /^doc_[a-f0-9]{12}$/);

    const index = await manager.getIndex();
    assert.equal(Object.keys(index.documents).length, 1);
    assert.equal(index.documents[documentId].seen_count, 1);

    const found = await manager.findByUrl('https://gxt.hlj.gov.cn/gxt/c106958/202401/c00_31700952.shtml');
    assert.equal(found?.document_id, documentId);
    assert.equal(found?.backend, 'search-mcp:fetch_url');

    const missing = await manager.findByUrl('https://example.com/missing');
    assert.equal(missing, null);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('EvidenceManager stores task topic in evidence file while keeping index lightweight', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-manager-'));

  try {
    const manager = new EvidenceManager(workspaceDir);
    const documentId = await manager.saveFetchResult(sampleRecord(), '黑龙江研发奖补政策');
    const index = await manager.getIndex();
    const entry = index.documents[documentId] as Record<string, unknown>;

    assert.equal(entry.last_task_topic, undefined);

    const evidenceFile = path.join(workspaceDir, index.documents[documentId].evidence_path);
    const persisted = JSON.parse(fs.readFileSync(evidenceFile, 'utf8')) as {
      task_topic?: string;
      record?: FetchedPageRecord;
    };
    assert.equal(persisted.task_topic, '黑龙江研发奖补政策');
    assert.equal(persisted.record?.kerry_cleaning?.metadata?.source_domain, 'gxt.hlj.gov.cn');
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('EvidenceManager marks a single document as self-canonical on ingestion', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-manager-'));

  try {
    const manager = new EvidenceManager(workspaceDir);
    const documentId = await manager.saveFetchResult(sampleRecord(), '黑龙江研发奖补政策');
    const index = await manager.getIndex();
    const entry = index.documents[documentId] as {
      relations?: {
        is_canonical?: boolean;
        canonical_id?: string | null;
        duplicate_of?: string | null;
        duplicates?: string[];
      };
    };

    assert.equal(entry.relations?.is_canonical, true);
    assert.equal(entry.relations?.canonical_id, documentId);
    assert.equal(entry.relations?.duplicate_of, null);
    assert.deepEqual(entry.relations?.duplicates, []);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('EvidenceManager links same-document-number records under a canonical document', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-manager-'));

  try {
    const manager = new EvidenceManager(workspaceDir);
    const canonicalId = await manager.saveFetchResult(
      sampleRecord('https://gxt.hlj.gov.cn/gxt/c106958/202401/c00_31700952.shtml', {
        documentNumber: '黑科规〔2026〕1号',
        sourceDomain: 'gxt.hlj.gov.cn',
      }),
      '黑龙江研发奖补政策',
    );
    const duplicateId = await manager.saveFetchResult(
      sampleRecord('https://hlj.gov.cn/portal/repost/001', {
        title: '关于印发《黑龙江省企业研发投入奖补实施细则》的通知_黑龙江省人民政府',
        documentNumber: '黑科规〔2026〕1号',
        sourceDomain: 'hlj.gov.cn',
      }),
      '黑龙江研发奖补政策转载',
    );

    const index = await manager.getIndex();
    assert.equal(Object.keys(index.documents).length, 2);

    const canonical = index.documents[canonicalId] as {
      relations?: { is_canonical?: boolean; duplicate_of?: string | null; duplicates?: string[] };
    };
    const duplicate = index.documents[duplicateId] as {
      relations?: { is_canonical?: boolean; canonical_id?: string | null; duplicate_of?: string | null };
    };

    assert.equal(canonical.relations?.is_canonical, true);
    assert.deepEqual(canonical.relations?.duplicates, [duplicateId]);
    assert.equal(duplicate.relations?.is_canonical, false);
    assert.equal(duplicate.relations?.duplicate_of, canonicalId);
    assert.equal(duplicate.relations?.canonical_id, canonicalId);

    assert.equal(fs.existsSync(path.join(workspaceDir, index.documents[canonicalId].evidence_path)), true);
    assert.equal(fs.existsSync(path.join(workspaceDir, index.documents[duplicateId].evidence_path)), true);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('EvidenceManager lists evidence, returns cleaned evidence views, and resolves canonical groups', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-manager-'));

  try {
    const manager = new EvidenceManager(workspaceDir);
    const canonicalId = await manager.saveFetchResult(
      sampleRecord('https://gxt.hlj.gov.cn/gxt/c106958/202401/c00_31700952.shtml', {
        documentNumber: '黑科规〔2026〕1号',
        sourceDomain: 'gxt.hlj.gov.cn',
      }),
      '黑龙江研发奖补政策',
    );
    const duplicateId = await manager.saveFetchResult(
      sampleRecord('https://hlj.gov.cn/portal/repost/001', {
        title: '关于印发《黑龙江省企业研发投入奖补实施细则》的通知_黑龙江省人民政府',
        documentNumber: '黑科规〔2026〕1号',
        sourceDomain: 'hlj.gov.cn',
      }),
      '黑龙江研发奖补政策转载',
    );

    const listed = await manager.listEvidence();
    assert.equal(listed.length, 2);

    const evidence = await manager.getEvidence(canonicalId);
    assert.equal(evidence?.document_id, canonicalId);
    assert.equal(evidence?.cleaned_text, '第一条 为支持企业研发投入，制定本细则。');
    assert.equal((evidence as { raw_text?: string }).raw_text, undefined);

    const group = await manager.getCanonicalGroup(duplicateId);
    assert.equal(group.canonical?.document_id, canonicalId);
    assert.deepEqual(group.duplicates.map((item) => item.document_id), [duplicateId]);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('ReportManager writes markdown reports with front matter into workspace reports', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-manager-'));

  try {
    const reports = new ReportManager(workspaceDir);
    const written = await reports.writeReport({
      title: '黑龙江研发奖补政策摘要',
      taskTopic: '黑龙江省企业研发投入奖补实施细则',
      canonicalDocumentIds: ['doc_ada135b3d264'],
      duplicateDocumentIds: ['doc_627d40b01768'],
      content: '# 黑龙江研发奖补政策摘要\n\n## 摘要\n\n支持企业研发投入。',
    });

    assert.match(written.reportId, /^rpt_[a-f0-9]{12}$/);
    assert.equal(written.path.endsWith('.md'), true);
    const reportPath = path.join(workspaceDir, written.path);
    assert.equal(fs.existsSync(reportPath), true);

    const markdown = fs.readFileSync(reportPath, 'utf8');
    assert.match(markdown, /^---\n/);
    assert.match(markdown, /title: 黑龙江研发奖补政策摘要/);
    assert.match(markdown, /task_topic: 黑龙江省企业研发投入奖补实施细则/);
    assert.match(markdown, /canonical_document_ids:\n  - doc_ada135b3d264/);
    assert.match(markdown, /duplicate_document_ids:\n  - doc_627d40b01768/);
    assert.match(markdown, /# 黑龙江研发奖补政策摘要/);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});
