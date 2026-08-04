import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResearchRunTimeoutMs } from '../../src/app/research-deadline.ts';

test('research deadline configuration is shared, bounded, and rejects non-finite values', () => {
  assert.equal(parseResearchRunTimeoutMs({}), 1_800_000);
  assert.equal(parseResearchRunTimeoutMs({ RESEARCH_RUN_TIMEOUT_MS: '600000' }), 600_000);
  for (const value of ['0', '-1', 'NaN', 'Infinity', '1.5', '86400001']) {
    assert.throws(() => parseResearchRunTimeoutMs({ RESEARCH_RUN_TIMEOUT_MS: value }), /RESEARCH_RUN_TIMEOUT_MS/);
  }
});
