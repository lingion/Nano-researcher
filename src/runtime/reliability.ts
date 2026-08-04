export class RuntimeTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(stage: string, timeoutMs: number) {
    super(`${stage} timed out after ${timeoutMs}ms`);
    this.name = 'RuntimeTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

export function withTimeout<T>(
  operation: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  timeoutMs: number,
  stage: string,
  onTimeout?: () => void,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(externalSignal?.reason);

  if (externalSignal?.aborted) {
    controller.abort(externalSignal.reason);
  } else {
    externalSignal?.addEventListener('abort', forwardAbort, { once: true });
  }

  let operationPromise: Promise<T>;
  try {
    operationPromise = typeof operation === 'function'
      ? operation(controller.signal)
      : operation;
  } catch (error) {
    externalSignal?.removeEventListener('abort', forwardAbort);
    return Promise.reject(error);
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return new Promise<T>((resolve, reject) => {
      if (externalSignal?.aborted) {
        reject(abortReason(externalSignal));
        return;
      }
      const onAbort = () => reject(abortReason(externalSignal!));
      externalSignal?.addEventListener('abort', onAbort, { once: true });
      operationPromise.then(
        (value) => {
          externalSignal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          externalSignal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      externalSignal?.removeEventListener('abort', forwardAbort);
      controller.abort();
      reject(new RuntimeTimeoutError(stage, timeoutMs));
      try {
        onTimeout?.();
      } catch {
        // Timeout rejection remains authoritative when cleanup cannot start.
      }
    }, timeoutMs);

    const onExternalAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(abortReason(controller.signal));
    };
    controller.signal.addEventListener('abort', onExternalAbort, { once: true });

    operationPromise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onExternalAbort);
        externalSignal?.removeEventListener('abort', forwardAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onExternalAbort);
        externalSignal?.removeEventListener('abort', forwardAbort);
        reject(error);
      },
    );
  });
}

export function isRetryableRuntimeError(error: unknown): boolean {
  if (error instanceof RuntimeTimeoutError) return true;
  if (!(error instanceof Error)) return false;
  return /timeout|timed out|network|fetch failed|socket|econn|502|503|504|429/i.test(error.message);
}

export function retryDelayMs(attempt: number, jitter = 0): number {
  return (200 * (3 ** Math.max(0, attempt - 1))) + Math.max(0, jitter);
}
