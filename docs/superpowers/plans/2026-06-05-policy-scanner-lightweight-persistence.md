# Policy Scanner Lightweight Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lightweight result persistence to `policy-scanner` so each CLI run writes `verdict.json` and `report.md` under `./outputs/<timestamp>/` and prints the report path.

**Architecture:** Keep the CLI isolated from the legacy Agent Runtime. `bin/policy-scanner.ts` parses CLI args, loads scanner config, constructs a single fetched-page candidate from `--topic`, `--url`, optional `--title`, and optional `--content`, calls `judgeCandidate`, then delegates all file writes to a small `ArtifactManager` in `src/policy-scanner/artifacts.ts`. The artifact manager only writes inside `process.cwd()/outputs` unless an explicit output root inside `process.cwd()` is provided.

**Tech Stack:** TypeScript ESM, Node built-in `node:test`, `node:assert/strict`, `node:fs/promises`, `node:path`, existing `loadScannerConfig` and `judgeCandidate` policy-scanner modules, `pnpm` scripts.

---

## File Structure

- Create: `src/policy-scanner/artifacts.ts`
  - Owns run directory creation, safe path enforcement, `verdict.json`, `report.md`, and path return values.
- Modify: `bin/policy-scanner.ts`
  - Parse CLI options, call `loadScannerConfig`, call `judgeCandidate`, call `writePolicyScannerArtifacts`, print final paths, preserve `--help` and `--version` behavior.
- Modify: `__tests__/policy-scanner-cli.test.ts`
  - Extend CLI tests for artifact writing, report path echo, `--verbose`, and unknown argument behavior.
- Create: `__tests__/policy-scanner/artifacts.test.ts`
  - Unit-test artifact manager path safety and file contents.
- Modify: `README.md`
  - Document install, CLI usage, output locations, environment expectations, and troubleshooting.
- Modify: `package.json`
  - Keep existing `policy-scanner` script. No new runtime dependencies.

---

### Task 1: ArtifactManager unit tests

**Files:**
- Create: `__tests__/policy-scanner/artifacts.test.ts`
- Create later in Task 2: `src/policy-scanner/artifacts.ts`

- [ ] **Step 1: Write the failing artifact manager test**

Create `__tests__/policy-scanner/artifacts.test.ts` with this full content:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writePolicyScannerArtifacts } from '../../src/policy-scanner/artifacts.ts';

test('writePolicyScannerArtifacts writes verdict.json and report.md under outputs run directory', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'policy-scanner-artifacts-'));

  const result = await writePolicyScannerArtifacts({
    cwd,
    runId: '2026-06-05_010203',
    topic: '上海市公共场所控制吸烟条例',
    url: 'https://www.shanghai.gov.cn/example.pdf',
    verdict: {
      ok: true,
      tier: 'primary_source_candidate',
      reasons: ['official_pdf_detected_and_elevated', 'tier:primary_source_candidate'],
      rejects: [],
      exactTitle: true,
      derivative: false,
      isOfficialPdf: true,
    },
  });

  assert.equal(result.runDir, join(cwd, 'outputs', '2026-06-05_010203'));
  assert.equal(result.verdictPath, join(cwd, 'outputs', '2026-06-05_010203', 'verdict.json'));
  assert.equal(result.reportPath, join(cwd, 'outputs', '2026-06-05_010203', 'report.md'));

  const verdict = JSON.parse(await readFile(result.verdictPath, 'utf8')) as {
    topic: string;
    url: string;
    verdict: { ok: boolean; isOfficialPdf: boolean };
  };
  assert.equal(verdict.topic, '上海市公共场所控制吸烟条例');
  assert.equal(verdict.url, 'https://www.shanghai.gov.cn/example.pdf');
  assert.equal(verdict.verdict.ok, true);
  assert.equal(verdict.verdict.isOfficialPdf, true);

  const report = await readFile(result.reportPath, 'utf8');
  assert.match(report, /^# Policy Scanner Report/m);
  assert.match(report, /上海市公共场所控制吸烟条例/);
  assert.match(report, /https:\/\/www\.shanghai\.gov\.cn\/example\.pdf/);
  assert.match(report, /PASS/);
  assert.match(report, /official_pdf_detected_and_elevated/);
});

