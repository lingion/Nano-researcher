import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RuntimeTimeoutError,
  isRetryableRuntimeError,
  retryDelayMs,
  withTimeout,
} from '../../src/runtime/reliability.ts';

test('withTimeout rejects with a stage timeout when an operation exceeds its deadline', async () => {
  await assert.rejects(
    withTimeout(new Promise<string>(() => {}), 5, 'model'),
    (error) => error instanceof RuntimeTimeoutError
      && error.message === 'model timed out after 5ms'
      && error.timeoutMs === 5,
  );
});

test('withTimeout resolves a completed operation and does not invoke timeout callback', async () => {
  let timedOut = false;
  const result = await withTimeout(Promise.resolve('ok'), 50, 'search', () => {
    timedOut = true;
  });
  assert.equal(result, 'ok');
  assert.equal(timedOut, false);
});

test('retryDelayMs produces bounded exponential delays', () => {
  assert.deepEqual([1, 2, 3].map((attempt) => retryDelayMs(attempt)), [200, 600, 1800]);
  assert.equal(retryDelayMs(2, 17), 617);
});

test('isRetryableRuntimeError identifies timeout and transient transport failures only', () => {
  assert.equal(isRetryableRuntimeError(new RuntimeTimeoutError('fetch', 10)), true);
  assert.equal(isRetryableRuntimeError(new Error('503 Service Unavailable')), true);
  assert.equal(isRetryableRuntimeError(new Error('invalid JSON')), false);
});
