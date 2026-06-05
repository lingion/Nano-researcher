import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { DecisionContext } from '../../engine/decision-context.ts';
import type { CandidateVerdict } from '../../engine/types.ts';
import { renderReportMarkdown } from './render-report-markdown.ts';

export interface WriteScanArtifactsInput {
  cwd: string;
  outputRoot?: string;
  runId: string;
  verdict: CandidateVerdict;
  decisionContext: DecisionContext;
}

export interface WriteScanArtifactsResult {
  runDir: string;
  verdictPath: string;
  decisionContextPath: string;
  reportPath: string;
}

function assertInsideCwd(cwd: string, target: string, label: string): void {
  const resolvedCwd = resolve(cwd);
  const resolvedTarget = resolve(target);
  const pathFromCwd = relative(resolvedCwd, resolvedTarget);

  if (pathFromCwd.startsWith('..') || isAbsolute(pathFromCwd)) {
    throw new Error(`${label} must stay inside the current working directory.`);
  }
}

export async function writeScanArtifacts(input: WriteScanArtifactsInput): Promise<WriteScanArtifactsResult> {
  const outputRoot = input.outputRoot ? resolve(input.outputRoot) : join(resolve(input.cwd), 'outputs');
  assertInsideCwd(input.cwd, outputRoot, 'outputRoot');

  const runDir = join(outputRoot, input.runId);
  assertInsideCwd(input.cwd, runDir, 'runDir');
  await mkdir(runDir, { recursive: true });

  const verdictPath = join(runDir, 'verdict.json');
  const decisionContextPath = join(runDir, 'decision-context.json');
  const reportPath = join(runDir, 'report.md');

  await writeFile(verdictPath, `${JSON.stringify(input.verdict, null, 2)}\n`, 'utf8');
  await writeFile(decisionContextPath, `${JSON.stringify(input.decisionContext, null, 2)}\n`, 'utf8');
  await writeFile(reportPath, renderReportMarkdown(input.decisionContext), 'utf8');

  return { runDir, verdictPath, decisionContextPath, reportPath };
}
