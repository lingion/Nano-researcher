export interface NanoclawRuntimeConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  provider: 'openai' | 'anthropic';
}

export interface GatewayModelProbeResult {
  endpoint: string;
  ok: boolean;
  status: number;
  statusText: string;
  contentType: string | null;
  topLevelKeys: string[];
  dataCount: number | null;
  sampleModelIds: string[];
  includesConfiguredModel: boolean;
  configuredModel: string;
}

export interface EmptyResponseDiagnostics {
  traceId: string;
  shapeType: 'GENUINE_EMPTY' | 'PARSING_LOST' | 'POLICY_REFUSAL' | 'TRUNCATED_OR_LIMIT' | 'UNKNOWN_SHAPE';
  finishReason: string;
  refusal: string;
  streamModeDetected: boolean;
  requestMetrics: {
    bodyBytes: number;
    promptChars: number;
    messageCount: number;
    model: string;
    stream: boolean | null;
    maxTokens: number | null;
    temperature: number | null;
    responseFormat: string | null;
  };
  responseMetrics: {
    status: number;
    bodyBytes: number;
    topLevelKeys: string[];
  };
  responseFeatures: {
    hasChoicesArray: boolean;
    hasTextContent: boolean;
    messageFieldPresent: boolean;
    deltaFieldPresent: boolean;
    contentFieldPresent: boolean;
    contentFieldType: string;
    toolCallsPresent: boolean;
    refusalFieldPresent: boolean;
    choiceTopLevelKeys: string[];
    rawTopLevelKeys: string[];
  };
}

export class NanoclawEmptyResponseError extends Error {
  diagnostics: EmptyResponseDiagnostics;

  constructor(message: string, diagnostics: EmptyResponseDiagnostics);
  constructor(diagnostics: EmptyResponseDiagnostics);
  constructor(messageOrDiagnostics: string | EmptyResponseDiagnostics, diagnostics?: EmptyResponseDiagnostics) {
    super(typeof messageOrDiagnostics === 'string' ? messageOrDiagnostics : 'Nanoclaw returned empty text response');
    this.name = 'NanoclawEmptyResponseError';
    this.diagnostics = typeof messageOrDiagnostics === 'string' ? diagnostics as EmptyResponseDiagnostics : messageOrDiagnostics;
  }
}

export function resolveRuntimeModel(): string {
  return (
    process.env.POLICY_AGENT_LLM_MODEL ??
    process.env.NANOCLAW_MODEL ??
    process.env.ANTHROPIC_MODEL ??
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ??
    'claude-opus-4-8'
  );
}

function inferProviderFromBaseUrl(baseURL: string): NanoclawRuntimeConfig['provider'] {
  try {
    const hostname = new URL(baseURL).hostname.toLowerCase();
    if (hostname === '987xyz.com' || hostname.endsWith('.987xyz.com')) {
      return 'openai';
    }
  } catch {
    // Fall through to path-based inference for malformed-but-usable gateway strings.
  }

  return /\/(chat\/completions)$/i.test(baseURL.replace(/\/+$/, '')) || /openai/i.test(baseURL)
    ? 'openai'
    : 'anthropic';
}

export function resolveNanoclawRuntimeConfig(): NanoclawRuntimeConfig {
  const apiKey = process.env.NANOCLAW_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Missing NANOCLAW_API_KEY/ANTHROPIC_API_KEY for live runtime');
  }

  const baseURL = process.env.NANOCLAW_BASE_URL ?? process.env.ANTHROPIC_BASE_URL;
  if (!baseURL) {
    throw new Error('Missing NANOCLAW_BASE_URL/ANTHROPIC_BASE_URL for live runtime');
  }

  const provider =
    process.env.NANOCLAW_LLM_PROVIDER === 'openai' || process.env.NANOCLAW_LLM_PROVIDER === 'anthropic'
      ? process.env.NANOCLAW_LLM_PROVIDER
      : inferProviderFromBaseUrl(baseURL);

  return {
    apiKey,
    baseURL,
    model: resolveRuntimeModel(),
    provider,
  };
}