test('writePolicyScannerArtifacts rejects output roots outside cwd', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'policy-scanner-artifacts-'));
  const outside = await mkdtemp(join(tmpdir(), 'policy-scanner-outside-'));

  await assert.rejects(
    writePolicyScannerArtifacts({
      cwd,
      outputRoot: outside,
      runId: '2026-06-05_010203',
      topic: 'topic',
      url: 'https://example.gov.cn/policy',
      verdict: {
        ok: false,
        tier: 'unknown',
        reasons: ['tier:unknown'],
        rejects: ['not_primary_source_candidate'],
        exactTitle: false,
        derivative: false,
        isOfficialPdf: false,
      },
    }),
    /outputRoot must stay inside the current working directory/,
  );
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
cd /Users/lingion/repo-downloads/local-policy-agent
pnpm test __tests__/policy-scanner/artifacts.test.ts
```

Expected: FAIL with an import error similar to:

```text
Cannot find module '../../src/policy-scanner/artifacts.ts'
```

- [ ] **Step 3: Commit the failing test only**

```bash
git add __tests__/policy-scanner/artifacts.test.ts
git commit -m "test: define policy scanner artifact persistence"
```

---

### Task 2: ArtifactManager implementation

**Files:**
- Create: `src/policy-scanner/artifacts.ts`
- Test: `__tests__/policy-scanner/artifacts.test.ts`

- [ ] **Step 1: Implement the minimal artifact manager**

Create `src/policy-scanner/artifacts.ts` with this full content:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { CandidateVerdict } from './types.ts';

export interface PolicyScannerArtifactInput {
  cwd: string;
  outputRoot?: string;
  runId: string;
  topic: string;
  url: string;
  verdict: CandidateVerdict;
}

export interface PolicyScannerArtifactResult {
  runDir: string;
  verdictPath: string;
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

function renderReport(input: PolicyScannerArtifactInput): string {
  const status = input.verdict.ok ? 'PASS' : 'REVIEW_REQUIRED';
  const reasons = input.verdict.reasons.length
    ? input.verdict.reasons.map((reason) => `- ${reason}`).join('\n')
    : '- none';
  const rejects = input.verdict.rejects.length
    ? input.verdict.rejects.map((reason) => `- ${reason}`).join('\n')
    : '- none';

  return `# Policy Scanner Report

## Summary

- Topic: ${input.topic}
- URL: ${input.url}
- Status: ${status}
- Tier: ${input.verdict.tier}

## Signals

- Exact title match: ${input.verdict.exactTitle ? 'yes' : 'no'}
- Derivative/explanatory page: ${input.verdict.derivative ? 'yes' : 'no'}
- Official PDF elevated: ${input.verdict.isOfficialPdf ? 'yes' : 'no'}

## Reasons

${reasons}

## Rejects

