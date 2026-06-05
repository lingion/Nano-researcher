import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeScanArtifacts } from '../../src/policy-scanner/reporter/write-scan-artifacts.ts';
import type { CandidateVerdict } from '../../src/engine/types.ts';
import type { DecisionContext } from '../../src/engine/decision-context.ts';

const verdict: CandidateVerdict = {
  ok: true,
  score: 100,
  reasons: ['tier:primary_source_candidate'],
  rejects: [],
  tier: 'primary_source_candidate',
  metadata: { exact_title_match: true },
};

const decisionContext: DecisionContext = {
  topic: '上海市公共场所控制吸烟条例',
  candidate: {
    finalUrl: 'https://www.shanghai.gov.cn/policy/detail.html',
    title: '上海市公共场所控制吸烟条例',
    contentPreview: '上海市公共场所控制吸烟条例 正文',
  },
  source: {
    tier: 'primary_source_candidate',
    semanticNote: 'Primary official source candidate.',
    isTrustedOfficialDomain: true,
    isOfficialPdf: false,
  },
  signals: {
    exactTitleMatch: true,
    derivativeLike: false,
    formatRisk: false,
    isAmbiguous: false,
  },
  verificationStrategy: ['Verify policy title, document number if present, and body relevance before final arbitration.'],
  modelInstructions: ['Treat as a high-authority source, but still verify title and content match the requested topic.'],
};

test('writeScanArtifacts writes verdict, decision context, and semantic report', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'policy-scanner-artifacts-'));

  const result = await writeScanArtifacts({
    cwd,
    runId: 'semantic-smoke',
    verdict,
    decisionContext,
  });

  assert.equal(result.reportPath, join(cwd, 'outputs', 'semantic-smoke', 'report.md'));
  assert.equal(result.verdictPath, join(cwd, 'outputs', 'semantic-smoke', 'verdict.json'));
  assert.equal(result.decisionContextPath, join(cwd, 'outputs', 'semantic-smoke', 'decision-context.json'));

  const report = await readFile(result.reportPath, 'utf8');
  const contextJson = JSON.parse(await readFile(result.decisionContextPath, 'utf8')) as DecisionContext;
  const verdictJson = JSON.parse(await readFile(result.verdictPath, 'utf8')) as CandidateVerdict;

  assert.match(report, /# Policy Scanner Semantic Report/);
  assert.equal(contextJson.source.tier, 'primary_source_candidate');
  assert.equal(verdictJson.ok, true);
});

test('writeScanArtifacts rejects output roots outside cwd', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'policy-scanner-artifacts-'));
  const outside = await mkdtemp(join(tmpdir(), 'policy-scanner-outside-'));

  await assert.rejects(
    writeScanArtifacts({
      cwd,
      outputRoot: outside,
      runId: 'bad-output',
      verdict,
      decisionContext,
    }),
    /outputRoot must stay inside the current working directory/,
  );
});
