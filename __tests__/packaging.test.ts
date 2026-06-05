import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const projectRoot = new URL('..', import.meta.url);

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, projectRoot), 'utf8')) as T;
}

test('package includes zero-config portability metadata', () => {
  assert.match(readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim(), /^v22\.21\.0$/);
  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');

  assert.match(envExample, /NANOCLAW_LLM_PROVIDER=openai/);
  assert.match(envExample, /NANOCLAW_BASE_URL=/);
  assert.match(envExample, /NANOCLAW_API_KEY=/);
});

test('package exposes offline fixture regression and portable start scripts', () => {
  const packageJson = readJson<{ scripts?: Record<string, string> }>('package.json');

  assert.equal(packageJson.scripts?.['test:fixture'], 'tsx --test __tests__/fixtures/golden-live-audit.test.ts');
  assert.equal(packageJson.scripts?.start, 'pnpm live-audit');
});

test('git-tracked source includes workspace modules required by live audit', () => {
  const trackedFiles = execFileSync('git', ['ls-files', 'src/workspace/*.ts'], {
    cwd: projectRoot,
    encoding: 'utf8',
  }).trim().split('\n').filter(Boolean);

  assert.deepEqual(
    trackedFiles.sort(),
    [
      'src/workspace/atomic-json.ts',
      'src/workspace/evidence-identity.ts',
      'src/workspace/evidence-manager.ts',
      'src/workspace/evidence-store.ts',
      'src/workspace/evidence-workspace-paths.ts',
      'src/workspace/index.ts',
      'src/workspace/persistent-fetch-tool.ts',
      'src/workspace/report-manager.ts',
    ],
  );
});

test('package dependencies use explicit semver ranges', () => {
  const packageJson = readJson<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>('package.json');

  for (const [sectionName, dependencies] of Object.entries({
    dependencies: packageJson.dependencies ?? {},
    devDependencies: packageJson.devDependencies ?? {},
  })) {
    for (const [name, version] of Object.entries(dependencies)) {
      assert.match(
        version,
        /^[~^]\d+\.\d+\.\d+/,
        `${sectionName}.${name} should use a ^ or ~ semver range`,
      );
    }
  }
});
