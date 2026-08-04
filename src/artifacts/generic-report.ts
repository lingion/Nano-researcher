import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentResult } from '../agent/types.ts';
import type { RunEvent } from '../app/run-manager.ts';
import { matchedFetchedEvidenceUrls } from '../evidence/citations.ts';

export interface GenericReport {
  runId: string;
  status: string;
  question: string;
  completion: Record<string, unknown>;
  iterations: number;
  searchResultCount: number;
  uniqueSourceCount: number;
  fetchedPageCount: number;
  fetchAttemptCount: number;
  successfulFetchCount: number;
  emptyFetchCount: number;
  validatedEvidenceCount: number;
  validatedEvidenceUrls: string[];
  findingCount: number;
  confirmedFindingCount: number;
  uncertainFindingCount: number;
  excludedFindingCount: number;
  findings: NonNullable<AgentResult['decision']['findings']>;
  answerStatus: 'completed' | 'unavailable' | 'blocked_by_evidence' | 'interrupted' | 'failed';
  answerReason?: string;
  interruption?: AgentResult['state']['interrupted'];
  protocolErrorCount: number;
  modelErrorCount: number;
  searchOutcomes: Record<string, number>;
  fetchOutcomes: Record<string, number>;
  autoDiagnostics: Array<Record<string, unknown>>;
  uncertainties: string[];
  answer?: unknown;
  sources: Array<{ title: string; url: string; provider: string; snippet: string }>;
  discoveredCandidates: Array<{ title: string; url: string; provider: string; snippet: string }>;
  fetchedPages: Array<{ title: string; requestedUrl: string; finalUrl: string; provider: string; outcome: string; extractionWarnings: string[] }>;
  events: RunEvent[];
}

