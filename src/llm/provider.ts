export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type LlmProviderErrorCode = 'LLM_TIMEOUT' | 'LLM_NETWORK_ERROR' | 'LLM_HTTP_ERROR' | 'LLM_INVALID_RESPONSE';

export type LlmTransportEvent = {
  type: 'attempt_started' | 'attempt_succeeded' | 'attempt_failed' | 'retry_scheduled';
  attempt: number;
  maxAttempts: number;
  durationMs?: number;
  code?: LlmProviderErrorCode;
  httpStatus?: number;
  requestId?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  delayMs?: number;
  errorSummary?: string;
};

export class LlmProviderError extends Error {
  transportAttempts?: number;
  readonly requestId?: string;
  readonly errorSummary?: string;
  readonly retryAfterMs?: number;

  constructor(
    readonly code: LlmProviderErrorCode,
    message: string,
    readonly httpStatus?: number,
    details: { requestId?: string; errorSummary?: string; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'LlmProviderError';
    this.requestId = details.requestId;
    this.errorSummary = details.errorSummary;
    this.retryAfterMs = details.retryAfterMs;
  }
}

export type LlmResponseFormat =
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } };

export interface LlmResponseTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmCompletion {
  text: string;
  model?: string;
  usage?: unknown;
  finishReason?: string;
  responseFormat?: LlmResponseFormat;
  transportAttempts?: number;
  structuredOutputMode?: 'tool_call' | 'json_schema' | 'json_object' | 'none';
  toolCallCount?: number;
  requestId?: string;
  httpStatus?: number;
  protocolError?: {
    code: string;
    message: string;
  };
}

export interface LlmProvider {
  readonly structuredOutputMode?: 'tool_call' | 'json_schema' | 'json_object' | 'none';
  complete(input: {
    messages: LlmMessage[];
    signal?: AbortSignal;
    responseFormat?: LlmResponseFormat;
    responseTool?: LlmResponseTool;
    onTransportEvent?: (event: LlmTransportEvent) => void;
  }): Promise<LlmCompletion>;
}
