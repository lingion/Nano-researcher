import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { writeResultAudit } from '../../src/artifacts/write-result-audit.ts';
import { writeTaskSummary } from '../../src/artifacts/write-task-summary.ts';

test('writeResultAudit creates parent directories and publishes JSON', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-audit-'));
  const target = path.join(root, 'nested', 'result.json');
  await writeResultAudit(target, { status: 'ok' });
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { status: 'ok' });
});

test('writeTaskSummary creates parent directories and publishes JSON', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-summary-'));
  const target = path.join(root, 'nested', 'summary.json');
  await writeTaskSummary(target, { status: 'incomplete' });
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { status: 'incomplete' });
});
