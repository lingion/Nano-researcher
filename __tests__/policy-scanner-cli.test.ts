import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const projectRoot = new URL('..', import.meta.url);

function runPolicyScanner(args: string[], cwd?: string) {
  const tsxCli = new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url).pathname;
  return spawnSync(process.execPath, [tsxCli, new URL('../bin/policy-scanner.ts', import.meta.url).pathname, ...args], {
    cwd: cwd ?? projectRoot,
    encoding: 'utf8',
  });
}

test('policy-scanner --help presents semantic artifact outputs', () => {
  const result = runPolicyScanner(['--help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /policy-scanner/);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--rules/);
  assert.match(result.stdout, /decision-context\.json/);
});

test('policy-scanner writes semantic report, decision context, and verdict files', async () => {
  const cwd = new URL('..', import.meta.url).pathname;
  const outputRoot = await mkdtemp(join(cwd, '.tmp-policy-scanner-cli-'));
  const result = runPolicyScanner([
    '--topic', '上海市公共场所控制吸烟条例',
    '--url', 'https://www.shanghai.gov.cn/policy/detail.html',
    '--title', '上海市公共场所控制吸烟条例 解读',
    '--content', '一图读懂 上海市公共场所控制吸烟条例',
    '--rules', new URL('../config/rules.json', import.meta.url).pathname,
    '--domains', new URL('../config/domains.json', import.meta.url).pathname,
    '--run-id', 'semantic-cli',
    '--output', outputRoot,
  ], cwd);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Report generated at: \.\/\.tmp-policy-scanner-cli-[^/]+\/semantic-cli\/report\.md/);
  assert.match(result.stdout, /Decision context written at: \.\/\.tmp-policy-scanner-cli-[^/]+\/semantic-cli\/decision-context\.json/);
  assert.match(result.stdout, /Verdict written at: \.\/\.tmp-policy-scanner-cli-[^/]+\/semantic-cli\/verdict\.json/);

  const report = await readFile(join(outputRoot, 'semantic-cli', 'report.md'), 'utf8');
  const decisionContext = JSON.parse(await readFile(join(outputRoot, 'semantic-cli', 'decision-context.json'), 'utf8')) as {
    source: { tier: string };
    signals: { derivativeLike: boolean; isAmbiguous: boolean };
  };

  assert.match(report, /# Policy Scanner Semantic Report/);
  assert.match(report, /## Signal Table/);
  assert.equal(decisionContext.source.tier, 'primary_source_candidate');
  assert.equal(decisionContext.signals.derivativeLike, true);
  assert.equal(decisionContext.signals.isAmbiguous, true);
});