function normalizeGatewayRoot(baseURL: string): string {
  try {
    const url = new URL(baseURL);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';

    const withoutTerminalEndpoint = url.pathname
      .replace(/\/(chat\/completions|messages|models)$/i, '')
      .replace(/\/+$/, '');

    url.pathname = /\/v1$/i.test(withoutTerminalEndpoint)
      ? withoutTerminalEndpoint || '/v1'
      : `${withoutTerminalEndpoint || ''}/v1`;

    return url.toString();
  } catch {
    const sanitized = baseURL
      .replace(/\/+(chat\/completions|messages|models)$/i, '')
      .replace(/\/\/[^/@]+@/, '//')
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '');

    return /\/v1$/i.test(sanitized) ? sanitized : `${sanitized}/v1`;
  }
}

function resolveEndpoint(baseURL: string, suffix: '/chat/completions' | '/messages'): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  if (/\/(chat\/completions|messages)$/i.test(trimmed)) return trimmed;
  return `${trimmed}${suffix}`;
}

function resolveModelsEndpoint(baseURL: string): string {
  return `${normalizeGatewayRoot(baseURL).replace(/\/+$/, '')}/models`;
}

function normalizeTopLevelKeys(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return [];
  }
  return Object.keys(payload as Record<string, unknown>).sort();
}

