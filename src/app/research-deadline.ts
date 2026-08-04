export const DEFAULT_RESEARCH_RUN_TIMEOUT_MS = 1_800_000;
const MAX_RESEARCH_RUN_TIMEOUT_MS = 86_400_000;

export function parseResearchRunTimeoutMs(
  env: { RESEARCH_RUN_TIMEOUT_MS?: string } = process.env,
  fallback = DEFAULT_RESEARCH_RUN_TIMEOUT_MS,
): number {
  const raw = env.RESEARCH_RUN_TIMEOUT_MS;
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RESEARCH_RUN_TIMEOUT_MS) {
    throw new Error(`RESEARCH_RUN_TIMEOUT_MS must be an integer from 1 to ${MAX_RESEARCH_RUN_TIMEOUT_MS}.`);
  }
  return value;
}

export interface ResearchDeadline {
  signal: AbortSignal;
  clear(): void;
}

export function createResearchDeadline(timeoutMs: number, parentSignal?: AbortSignal): ResearchDeadline {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_RESEARCH_RUN_TIMEOUT_MS) {
    throw new Error(`Research deadline must be an integer from 1 to ${MAX_RESEARCH_RUN_TIMEOUT_MS}.`);
  }
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`Research run timed out after ${timeoutMs}ms`)), timeoutMs);
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
}