function uniqueSourceCount(result: AgentResult): number {
  return new Set(result.state.searchResults.map((item) => item.url.replace(/#.*$/, '').replace(/\/$/, ''))).size;
}

function countEventOutcomes(events: RunEvent[]): Record<string, number> {
  return events.reduce<Record<string, number>>((counts, event) => {
    const outcome = String(event.payload.outcome ?? 'unknown');
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    return counts;
  }, {});
}

export function buildGenericReport(runId: string, status: string, result: AgentResult, events: RunEvent[]): GenericReport {
  const protocolErrors = events.filter((event) => event.type === 'agent.protocol_error').length;
  const searchEvents = events.filter((event) => event.type === 'search.result');
  const fetchEvents = events.filter((event) => event.type === 'fetch.result');
  const successfulFetchCount = result.state.fetchedPages.filter((page) => page.outcome === 'success_with_content').length;
  const emptyFetchCount = result.state.fetchedPages.filter((page) => page.outcome === 'success_empty').length;
  const validatedEvidenceUrls = matchedFetchedEvidenceUrls(result.decision.evidenceUrls ?? [], result.state.fetchedPages);
  const findings = result.decision.findings ?? [];
  const confirmedFindingCount = findings.filter((finding) => finding.disposition === 'confirmed').length;
  const requiredEvidenceCount = result.state.task.options?.minFetchedPages ?? result.state.task.options?.targetResultCount ?? 1;
  const evidenceBlocked = result.state.task.options?.evidenceRequired === true && validatedEvidenceUrls.length < requiredEvidenceCount;
  const findingsBlocked = result.state.task.options?.completionMode === 'target_results' && confirmedFindingCount < (result.state.task.options.targetResultCount ?? 1);
  const hasAnswer = typeof result.state.finalAnswer === 'string' && result.state.finalAnswer.trim().length > 0;
  const answerStatus = evidenceBlocked || findingsBlocked
    ? 'blocked_by_evidence'
    : status === 'completed' && hasAnswer
      ? 'completed'
      : status === 'failed' ? 'failed' : status === 'interrupted' || status === 'cancelled' ? 'interrupted' : 'unavailable';
  const sources = validatedEvidenceUrls.map((url) => {
    const page = result.state.fetchedPages.find((candidate) => matchedFetchedEvidenceUrls([url], [candidate]).length > 0);
    return { title: page?.title ?? url, url, provider: page?.provider ?? 'fetched-evidence', snippet: page?.content.slice(0, 500) ?? '' };
  });
  return {
    runId, status, question: result.state.task.question,
    completion: { ...(result.state.task.options ?? {}) },
    iterations: result.state.currentIteration,
    searchResultCount: result.state.searchResults.length,
    uniqueSourceCount: uniqueSourceCount(result),
    fetchedPageCount: result.state.fetchedPages.length,
    fetchAttemptCount: result.state.fetchedPages.length,
    successfulFetchCount,
    emptyFetchCount,
    validatedEvidenceCount: validatedEvidenceUrls.length,
    validatedEvidenceUrls,
    findingCount: findings.length,
    confirmedFindingCount,
    uncertainFindingCount: findings.filter((finding) => finding.disposition === 'uncertain').length,
    excludedFindingCount: findings.filter((finding) => finding.disposition === 'excluded').length,
    findings,
    answerStatus,
    ...(answerStatus !== 'completed' ? { answerReason: result.state.interrupted?.message ?? result.state.uncertainties.at(-1) } : {}),
    interruption: result.state.interrupted,
    protocolErrorCount: protocolErrors,
    modelErrorCount: events.filter((event) => event.type === 'agent.model_error').length,
    searchOutcomes: countEventOutcomes(searchEvents),
    fetchOutcomes: countEventOutcomes(fetchEvents),
    autoDiagnostics: events.filter((event) => event.type === 'search.result' && event.payload.autoDiagnostics).map((event) => event.payload.autoDiagnostics as Record<string, unknown>),
    uncertainties: result.state.uncertainties,
    answer: result.state.finalAnswer,
    sources,
    discoveredCandidates: result.state.searchResults.map(({ title, url, provider, snippet }) => ({ title, url, provider, snippet })),
    fetchedPages: result.state.fetchedPages.map((page) => ({ title: page.title, requestedUrl: page.requestedUrl, finalUrl: page.finalUrl, provider: page.provider, outcome: page.outcome, extractionWarnings: page.extractionWarnings })),
    events,
  };
}

export function renderGenericReportMarkdown(report: GenericReport): string {
  const lines = [
    '# Research Report', '', `- Status: ${report.status}`, `- Run ID: ${report.runId}`, `- Question: ${report.question}`,
    `- Iterations: ${report.iterations}`, `- Search results: ${report.searchResultCount}`, `- Unique discovered sources: ${report.uniqueSourceCount}`, `- Fetch attempts: ${report.fetchAttemptCount}`, `- Successful fetches: ${report.successfulFetchCount}`, `- Validated evidence: ${report.validatedEvidenceCount}`, `- Findings: ${report.findingCount} total (${report.confirmedFindingCount} confirmed, ${report.uncertainFindingCount} uncertain, ${report.excludedFindingCount} excluded)`, `- Answer status: ${report.answerStatus}`, `- Protocol errors: ${report.protocolErrorCount}`, `- Model errors: ${report.modelErrorCount}`, `- Interruption: ${report.interruption?.reason ?? 'none'}`, '',
    '## Answer', '', typeof report.answer === 'string' ? report.answer : `No final answer. ${report.answerReason ?? 'The run did not produce a finish decision.'}`, '',
    '## Final Evidence Sources', ''
  ];
  report.sources.forEach((source, index) => lines.push(`${index + 1}. [${source.title || source.url}](${source.url}) — ${source.provider}`));
  lines.push('', '## Findings', '');
  report.findings.forEach((finding, index) => lines.push(`${index + 1}. [${finding.disposition}] ${finding.claim}\n   Evidence: ${finding.evidenceUrls.join(', ') || 'none'}`));
  lines.push('', '## Discovered Candidates', '');
  report.discoveredCandidates.forEach((source, index) => lines.push(`${index + 1}. [${source.title || source.url}](${source.url}) — ${source.provider}`));
  if (report.uncertainties.length) lines.push('', '## Uncertainties', '', ...report.uncertainties.map((item) => `- ${item}`));
  lines.push('', '## Diagnostics', '', `- Search outcomes: ${JSON.stringify(report.searchOutcomes)}`, `- Fetch outcomes: ${JSON.stringify(report.fetchOutcomes)}`);
  return `${lines.join('\n')}\n`;
}

export async function writeGenericReport(outputDir: string, report: GenericReport): Promise<{ jsonPath: string; markdownPath: string; htmlPath: string }> {
  const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character));
  const sourceHtml = report.sources.map((source) => `<li><a href="${escape(source.url)}">${escape(source.title || source.url)}</a> <small>${escape(source.provider)}</small></li>`).join('');
  const findingHtml = report.findings.map((finding) => `<li><strong>${escape(finding.disposition)}</strong> ${escape(finding.claim)}<br><small>${escape(finding.evidenceUrls.join(', ') || 'no evidence')}</small></li>`).join('');
  const discoveredHtml = report.discoveredCandidates.map((source) => `<li><a href="${escape(source.url)}">${escape(source.title || source.url)}</a> <small>${escape(source.provider)}</small></li>`).join('');
  const renderedAnswer = typeof report.answer === 'string' ? report.answer : `No final answer. ${report.answerReason ?? 'The run did not produce a finish decision.'}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Research Report</title></head><body><main><h1>Research Report</h1><p>${escape(report.question)}</p><p>Status: ${escape(report.status)}; discovered sources: ${report.uniqueSourceCount}; fetched pages: ${report.fetchedPageCount}; validated evidence: ${report.validatedEvidenceCount}; findings: ${report.findingCount} total (${report.confirmedFindingCount} confirmed, ${report.uncertainFindingCount} uncertain, ${report.excludedFindingCount} excluded)</p><h2>Answer</h2><pre>${escape(renderedAnswer)}</pre><h2>Final Evidence Sources</h2><ol>${sourceHtml}</ol><h2>Findings</h2><ol>${findingHtml}</ol><h2>Discovered Candidates</h2><ol>${discoveredHtml}</ol></main></body></html>`;
  const bundleDir = path.join(outputDir, 'report');
  const stagingDir = path.join(outputDir, `.report-${randomUUID()}.tmp`);
  const jsonPath = path.join(bundleDir, 'report.json');
  const markdownPath = path.join(bundleDir, 'report.md');
  const htmlPath = path.join(bundleDir, 'report.html');
  await fs.mkdir(outputDir, { recursive: true });
  try {
    await fs.mkdir(stagingDir);
    await Promise.all([
      fs.writeFile(path.join(stagingDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
      fs.writeFile(path.join(stagingDir, 'report.md'), renderGenericReportMarkdown(report), 'utf8'),
      fs.writeFile(path.join(stagingDir, 'report.html'), html, 'utf8'),
    ]);
    await fs.rename(stagingDir, bundleDir);
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
  return { jsonPath, markdownPath, htmlPath };
}
