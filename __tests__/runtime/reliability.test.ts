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

test('withTimeout consumes a late rejection after timing out', async () => {
  let rejectOperation!: (error: Error) => void;
  const operation = new Promise<string>((_resolve, reject) => {
    rejectOperation = reject;
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    await assert.rejects(withTimeout(operation, 5, 'model'), RuntimeTimeoutError);
    rejectOperation(new Error('late failure'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('withTimeout aborts cancellable operations when they time out', async () => {
  let aborted = false;
  await assert.rejects(
    withTimeout((signal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      });
    }), 5, 'model'),
    (error) => error instanceof RuntimeTimeoutError,
  );
  assert.equal(aborted, true);
});

test('withTimeout forwards an external abort and rejects without waiting for the deadline', async () => {
  const external = new AbortController();
  let receivedSignal!: AbortSignal;
  const operation = withTimeout((signal) => {
    receivedSignal = signal;
    return new Promise<string>(() => {});
  }, 1000, 'model', undefined, external.signal);

  external.abort(new Error('caller cancelled'));
  await assert.rejects(operation, (error) => error instanceof Error && error.message === 'caller cancelled');
  assert.equal(receivedSignal.aborted, true);
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
