export class RuntimeTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(stage: string, timeoutMs: number) {
    super(`${stage} timed out after ${timeoutMs}ms`);
    this.name = 'RuntimeTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  stage: string,
  onTimeout?: () => void,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return operation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new RuntimeTimeoutError(stage, timeoutMs));
    }, timeoutMs);
    operation.then(resolve, reject).finally(() => {
      if (timer) clearTimeout(timer);
    });
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