function normalizeModelIds(payload: unknown): string[] {
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => (item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    .slice(0, 5);
}

function truncatePreview(payload: unknown, maxLength = 400): string {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (!raw) return '';
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, maxLength)}…`;
}

function buildResponseFeatures(provider: NanoclawRuntimeConfig['provider'], payload: unknown) {
  const firstChoice = Array.isArray((payload as { choices?: unknown }).choices)
    ? ((payload as { choices: Array<Record<string, unknown>> }).choices[0] ?? null)
    : null;

  const choiceRecord = firstChoice && typeof firstChoice === 'object'
    ? firstChoice as Record<string, unknown>
    : {};

  const messageRecord = choiceRecord.message && typeof choiceRecord.message === 'object'
    ? choiceRecord.message as Record<string, unknown>
    : null;

  const deltaRecord = choiceRecord.delta && typeof choiceRecord.delta === 'object'
    ? choiceRecord.delta as Record<string, unknown>
    : null;

  const contentCandidate = messageRecord?.content ?? deltaRecord?.content;
  const hasTextContent = provider === 'openai'
    ? extractOpenAIText(payload).trim().length > 0
    : extractAnthropicText(payload).trim().length > 0;

  return {
    hasChoicesArray: Array.isArray((payload as { choices?: unknown }).choices),
    hasTextContent,
    messageFieldPresent: messageRecord !== null,
    deltaFieldPresent: deltaRecord !== null,
    contentFieldPresent: contentCandidate !== undefined,
    contentFieldType: contentCandidate === undefined
      ? 'undefined'
      : Array.isArray(contentCandidate)
        ? 'array'
        : typeof contentCandidate,
    toolCallsPresent: Array.isArray(choiceRecord.tool_calls)
      || Array.isArray(messageRecord?.tool_calls)
      || Array.isArray(deltaRecord?.tool_calls),
    refusalFieldPresent: Object.prototype.hasOwnProperty.call(choiceRecord, 'refusal'),
    choiceTopLevelKeys: Object.keys(choiceRecord).sort(),
    rawTopLevelKeys: normalizeTopLevelKeys(payload),
  };
}

function classifyShapeType(
  finishReason: string,
  refusal: string,
  features: ReturnType<typeof buildResponseFeatures>,
): EmptyResponseDiagnostics['shapeType'] {
  if (refusal !== 'none' || finishReason.includes('filter') || finishReason.includes('policy')) {
    return 'POLICY_REFUSAL';
  }
  if (finishReason === 'length' || finishReason === 'max_tokens' || finishReason.includes('limit')) {
    return 'TRUNCATED_OR_LIMIT';
  }
  if (features.toolCallsPresent || (features.hasChoicesArray && !features.contentFieldPresent)) {
    return 'PARSING_LOST';
  }
  if (features.hasChoicesArray && !features.hasTextContent) {
    return 'GENUINE_EMPTY';
  }
  return 'UNKNOWN_SHAPE';
}

function buildRequestMetrics(config: NanoclawRuntimeConfig, body: Record<string, unknown>): EmptyResponseDiagnostics['requestMetrics'] {
  const firstMessageContent = Array.isArray(body.messages)
    ? ((body.messages[0] as { content?: unknown } | undefined)?.content)
    : undefined;

  const promptChars = typeof firstMessageContent === 'string'
    ? firstMessageContent.length
    : Array.isArray(firstMessageContent)
      ? JSON.stringify(firstMessageContent).length
      : 0;

  return {
    bodyBytes: Buffer.byteLength(JSON.stringify(body), 'utf8'),
    promptChars,
    messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
    model: config.model,
    stream: typeof body.stream === 'boolean' ? body.stream : null,
    maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : null,
    temperature: typeof body.temperature === 'number' ? body.temperature : null,
    responseFormat: typeof body.response_format === 'string'
      ? body.response_format
      : body.response_format && typeof body.response_format === 'object'
        ? JSON.stringify(body.response_format)
        : null,
  };
}

function buildEmptyResponseDiagnostics(
  response: Response,
  provider: NanoclawRuntimeConfig['provider'],
  payload: unknown,
  requestMetrics: EmptyResponseDiagnostics['requestMetrics'],
  responseText: string,
): EmptyResponseDiagnostics {
  const firstChoice = Array.isArray((payload as { choices?: unknown }).choices)
    ? ((payload as { choices: Array<Record<string, unknown>> }).choices[0] ?? {})
    : {};

  const finishReason = String(
    (firstChoice as { finish_reason?: unknown; stop_reason?: unknown; incomplete_details?: { reason?: unknown }; completion_reason?: unknown }).finish_reason
      ?? (firstChoice as { stop_reason?: unknown }).stop_reason
      ?? (firstChoice as { incomplete_details?: { reason?: unknown } }).incomplete_details?.reason
      ?? (firstChoice as { completion_reason?: unknown }).completion_reason
      ?? 'missing',
  ).toLowerCase();

  const refusal = String((firstChoice as { refusal?: unknown }).refusal ?? 'none').toLowerCase();
  const responseFeatures = buildResponseFeatures(provider, payload);

  return {
    traceId: response.headers.get('x-request-id')
      ?? response.headers.get('x-trace-id')
      ?? response.headers.get('apigw-request-id')
      ?? 'no-trace-id',
    shapeType: classifyShapeType(finishReason, refusal, responseFeatures),
    finishReason,
    refusal,
    streamModeDetected: responseText.includes('data:') || (response.headers.get('content-type')?.includes('event-stream') ?? false),
    requestMetrics,
    responseMetrics: {
      status: response.status,
      bodyBytes: Buffer.byteLength(responseText, 'utf8'),
      topLevelKeys: normalizeTopLevelKeys(payload),
    },
    responseFeatures,
  };
}

function extractOpenAIText(payload: unknown): string {
  const text = (payload as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  }).choices?.[0]?.message?.content;

  if (typeof text === 'string') return text;
  if (Array.isArray(text)) {
    return text
      .filter((item) => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('');
  }
  return '';
}

function extractAnthropicText(payload: unknown): string {
  const content = (payload as {
    content?: Array<{ type?: string; text?: string }>;
  }).content;

  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function extractErrorDetail(payload: unknown): string {
  if (typeof payload === 'string') return payload;

  const record = payload as {
    error?: string | { message?: string };
    message?: string;
  };

  if (typeof record.error === 'string') return record.error;
  if (typeof record.error?.message === 'string') return record.error.message;
  if (typeof record.message === 'string') return record.message;
  return JSON.stringify(payload);
}

function trackAndLogRawStreamChunks(rawResponseBody: string): void {
  if (process.env.LIVE_AUDIT_DEBUG !== '1') return;
  if (!rawResponseBody || !rawResponseBody.includes('data:')) return;

  const lines = rawResponseBody.split('\n');
  console.error('\n=== [SSE RAW STREAM CUTTING SHAPES] ===');
  console.error(`Total raw lines detected: ${lines.length}`);

  let chunkCount = 0;
  let nonEmptyChunkCount = 0;
  const sampleDeltas: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === 'data: [DONE]') {
      console.error('[Line] -> data: [DONE] reached.');
      continue;
    }

    if (!trimmed.startsWith('data:')) continue;

    chunkCount += 1;
    const jsonStr = trimmed.slice(5).trim();
    try {
      const parsedChunk = JSON.parse(jsonStr) as { choices?: Array<Record<string, unknown>>; finish_reason?: unknown };
      const choice = Array.isArray(parsedChunk.choices) ? parsedChunk.choices[0] : undefined;
      const delta = choice?.delta && typeof choice.delta === 'object' ? choice.delta as Record<string, unknown> : undefined;
      const message = choice?.message && typeof choice.message === 'object' ? choice.message as Record<string, unknown> : undefined;
      const deltaContent = delta?.content;
      const messageContent = message?.content;
      const finishReason = choice?.finish_reason ?? parsedChunk.finish_reason ?? 'missing';
      const hasText = (typeof deltaContent === 'string' && deltaContent.length > 0)
        || (typeof messageContent === 'string' && messageContent.length > 0);

      if (hasText) {
        nonEmptyChunkCount += 1;
        if (sampleDeltas.length < 3) {
          sampleDeltas.push(`[Chunk ${chunkCount}] text="${String(deltaContent ?? messageContent)}"`);
        }
      }

      if (chunkCount <= 3) {
        console.error(
          `[Chunk ${chunkCount} Skeleton] delta_has_content_field=${Object.prototype.hasOwnProperty.call(delta ?? {}, 'content')}, message_has_content_field=${Object.prototype.hasOwnProperty.call(message ?? {}, 'content')}, finish_reason=${String(finishReason)}`,
        );
        console.error(`[Chunk ${chunkCount} Raw] ${trimmed.slice(0, 200)}`);
      }
    } catch {
      console.error(`[Chunk ${chunkCount} Parse Error] Failed to parse: ${trimmed.slice(0, 100)}`);
    }
  }

  console.error(`[Verdict Metadata] Total Chunks: ${chunkCount}, Non-Empty Chunks: ${nonEmptyChunkCount}`);
  if (sampleDeltas.length > 0) {
    console.error(`[Captured Evidence Seeds]:\n  ${sampleDeltas.join('\n  ')}`);
  }
  console.error('=== [END OF SSE CUTTING SHAPES] ===\n');
}

function parseEventStreamPayload(text: string): unknown {
  trackAndLogRawStreamChunks(text);

  const trimmed = text.trim();
  if (!trimmed.includes('data:')) {
    return text;
  }

  const chunks = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.replace(/^data:\s*/, '').trim())
    .filter((line) => line !== '' && line !== '[DONE]');

  if (chunks.length === 0) {
    return {};
  }

  const parsedChunks = chunks.flatMap((chunk) => {
    try {
      return [JSON.parse(chunk) as Record<string, unknown>];
    } catch {
      return [];
    }
  });

  if (parsedChunks.length === 0) {
    return text;
  }

  const firstChunk = parsedChunks.find((chunk) => typeof chunk === 'object' && chunk !== null) ?? {};
  const mergedOpenAIContent = parsedChunks
    .flatMap((chunk) => {
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] as { message?: { content?: unknown }; delta?: { content?: unknown } } | undefined : undefined;
      const messageContent = choice?.message?.content;
      if (typeof messageContent === 'string' && messageContent.trim() !== '') {
        return [messageContent];
      }
      const deltaContent = choice?.delta?.content;
      if (typeof deltaContent === 'string' && deltaContent.trim() !== '') {
        return [deltaContent];
      }
      return [];
    })
    .join('');

  if (Array.isArray((firstChunk as { choices?: unknown }).choices)) {
    const normalizedChoice = {
      ...(((firstChunk as { choices: Array<Record<string, unknown>> }).choices[0]) ?? {}),
      message: {
        role: 'assistant',
        content: mergedOpenAIContent,
      },
    };

    return {
      ...firstChunk,
      choices: [normalizedChoice],
    };
  }

  return firstChunk;
}

async function readResponsePayloadWithText(response: Response): Promise<{ payload: unknown; text: string }> {
  const text = await response.text();
  if (!text) return { payload: {}, text };

  try {
    return { payload: JSON.parse(text) as unknown, text };
  } catch {
    return { payload: parseEventStreamPayload(text), text };
  }
}

async function readResponsePayload(response: Response): Promise<unknown> {
  return (await readResponsePayloadWithText(response)).payload;
}

export async function probeNanoclawGatewayModels(
  options: {
    config?: NanoclawRuntimeConfig;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<GatewayModelProbeResult> {
  const config = options.config ?? resolveNanoclawRuntimeConfig();
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = resolveModelsEndpoint(config.baseURL);

  const response = await fetchImpl(endpoint, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      accept: 'application/json',
      ...(config.provider === 'anthropic'
        ? { 'anthropic-version': '2023-06-01' }
        : {}),
    },
  });

  const payload = await readResponsePayload(response);
  const sampleModelIds = normalizeModelIds(payload);

  return {
    endpoint,
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get('content-type'),
    topLevelKeys: normalizeTopLevelKeys(payload),
    dataCount: Array.isArray((payload as { data?: unknown }).data)
      ? ((payload as { data: unknown[] }).data.length)
      : null,
    sampleModelIds,
    includesConfiguredModel: sampleModelIds.includes(config.model),
    configuredModel: config.model,
  };
}

function isRetriableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function shouldRetryStructurallyValidEmptyResponse(diagnostics: EmptyResponseDiagnostics): boolean {
  return diagnostics.responseMetrics.status === 200
    && diagnostics.responseFeatures.hasChoicesArray === true
    && diagnostics.responseFeatures.hasTextContent === false;
}

export async function callNanoclawModel(
  prompt: string,
  options: {
    config?: NanoclawRuntimeConfig;
    fetchImpl?: typeof fetch;
    jitterSource?: () => number;
    sleepImpl?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<string> {
  const config = options.config ?? resolveNanoclawRuntimeConfig();
  const fetchImpl = options.fetchImpl ?? fetch;
  const jitterSource = options.jitterSource ?? (() => Math.floor(Math.random() * 50));
  const sleepImpl = options.sleepImpl ?? ((delayMs: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  }));

  const endpoint = config.provider === 'openai'
    ? `${normalizeGatewayRoot(config.baseURL).replace(/\/+$/, '')}/chat/completions`
    : resolveEndpoint(config.baseURL, '/messages');

  const body: Record<string, unknown> = config.provider === 'openai'
    ? {
        model: config.model,
        stream: false,
        messages: [{ role: 'user', content: prompt }],
      }
    : {
        model: config.model,
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      };

  const requestMetrics = buildRequestMetrics(config, body);
  let lastError: NanoclawEmptyResponseError | null = null;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
        ...(config.provider === 'anthropic'
          ? { 'anthropic-version': '2023-06-01' }
          : {}),
      },
      body: JSON.stringify(body),
    });

    const { payload, text: responseText } = await readResponsePayloadWithText(response);

    if (!response.ok) {
      const detail = extractErrorDetail(payload);
      if (attempt < maxAttempts && isRetriableStatus(response.status)) {
        const delay = (200 * (3 ** (attempt - 1))) + jitterSource();
        await sleepImpl(delay);
        continue;
      }
      throw new Error(`Nanoclaw request failed with ${response.status} ${response.statusText}: ${detail}`);
    }

    const rawText = config.provider === 'openai'
      ? extractOpenAIText(payload)
      : extractAnthropicText(payload);

    if (rawText) {
      return rawText;
    }

    const diagnostics = buildEmptyResponseDiagnostics(response, config.provider, payload, requestMetrics, responseText);
    const emptyResponseError = new NanoclawEmptyResponseError(
      'Gateway returned verified empty response after retries',
      diagnostics,
    );

    if (attempt < maxAttempts && shouldRetryStructurallyValidEmptyResponse(diagnostics)) {
      lastError = emptyResponseError;
      const delay = (200 * (3 ** (attempt - 1))) + jitterSource();
      await sleepImpl(delay);
      continue;
    }

    throw emptyResponseError;
  }

  throw lastError ?? new NanoclawEmptyResponseError('Gateway returned verified empty response after retries', {
    traceId: 'no-trace-id',
    shapeType: 'UNKNOWN_SHAPE',
    finishReason: 'missing',
    refusal: 'none',
    streamModeDetected: false,
    requestMetrics,
    responseMetrics: {
      status: 200,
      bodyBytes: 0,
      topLevelKeys: [],
    },
    responseFeatures: {
      hasChoicesArray: false,
      hasTextContent: false,
      messageFieldPresent: false,
      deltaFieldPresent: false,
      contentFieldPresent: false,
      contentFieldType: 'undefined',
      toolCallsPresent: false,
      refusalFieldPresent: false,
      choiceTopLevelKeys: [],
      rawTopLevelKeys: [],
    },
  });
}
