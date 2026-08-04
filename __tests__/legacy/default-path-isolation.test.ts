import test from 'node:test';
import assert from 'node:assert/strict';
import * as app from '../../src/app/index.ts';
import * as legacy from '../../src/legacy/policy-agent.ts';

test('generic application entrypoint is separate from legacy policy agent entrypoint', () => {
  assert.equal(typeof app.runAgent, 'function');
  assert.equal(typeof app.runPolicyTask, 'function');
  assert.equal(typeof legacy.runPolicyTask, 'function');
});
