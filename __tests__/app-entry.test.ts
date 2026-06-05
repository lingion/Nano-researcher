import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runPolicyTask } from '../src/app/index.js';

test('app entry exports the task runner', () => {
  assert.equal(typeof runPolicyTask, 'function');
});
