import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('package start defaults to generic agent and preserves explicit legacy command', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
  assert.equal(packageJson.scripts.start, 'pnpm generic-agent');
  assert.equal(packageJson.scripts['legacy-audit'], 'tsx src/app/run-live-audit.ts');
});
