import { LlmProviderError, type LlmCompletion, type LlmMessage, type LlmProvider, type LlmResponseFormat, type LlmResponseTool, type LlmTransportEvent } from './provider.ts';

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown; stop_reason?: unknown }>;
  model?: string;
  usage?: unknown;
}

const DEFAULT_RESPONSE_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;
const MAX_RETRY_AFTER_MS = 120_000;
const MAX_ERROR_SUMMARY_CHARS = 500;

class RetryableLlmTransportError extends LlmProviderError {}
class LlmHttpError extends LlmProviderError {
  constructor(readonly status: number, details: { requestId?: string; errorSummary?: string; retryAfterMs?: number } = {}) {
    super('LLM_HTTP_ERROR', `LLM HTTP ${status}${details.errorSummary ? `: ${details.errorSummary}` : ''}`, status, details);
  }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value!)));
}

function requestIdFrom(headers: Headers): string | undefined {
  for (const name of ['x-request-id', 'request-id', 'x-amzn-requestid', 'x-correlation-id']) {
    const value = headers.get(name)?.trim();
    if (value) return value.slice(0, 200);
  }
  return undefined;
}

function boundedSummary(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value : value instanceof Error ? value.message : String(value ?? '');
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact ? compact.slice(0, MAX_ERROR_SUMMARY_CHARS) : undefined;
}

function responseErrorSummary(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | unknown; message?: unknown };
    if (parsed?.error && typeof parsed.error === 'object' && 'message' in parsed.error) {
      return boundedSummary((parsed.error as { message?: unknown }).message);
    }
    if (parsed?.message !== undefined) return boundedSummary(parsed.message);
  } catch {
    // A non-JSON error body is still useful as a bounded diagnostic summary.
  }
  return boundedSummary(text);
}

