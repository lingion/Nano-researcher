import test from 'node:test';
import assert from 'node:assert/strict';

import { runLiveDiagnosticHarness } from '../../scripts/live-diagnostic-harness.ts';

test('live diagnostic harness stays disabled unless LIVE_AUDIT_DIAG is set', async () => {
  const calls: string[] = [];
  const logs: string[] = [];

  const result = await runLiveDiagnosticHarness({
    env: {},
    callModel: async (prompt) => {
      calls.push(prompt);
      return 'ok';
    },
    log: (line) => logs.push(line),
  });

  assert.equal(result.enabled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(logs, []);
});

test('live diagnostic harness runs minimal, medium, and full probes without tool side effects', async () => {
  const prompts: string[] = [];
  const logs: string[] = [];

  const result = await runLiveDiagnosticHarness({
    env: {
      LIVE_AUDIT_DIAG: '1',
      LIVE_AUDIT_DIAG_MEDIUM_PROMPT: 'core task without bulky html',
      LIVE_AUDIT_DIAG_FULL_PROMPT: 'core task with full bulky html and trajectory',
    },
    callModel: async (prompt) => {
      prompts.push(prompt);
      if (prompt.includes('full bulky')) {
        throw Object.assign(new Error('Gateway returned verified empty response after retries'), {
          diagnostics: {
            traceId: 'trace-full',
            shapeType: 'GENUINE_EMPTY',
            requestMetrics: { bodyBytes: 2048 },
          },
        });
      }
      return `ok:${prompt.length}`;
    },
    log: (line) => logs.push(line),
  });

  assert.equal(result.enabled, true);
  assert.deepEqual(prompts, [
    "PING: Reply 'ACK' and nothing else.",
    'core task without bulky html',
    'core task with full bulky html and trajectory',
  ]);
  assert.deepEqual(result.groups.map((group) => ({ name: group.name, ok: group.ok })), [
    { name: 'minimal', ok: true },
    { name: 'medium', ok: true },
    { name: 'full', ok: false },
  ]);
  assert.equal(result.groups[2]?.diagnostics?.traceId, 'trace-full');
  assert.equal(logs.some((line) => line.includes('[GROUP full] FATAL')), true);
});

test('live diagnostic harness requires real medium and full prompts when enabled', async () => {
  await assert.rejects(
    () => runLiveDiagnosticHarness({
      env: { LIVE_AUDIT_DIAG: '1' },
      callModel: async () => 'ok',
      log: () => {},
    }),
    /LIVE_AUDIT_DIAG_MEDIUM_PROMPT and LIVE_AUDIT_DIAG_FULL_PROMPT are required/,
  );
});
