import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildGenericReport, renderGenericReportMarkdown, writeGenericReport } from '../../src/artifacts/generic-report.ts';
import type { AgentResult } from '../../src/agent/types.ts';

test('generic report does not count uncited successful fetches as validated evidence', () => {
  const result: AgentResult = {
    status: 'completed',
    decision: { decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'answer', evidenceUrls: ['https://example.com/cited'] },
    state: {
      task: { question: 'q', options: { evidenceRequired: true, minFetchedPages: 1 } },
      currentIteration: 2,
      decisions: [],
      searchResults: [],
      fetchedPages: [
        { outcome: 'success_with_content', requestedUrl: 'https://example.com/cited', finalUrl: 'https://example.com/cited/', title: 'Cited', content: 'proof', provider: 'fake', extractionWarnings: [], durationMs: 1, retryCount: 0 },
        { outcome: 'success_with_content', requestedUrl: 'https://example.com/uncited', finalUrl: 'https://example.com/uncited', title: 'Uncited', content: 'other', provider: 'fake', extractionWarnings: [], durationMs: 1, retryCount: 0 },
      ],
      uncertainties: [],
      finalAnswer: 'answer',
    },
  };

  const report = buildGenericReport('run_test', 'completed', result, []);
  assert.equal(report.successfulFetchCount, 2);
  assert.equal(report.validatedEvidenceCount, 1);
  assert.deepEqual(report.validatedEvidenceUrls, ['https://example.com/cited/']);
  assert.deepEqual(report.sources.map((source) => source.url), ['https://example.com/cited/']);
  assert.equal(report.discoveredCandidates.length, 0);
});

test('generic report keeps uncited discovery out of final sources and reports evidence blocking', () => {
  const result: AgentResult = {
    status: 'interrupted',
    decision: { decision: 'review', searchActions: [], fetchActions: [], uncertainties: [] },
    state: {
      task: { question: 'q', options: { evidenceRequired: true, minFetchedPages: 1 } },
      currentIteration: 1,
      decisions: [],
      searchResults: [{ query: 'q', title: 'Candidate', url: 'https://example.com/candidate', snippet: 'not fetched', provider: 'fake-search' }],
      fetchedPages: [{ outcome: 'success_with_content', requestedUrl: 'https://example.com/uncited', finalUrl: 'https://example.com/uncited', title: 'Uncited', content: 'body', provider: 'fake-fetch', extractionWarnings: [], durationMs: 1, retryCount: 0 }],
      uncertainties: ['no cited evidence'],
      interrupted: { reason: 'max_iterations', message: 'done without evidence' },
    },
  };

  const report = buildGenericReport('run_blocked', 'interrupted', result, []);
  assert.equal(report.answerStatus, 'blocked_by_evidence');
  assert.equal(report.successfulFetchCount, 1);
  assert.equal(report.validatedEvidenceCount, 0);
  assert.deepEqual(report.sources, []);
  assert.deepEqual(report.discoveredCandidates.map((source) => source.url), ['https://example.com/candidate']);
});

function completedReport() {
  const result: AgentResult = {
    status: 'completed',
    decision: { decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'answer', evidenceUrls: [], findings: [] },
    state: {
      task: { question: 'q' }, currentIteration: 1, decisions: [], searchResults: [], fetchedPages: [], uncertainties: [], finalAnswer: 'answer',
    },
  };
  return buildGenericReport('run_atomic', 'completed', result, []);
}

test('generic report uses the exact Nano-researcher product name', async () => {
  const report = completedReport();
  assert.match(renderGenericReportMarkdown(report), /^# Nano-researcher Report/m);
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'generic-report-branding-'));
  try {
    const paths = await writeGenericReport(outputDir, report);
    assert.match(await fs.readFile(paths.htmlPath, 'utf8'), /<title>Nano-researcher Report<\/title>/);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test('generic report publishes the three files as one directory bundle', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'generic-report-bundle-'));
  try {
    const paths = await writeGenericReport(outputDir, completedReport());
    const bundleDir = path.join(outputDir, 'report');
    assert.deepEqual(paths, {
      jsonPath: path.join(bundleDir, 'report.json'),
      markdownPath: path.join(bundleDir, 'report.md'),
      htmlPath: path.join(bundleDir, 'report.html'),
    });
    assert.deepEqual((await fs.readdir(bundleDir)).sort(), ['report.html', 'report.json', 'report.md']);
    assert.deepEqual(await fs.readdir(outputDir), ['report']);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test('generic report writer leaves no visible partial bundle when rendering fails', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'generic-report-atomic-failure-'));
  const report = completedReport();
  report.discoveredCandidates.push({ title: 'broken', url: null as unknown as string, provider: 'fake', snippet: '' });
  try {
    await assert.rejects(writeGenericReport(outputDir, report));
    assert.deepEqual(await fs.readdir(outputDir), []);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