${rejects}
`;
}

export async function writePolicyScannerArtifacts(
  input: PolicyScannerArtifactInput,
): Promise<PolicyScannerArtifactResult> {
  const outputRoot = input.outputRoot
    ? resolve(input.outputRoot)
    : join(resolve(input.cwd), 'outputs');
  assertInsideCwd(input.cwd, outputRoot, 'outputRoot');

  const runDir = join(outputRoot, input.runId);
  assertInsideCwd(input.cwd, runDir, 'runDir');

  await mkdir(runDir, { recursive: true });

  const verdictPath = join(runDir, 'verdict.json');
  const reportPath = join(runDir, 'report.md');

  await writeFile(
    verdictPath,
    `${JSON.stringify({
      topic: input.topic,
      url: input.url,
      verdict: input.verdict,
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(reportPath, renderReport(input), 'utf8');

  return { runDir, verdictPath, reportPath };
}
```

- [ ] **Step 2: Run the artifact tests to verify GREEN**

Run:

```bash
cd /Users/lingion/repo-downloads/local-policy-agent
pnpm test __tests__/policy-scanner/artifacts.test.ts
```

Expected:

```text
# pass 2
# fail 0
```

- [ ] **Step 3: Run build to verify the new file is inside the production scope**

Run:

```bash
cd /Users/lingion/repo-downloads/local-policy-agent
pnpm build
```

Expected: exit code 0.

If build fails because `src/policy-scanner/artifacts.ts` is not included, update `tsconfig.json` include to keep `src/policy-scanner/**/*.ts` present. Do not add legacy runtime folders to the build include.

- [ ] **Step 4: Commit the implementation**

```bash
git add src/policy-scanner/artifacts.ts
git commit -m "feat: persist policy scanner artifacts"
```

---

### Task 3: CLI persistence behavior

**Files:**
- Modify: `__tests__/policy-scanner-cli.test.ts`
- Modify: `bin/policy-scanner.ts`

- [ ] **Step 1: Replace the CLI test file with persistence coverage**

Replace `__tests__/policy-scanner-cli.test.ts` with this full content:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const projectRoot = new URL('..', import.meta.url);

function runPolicyScanner(args: string[], cwd?: string) {
  return spawnSync('pnpm', ['exec', 'tsx', new URL('../bin/policy-scanner.ts', import.meta.url).pathname, ...args], {
    cwd: cwd ?? projectRoot,
    encoding: 'utf8',
  });
}

test('policy-scanner --help presents the CLI face', () => {
  const result = runPolicyScanner(['--help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /policy-scanner/);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--rules/);
  assert.match(result.stdout, /--verbose/);
});

test('policy-scanner writes verdict.json and report.md and echoes the report path', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'policy-scanner-cli-'));
  const result = runPolicyScanner([
    '--topic', '上海市公共场所控制吸烟条例',
    '--url', 'https://www.shanghai.gov.cn/example.pdf',
    '--title', '上海市公共场所控制吸烟条例',
    '--content', '%PDF-1.7 binary',
    '--rules', new URL('../config/rules.json', import.meta.url).pathname,
    '--domains', new URL('../config/domains.json', import.meta.url).pathname,
    '--run-id', '2026-06-05_010203',
  ], cwd);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Report generated at: \.\/outputs\/2026-06-05_010203\/report\.md/);
  assert.match(result.stdout, /Verdict written at: \.\/outputs\/2026-06-05_010203\/verdict\.json/);

  const verdictPath = join(cwd, 'outputs', '2026-06-05_010203', 'verdict.json');
  const reportPath = join(cwd, 'outputs', '2026-06-05_010203', 'report.md');
  const verdict = JSON.parse(await readFile(verdictPath, 'utf8')) as {
    verdict: { ok: boolean; isOfficialPdf: boolean };
  };
  const report = await readFile(reportPath, 'utf8');

  assert.equal(verdict.verdict.ok, true);
  assert.equal(verdict.verdict.isOfficialPdf, true);
  assert.match(report, /Status: PASS/);
});

test('policy-scanner --verbose prints resolved config and output paths', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'policy-scanner-cli-'));
  const result = runPolicyScanner([
    '--topic', 'topic',
    '--url', 'https://example.gov.cn/policy',
    '--rules', new URL('../config/rules.json', import.meta.url).pathname,
    '--domains', new URL('../config/domains.json', import.meta.url).pathname,
    '--run-id', '2026-06-05_010204',
    '--verbose',
  ], cwd);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Using rules:/);
  assert.match(result.stderr, /Using domains:/);
  assert.match(result.stderr, /Writing outputs under:/);
});
```

- [ ] **Step 2: Run the CLI tests to verify RED**

Run:

```bash
cd /Users/lingion/repo-downloads/local-policy-agent
pnpm test __tests__/policy-scanner-cli.test.ts
```

Expected: FAIL because current CLI does not parse `--topic`, `--url`, `--title`, `--content`, `--run-id`, `--verbose`, and does not write files.

- [ ] **Step 3: Replace the CLI implementation**

Replace `bin/policy-scanner.ts` with this full content:

```ts
#!/usr/bin/env node

import { relative, resolve } from 'node:path';

import { writePolicyScannerArtifacts } from '../src/policy-scanner/artifacts.ts';
import { loadScannerConfig } from '../src/policy-scanner/load-config.ts';
import { judgeCandidate } from '../src/policy-scanner/engine/judge-candidate.ts';

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
  --verbose          Print resolved config and output paths to stderr.

Notes:
  The scanner keeps search/fetch as evidence collection only.
  Business judgment stays in the policy agent prompt and candidate verdict layer.
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
  verbose: boolean;
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
    verbose: false,
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
      case '--verbose':
        options.verbose = true;
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

  if (parsed.verbose) {
    process.stderr.write(`Using rules: ${parsed.rulesPath}\n`);
    process.stderr.write(`Using domains: ${parsed.domainsPath}\n`);
    process.stderr.write(`Writing outputs under: ${parsed.outputRoot ?? resolve(cwd, 'outputs')}\n`);
  }

  const config = await loadScannerConfig({
    rulesPath: toFileUrl(parsed.rulesPath),
    domainsPath: toFileUrl(parsed.domainsPath),
  });
  const verdict = judgeCandidate({
    taskTopic: parsed.topic,
    page: {
      finalUrl: parsed.url,
      title: parsed.title ?? parsed.topic,
      content: parsed.content ?? '',
      kerry_cleaning: { metadata: {} },
    },
    config,
  });
  const artifacts = await writePolicyScannerArtifacts({
    cwd,
    outputRoot: parsed.outputRoot,
    runId: parsed.runId,
    topic: parsed.topic,
    url: parsed.url,
    verdict,
  });

  process.stdout.write(`Report generated at: ${displayPath(cwd, artifacts.reportPath)}\n`);
  process.stdout.write(`Verdict written at: ${displayPath(cwd, artifacts.verdictPath)}\n`);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Run the CLI tests to verify GREEN**

Run:

```bash
cd /Users/lingion/repo-downloads/local-policy-agent
pnpm test __tests__/policy-scanner-cli.test.ts
```

Expected:

```text
# pass 3
# fail 0
```

- [ ] **Step 5: Run focused scanner tests**

Run:

```bash
cd /Users/lingion/repo-downloads/local-policy-agent
pnpm test __tests__/policy-scanner/load-config.test.ts __tests__/policy-scanner/judge-candidate.test.ts __tests__/policy-scanner/artifacts.test.ts __tests__/policy-scanner-cli.test.ts
```

Expected: all scanner-related tests pass.

- [ ] **Step 6: Commit the CLI persistence behavior**

```bash
git add bin/policy-scanner.ts __tests__/policy-scanner-cli.test.ts
git commit -m "feat: write policy scanner CLI results"
```

---

### Task 4: README delivery documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace README with delivery-focused instructions**

Replace `README.md` with this full content:

```md
# local-policy-agent

Standalone local policy scanner and policy-agent runtime experiments.

The deliverable CLI surface is `policy-scanner`. It keeps the current production build focused on the scanner layer and does not pull the legacy Agent Runtime into the build path.

## Requirements

- Node.js 22 or newer
- pnpm

No environment variables are required for the lightweight `policy-scanner` CLI path.

## Install

```bash
pnpm install
```

## Run the scanner

```bash
pnpm policy-scanner --topic "上海市公共场所控制吸烟条例" \
  --url "https://www.shanghai.gov.cn/example.pdf" \
  --title "上海市公共场所控制吸烟条例" \
  --content "%PDF-1.7 binary"
```

The command writes a timestamped output directory under `./outputs/` and prints the exact files:

```text
Report generated at: ./outputs/<timestamp>/report.md
Verdict written at: ./outputs/<timestamp>/verdict.json
```

## CLI options

```bash
pnpm policy-scanner --help
```

Important options:

- `--topic <text>`: policy title or topic to judge against fetched evidence.
- `--url <url>`: final URL of a candidate policy page.
- `--title <text>`: candidate page title. Defaults to `--topic`.
- `--content <text>`: candidate page content or extracted text. Defaults to empty.
- `--rules <path>`: rules config. Defaults to `config/rules.json`.
- `--domains <path>`: domain config. Defaults to `config/domains.json`.
- `--output <path>`: output root under the current working directory. Defaults to `./outputs`.
- `--run-id <text>`: stable output directory name, useful for tests or reproducible demos.
- `--verbose`: print resolved config and output paths to stderr.

## Config files

The default config files are:

- `config/rules.json`
- `config/domains.json`

If `rules.json` is missing or contains invalid JSON, the scanner prints a warning and falls back to safe default rules. `domains.json` is required because domain tiers are deployment-specific.

## Outputs

Each run writes:

- `outputs/<timestamp>/verdict.json`: machine-readable scanner verdict.
- `outputs/<timestamp>/report.md`: human-readable markdown report.

All CLI output writes stay inside the current working directory. Passing `--output` to a path outside the current working directory is rejected.

## Troubleshooting

Use verbose mode to see resolved paths:

```bash
pnpm policy-scanner --topic "topic" --url "https://example.gov.cn/policy" --verbose
```

Common issues:

- `--topic is required.`: pass `--topic "政策名称"`.
- `--url is required.`: pass the candidate official URL.
- `domains.json` read errors: pass `--domains /absolute/path/to/domains.json` or run from the project root.
- Output path rejection: choose an `--output` path under the current working directory.

## Development

```bash
pnpm test
pnpm build
```

The build intentionally scopes to the scanner deliverable and excludes legacy runtime experiments.
```

- [ ] **Step 2: Run README-relevant CLI smoke command**

Run:

```bash
cd /Users/lingion/repo-downloads/local-policy-agent
pnpm policy-scanner --topic "上海市公共场所控制吸烟条例" \
  --url "https://www.shanghai.gov.cn/example.pdf" \
  --title "上海市公共场所控制吸烟条例" \
  --content "%PDF-1.7 binary" \
  --run-id "readme-smoke"
```

Expected output includes:

```text
Report generated at: ./outputs/readme-smoke/report.md
Verdict written at: ./outputs/readme-smoke/verdict.json
```

- [ ] **Step 3: Commit README update**

```bash
git add README.md
git commit -m "docs: document policy scanner delivery path"
```

---

### Task 5: Final verification and package-ready check

**Files:**
- Verify: `package.json`
- Verify: `pnpm-lock.yaml`
- Verify: `outputs/readme-smoke/report.md`
- Verify: `outputs/readme-smoke/verdict.json`

- [ ] **Step 1: Run full source test suite**

Run:

```bash
cd /Users/lingion/repo-downloads/local-policy-agent
pnpm test
```

Expected:

```text
# fail 0
```

- [ ] **Step 2: Run production build**

Run:

```bash
cd /Users/lingion/repo-downloads/local-policy-agent
pnpm build
```

Expected: exit code 0.

- [ ] **Step 3: Print final help output**

Run:

```bash
cd /Users/lingion/repo-downloads/local-policy-agent
pnpm policy-scanner --help
```

Expected: help includes `--output`, `--run-id`, and `--verbose`.

- [ ] **Step 4: Verify package delivery constraints**

Run:

```bash
cd /Users/lingion/repo-downloads/local-policy-agent
test -f pnpm-lock.yaml
node -e "const p=require('./package.json'); for (const section of ['dependencies','devDependencies']) for (const [name, version] of Object.entries(p[section]||{})) if (!/^[~^]\\d+\\.\\d+\\.\\d+/.test(version)) throw new Error(section+'.'+name+'='+version); console.log('dependency ranges ok')"
```

Expected:

```text
dependency ranges ok
```

- [ ] **Step 5: Inspect generated report face**

Run:

```bash
cd /Users/lingion/repo-downloads/local-policy-agent
pnpm policy-scanner --topic "上海市公共场所控制吸烟条例" \
  --url "https://www.shanghai.gov.cn/example.pdf" \
  --title "上海市公共场所控制吸烟条例" \
  --content "%PDF-1.7 binary" \
  --run-id "final-smoke"
sed -n '1,80p' outputs/final-smoke/report.md
```

Expected report begins with:

```text
# Policy Scanner Report

## Summary

- Topic: 上海市公共场所控制吸烟条例
- URL: https://www.shanghai.gov.cn/example.pdf
- Status: PASS
```

- [ ] **Step 6: Commit final verification metadata only if files changed**

Do not commit generated `outputs/` unless the project intentionally tracks demo artifacts. If `outputs/` is untracked, leave it uncommitted or add it to `.gitignore` in a separate docs/housekeeping commit.

---

## Self-Review

- Spec coverage: The plan covers lightweight CLI persistence, result path echo, path safety, verbose diagnostics, README delivery instructions, and package constraints. It intentionally avoids Agent Runtime integration.
- Placeholder scan: No TBD/TODO/fill-in placeholders remain. Each code-changing step includes complete code.
- Type consistency: `CandidateVerdict`, `writePolicyScannerArtifacts`, `PolicyScannerArtifactInput`, and CLI option names are consistent across tests and implementation.
- Scope check: This is a single bounded feature. It does not require decomposing into multiple subsystem plans.