function retryAfterMs(headers: Headers, maximumMs: number, nowMs = Date.now()): number | undefined {
  const raw = headers.get('retry-after')?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  const unbounded = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(raw) - nowMs;
  if (!Number.isFinite(unbounded)) return undefined;
  return Math.max(0, Math.min(maximumMs, Math.round(unbounded)));
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    const remaining = maximumBytes - total;
    if (value.length > remaining) {
      if (remaining > 0) chunks.push(value.slice(0, remaining));
      total = maximumBytes;
      truncated = true;
      await reader.cancel('response body limit reached').catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, delayMs);
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  jsonMode?: boolean;
  responseFormatMode?: 'tool_call' | 'json_schema' | 'json_object' | 'none';
  maxAttempts?: number;
  retryDelayMs?: number;
  maxRetryAfterMs?: number;
  maxResponseBodyBytes?: number;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(private readonly options: OpenAiCompatibleOptions) {}

  get structuredOutputMode(): 'tool_call' | 'json_schema' | 'json_object' | 'none' {
    if (this.options.responseFormatMode) return this.options.responseFormatMode;
    return this.options.jsonMode === false ? 'none' : 'json_schema';
  }

  private endpoint(): string {
    const raw = this.options.baseUrl.replace(/\/+$/, '');
    return /\/chat\/completions$/i.test(raw) ? raw : `${raw}/chat/completions`;
  }

  async complete(input: {
    messages: LlmMessage[];
    signal?: AbortSignal;
    responseFormat?: LlmResponseFormat;
    responseTool?: LlmResponseTool;
    onTransportEvent?: (event: LlmTransportEvent) => void;
  }): Promise<LlmCompletion> {
    const useToolCall = this.options.responseFormatMode === 'tool_call';
    if (useToolCall && !input.responseTool) throw new Error('tool_call mode requires responseTool');
    const responseFormat = useToolCall || this.options.responseFormatMode === 'none'
      ? undefined
      : this.options.responseFormatMode === 'json_object'
        ? { type: 'json_object' as const }
        : input.responseFormat ?? { type: 'json_object' as const };
    const body = JSON.stringify({
      model: this.options.model,
      messages: input.messages,
      ...(this.options.jsonMode !== false && responseFormat ? { response_format: responseFormat } : {}),
      ...(useToolCall && input.responseTool ? {
        tools: [{ type: 'function', function: { ...input.responseTool, strict: true } }],
        tool_choice: { type: 'function', function: { name: input.responseTool.name } },
        parallel_tool_calls: false,
      } : {}),
    });
    const maxAttempts = boundedInteger(this.options.maxAttempts, 2, 1, 5);
    const maximumRetryAfterMs = boundedInteger(this.options.maxRetryAfterMs, DEFAULT_MAX_RETRY_AFTER_MS, 0, MAX_RETRY_AFTER_MS);
    const maximumBodyBytes = boundedInteger(this.options.maxResponseBodyBytes, DEFAULT_RESPONSE_BODY_BYTES, 1, MAX_RESPONSE_BODY_BYTES);
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (input.signal?.aborted) throw input.signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
      input.onTransportEvent?.({ type: 'attempt_started', attempt, maxAttempts });
      const attemptStartedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('LLM request timed out')), this.options.timeoutMs ?? 120_000);
      const abort = () => controller.abort(input.signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
      input.signal?.addEventListener('abort', abort, { once: true });
      let retryDelayMs = this.options.retryDelayMs ?? 250;
      try {
        const response = await (this.options.fetchImpl ?? fetch)(this.endpoint(), {
          method: 'POST',
          headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
          body,
          signal: controller.signal,
        });
        const requestId = requestIdFrom(response.headers);
        const responseBody = await readBoundedBody(response, maximumBodyBytes);
        if (!response.ok) {
          const summary = responseErrorSummary(responseBody.text);
          const retryAfter = retryAfterMs(response.headers, maximumRetryAfterMs);
          throw new LlmHttpError(response.status, {
            ...(requestId ? { requestId } : {}),
            ...(summary ? { errorSummary: summary } : {}),
            ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
          });
        }
        if (responseBody.truncated) {
          throw new LlmProviderError(
            'LLM_INVALID_RESPONSE',
            `LLM response body exceeded ${maximumBodyBytes} bytes.`,
            response.status,
            requestId ? { requestId } : {},
          );
        }
        let payload: OpenAiResponse;
        try {
          const parsed = JSON.parse(responseBody.text) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('invalid envelope');
          }
          payload = parsed as OpenAiResponse;
        } catch {
          throw new LlmProviderError(
            'LLM_INVALID_RESPONSE',
            'LLM response body is not valid JSON or a valid gateway envelope.',
            response.status,
            requestId ? { requestId } : {},
          );
        }
        const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
        if (!choice?.message || typeof choice.message !== 'object') {
          throw new LlmProviderError(
            'LLM_INVALID_RESPONSE',
            'LLM response did not contain choices[0].message.',
            response.status,
            requestId ? { requestId } : {},
          );
        }
        const toolCalls = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls as Array<{ function?: { name?: unknown; arguments?: unknown } }> : [];
        if (useToolCall && (toolCalls.length !== 1 || toolCalls[0]?.function?.name !== input.responseTool?.name || typeof toolCalls[0]?.function?.arguments !== 'string')) {
          throw new RetryableLlmTransportError(
            'LLM_INVALID_RESPONSE',
            `LLM ignored the forced ${input.responseTool?.name} tool contract.`,
            response.status,
            {
              ...(requestId ? { requestId } : {}),
              errorSummary: `Expected exactly one ${input.responseTool?.name} tool call; received ${toolCalls.length}.`,
            },
          );
        }
        const text = useToolCall ? toolCalls[0]!.function!.arguments as string : choice.message.content;
        if (typeof text !== 'string') {
          throw new LlmProviderError(
            'LLM_INVALID_RESPONSE',
            'LLM response did not contain a string choices[0].message.content.',
            response.status,
            requestId ? { requestId } : {},
          );
        }
        input.onTransportEvent?.({ type: 'attempt_succeeded', attempt, maxAttempts, durationMs: Date.now() - attemptStartedAt, httpStatus: response.status, ...(requestId ? { requestId } : {}) });
        return {
          text,
          model: payload.model ?? this.options.model,
          usage: payload.usage,
          transportAttempts: attempt,
          structuredOutputMode: useToolCall ? 'tool_call' : responseFormat?.type ?? 'none',
          ...(useToolCall ? { toolCallCount: toolCalls.length } : {}),
          ...(choice.finish_reason !== undefined || choice.stop_reason !== undefined ? { finishReason: String(choice.finish_reason ?? choice.stop_reason) } : {}),
          ...(responseFormat ? { responseFormat } : {}),
          ...(requestId ? { requestId } : {}),
          httpStatus: response.status,
        };
      } catch (caught) {
        if (input.signal?.aborted) {
          input.onTransportEvent?.({
            type: 'attempt_failed', attempt, maxAttempts, durationMs: Date.now() - attemptStartedAt,
            retryable: false, errorSummary: boundedSummary(input.signal.reason ?? caught),
          });
          throw input.signal.reason ?? caught;
        }
        const error = caught instanceof LlmProviderError
          ? caught
          : new RetryableLlmTransportError(
            controller.signal.aborted ? 'LLM_TIMEOUT' : 'LLM_NETWORK_ERROR',
            controller.signal.aborted ? 'LLM request timed out' : boundedSummary(caught) ?? 'LLM network request failed',
            undefined,
            { errorSummary: controller.signal.aborted ? 'LLM request timed out' : boundedSummary(caught) ?? 'LLM network request failed' },
          );
        const retryable = error instanceof RetryableLlmTransportError
          || error instanceof LlmHttpError && (error.status === 429 || error.status >= 500);
        input.onTransportEvent?.({
          type: 'attempt_failed',
          attempt,
          maxAttempts,
          durationMs: Date.now() - attemptStartedAt,
          code: error.code,
          ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
          ...(error.requestId ? { requestId: error.requestId } : {}),
          ...(error.errorSummary ? { errorSummary: error.errorSummary } : {}),
          ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
          retryable,
        });
        if (!retryable || attempt >= maxAttempts) {
          error.transportAttempts = attempt;
          throw error;
        }
        lastError = error;
        retryDelayMs = error.retryAfterMs ?? retryDelayMs;
        input.onTransportEvent?.({
          type: 'retry_scheduled', attempt, maxAttempts, delayMs: retryDelayMs,
          code: error.code,
          ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
          ...(error.requestId ? { requestId: error.requestId } : {}),
          ...(error.errorSummary ? { errorSummary: error.errorSummary } : {}),
          retryable: true,
          ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
        });
      } finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener('abort', abort);
      }
      await waitForRetry(retryDelayMs, input.signal);
    }
    throw lastError instanceof Error ? lastError : new Error('LLM request failed');
  }
}
