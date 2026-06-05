#!/usr/bin/env node

import { relative, resolve } from 'node:path';

import { JudgmentEngine } from '../src/engine/judgment-engine.ts';
import { loadScannerConfig } from '../src/policy-scanner/load-config.ts';
import { writeScanArtifacts } from '../src/policy-scanner/reporter/write-scan-artifacts.ts';

const helpText = `policy-scanner

Usage:
  policy-scanner --topic <text> --url <url> [options]
  policy-scanner --help
  policy-scanner --version

Options:
  --rules <path>     Path to rules.json. Defaults to config/rules.json.
  --domains <path>   Path to domains.json. Defaults to config/domains.json.
  --topic <text>     Policy title or topic to judge against fetched evidence.
  --url <url>        Final URL of a candidate policy page.
  --title <text>     Candidate page title. Defaults to topic.
  --content <text>   Candidate page content or extracted text. Defaults to empty.
  --output <path>    Output root under current working directory. Defaults to ./outputs.
  --run-id <text>    Stable run directory name. Defaults to current timestamp.

Outputs:
  report.md
  decision-context.json
  verdict.json

Notes:
  The scanner keeps search/fetch as evidence collection only.
  JudgmentEngine emits semantic DecisionContext for model or human arbitration.
`;

interface CliOptions {
  rulesPath: string;
  domainsPath: string;
  topic?: string;
  url?: string;
  title?: string;
  content?: string;
  outputRoot?: string;
  runId: string;
}

function timestampRunId(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '').replace('T', '_').replace(/:/g, '');
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseArgs(args: string[], cwd: string): CliOptions | 'help' | 'version' {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) return 'help';
  if (args.includes('--version') || args.includes('-v')) return 'version';

  const options: CliOptions = {
    rulesPath: resolve(cwd, 'config/rules.json'),
    domainsPath: resolve(cwd, 'config/domains.json'),
    runId: timestampRunId(),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--rules':
        options.rulesPath = resolve(cwd, takeValue(args, index, arg));
        index += 1;
        break;
      case '--domains':
        options.domainsPath = resolve(cwd, takeValue(args, index, arg));
        index += 1;
        break;
      case '--topic':
        options.topic = takeValue(args, index, arg);
        index += 1;
        break;
      case '--url':
        options.url = takeValue(args, index, arg);
        index += 1;
        break;
      case '--title':
        options.title = takeValue(args, index, arg);
        index += 1;
        break;
      case '--content':
        options.content = takeValue(args, index, arg);
        index += 1;
        break;
      case '--output':
        options.outputRoot = resolve(cwd, takeValue(args, index, arg));
        index += 1;
        break;
      case '--run-id':
        options.runId = takeValue(args, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.topic) throw new Error('--topic is required.');
  if (!options.url) throw new Error('--url is required.');

  return options;
}

function toFileUrl(filePath: string): URL {
  return new URL(`file://${filePath}`);
}

function displayPath(cwd: string, filePath: string): string {
  return `./${relative(cwd, filePath)}`;
}

export async function main(args = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const parsed = parseArgs(args, cwd);

  if (parsed === 'help') {
    process.stdout.write(helpText);
    return;
  }

  if (parsed === 'version') {
    process.stdout.write('0.1.0\n');
    return;
  }

  const config = await loadScannerConfig({
    rulesPath: toFileUrl(parsed.rulesPath),
    domainsPath: toFileUrl(parsed.domainsPath),
  });
  const topic = parsed.topic;
  const url = parsed.url;
  if (!topic) throw new Error('--topic is required.');
  if (!url) throw new Error('--url is required.');

  const engine = new JudgmentEngine(config);
  const input = {
    topic,
    candidate: {
      finalUrl: url,
      title: parsed.title ?? topic,
      content: parsed.content ?? '',
      kerry_cleaning: { metadata: {} },
    },
  };
  const decisionContext = engine.prepareContext(input);
  const verdict = engine.run(input);
  const artifacts = await writeScanArtifacts({
    cwd,
    outputRoot: parsed.outputRoot,
    runId: parsed.runId,
    verdict,
    decisionContext,
  });

  process.stdout.write(`Report generated at: ${displayPath(cwd, artifacts.reportPath)}\n`);
  process.stdout.write(`Decision context written at: ${displayPath(cwd, artifacts.decisionContextPath)}\n`);
  process.stdout.write(`Verdict written at: ${displayPath(cwd, artifacts.verdictPath)}\n`);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
