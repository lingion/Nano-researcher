import test from 'node:test';
import assert from 'node:assert/strict';

import * as liveAuditModule from '../../src/app/run-live-audit.ts';

test('run-live-audit exports a local heavy-cannon initializer for CLI search injection', () => {
  assert.equal(typeof liveAuditModule.initializeLocalHeavyCannonWebSearch, 'function');
});

test('run-live-audit exports a local heavy-cannon initializer for CLI fetch injection', () => {
  assert.equal(typeof liveAuditModule.initializeLocalHeavyCannonWebFetch, 'function');
});
