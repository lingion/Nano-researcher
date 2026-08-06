import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiCompatibleProvider } from '../../src/llm/openai-compatible.ts';
import { AnthropicProvider } from '../../src/llm/anthropic.ts';
import { LlmProviderError, type LlmTransportEvent } from '../../src/llm/provider.ts';

function response(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': 'application/json' } });
}

test('OpenAI-compatible provider maps text and rejects malformed responses', async () => {
  const provider = new OpenAiCompatibleProvider({ baseUrl: 'https://gateway.test/v1/chat/completions', apiKey: 'test-key', model: 'test-model', fetchImpl: async () => response({ choices: [{ message: { content: '{"ok":true}' } }], model: 'test-model' }) });
  const result = await provider.complete({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(result.text, '{"ok":true}');
  const broken = new OpenAiCompatibleProvider({ baseUrl: 'https://gateway.test', apiKey: 'test-key', model: 'test-model', fetchImpl: async () => response({ choices: [] }) });
  await assert.rejects(() => broken.complete({ messages: [{ role: 'user', content: 'x' }] }), /did not contain/);
});

test('OpenAI-compatible provider normalizes a gateway v1 root to chat completions', async () => {
  let requestedUrl = '';
  const provider = new OpenAiCompatibleProvider({ baseUrl: 'https://gateway.test/v1/', apiKey: 'test-key', model: 'test-model', fetchImpl: async (url) => { requestedUrl = String(url); return response({ choices: [{ message: { content: 'ok' } }] }); } });
  await provider.complete({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(requestedUrl, 'https://gateway.test/v1/chat/completions');
});

test('OpenAI-compatible provider sends the requested strict JSON schema and preserves completion metadata', async () => {
  let sent: Record<string, unknown> | undefined;
  const provider = new OpenAiCompatibleProvider({
    baseUrl: 'https://gateway.test/v1',
    apiKey: 'test-key',
    model: 'test-model',
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response({
        choices: [{ message: { content: '{"decision":"review"}' }, finish_reason: 'length' }],
        model: 'gateway-model',
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });
    },
  });

  const responseFormat = {
    type: 'json_schema' as const,
    json_schema: {
      name: 'decision',
      strict: true,
      schema: { type: 'object' },
    },
  };
  const result = await provider.complete({ messages: [{ role: 'user', content: 'x' }], responseFormat });

  assert.deepEqual(sent?.response_format, responseFormat);
  assert.equal(result.model, 'gateway-model');
  assert.equal(result.finishReason, 'length');
  assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 20 });
  assert.deepEqual(result.responseFormat, responseFormat);
});

test('OpenAI-compatible provider retries one timed-out transport attempt without changing the request', async () => {
  const sentBodies: string[] = [];
  const events: LlmTransportEvent[] = [];
  let attempts = 0;
  const provider = new OpenAiCompatibleProvider({
    baseUrl: 'https://gateway.test/v1',
    apiKey: 'test-key',
    model: 'test-model',
    timeoutMs: 5,
    maxAttempts: 2,
    retryDelayMs: 0,
    fetchImpl: async (_url, init) => {
      attempts += 1;
      sentBodies.push(String(init?.body));
      if (attempts === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }
      return response({ choices: [{ message: { content: '{"decision":"review"}' }, finish_reason: 'stop' }] });
    },
  });

  const result = await provider.complete({
    messages: [{ role: 'user', content: 'x' }],
    onTransportEvent: (event) => events.push(event),
  });

  assert.equal(attempts, 2);
  assert.deepEqual(sentBodies[0], sentBodies[1]);
  assert.equal(result.transportAttempts, 2);
  assert.equal(events[1]?.type, 'attempt_failed');
  assert.equal(events[1]?.code, 'LLM_TIMEOUT');
  assert.equal(events[1]?.errorSummary, 'LLM request timed out');
});

test('OpenAI-compatible provider exposes every transport attempt and bounded Retry-After metadata', async () => {
  const events: LlmTransportEvent[] = [];
  let attempts = 0;
  const provider = new OpenAiCompatibleProvider({
    baseUrl: 'https://gateway.test/v1',
    apiKey: 'test-key',
    model: 'test-model',
    maxAttempts: 2,
    retryDelayMs: 0,
    maxRetryAfterMs: 5,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ error: { message: 'rate limited '.repeat(100) } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '60', 'x-request-id': 'req-first' },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"decision":"review"}' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-second' },
      });
    },
  });

  const result = await provider.complete({
    messages: [{ role: 'user', content: 'x' }],
    onTransportEvent: (event) => events.push(event),
  });

  assert.equal(result.transportAttempts, 2);
  assert.equal(result.requestId, 'req-second');
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(events.map((event) => event.type), [
    'attempt_started', 'attempt_failed', 'retry_scheduled', 'attempt_started', 'attempt_succeeded',
  ]);
  assert.deepEqual(events[1], {
    type: 'attempt_failed', attempt: 1, maxAttempts: 2, durationMs: events[1]?.durationMs,
    code: 'LLM_HTTP_ERROR', httpStatus: 429, requestId: 'req-first', retryable: true,
    retryAfterMs: 5, errorSummary: events[1]?.errorSummary,
  });
  assert.ok((events[1]?.errorSummary?.length ?? 0) <= 500);
  assert.equal(events[2]?.code, 'LLM_HTTP_ERROR');
  assert.equal(events[2]?.httpStatus, 429);
  assert.equal(events[2]?.requestId, 'req-first');
  assert.equal(events[2]?.errorSummary, events[1]?.errorSummary);
  assert.equal(events[2]?.retryAfterMs, 5);
  assert.equal(events[2]?.delayMs, 5);
});

test('OpenAI-compatible provider bounds response bodies and classifies invalid JSON and envelopes', async () => {
  const oversized = new OpenAiCompatibleProvider({
    baseUrl: 'https://gateway.test/v1', apiKey: 'test-key', model: 'test-model', maxResponseBodyBytes: 64,
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(200) } }] }), { status: 200 }),
  });
  await assert.rejects(
    () => oversized.complete({ messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => error instanceof LlmProviderError && error.code === 'LLM_INVALID_RESPONSE' && /body exceeded/i.test(error.message),
  );

  const invalidJson = new OpenAiCompatibleProvider({
    baseUrl: 'https://gateway.test/v1', apiKey: 'test-key', model: 'test-model',
    fetchImpl: async () => new Response('{not-json', { status: 200, headers: { 'x-request-id': 'req-invalid-json' } }),
  });
  await assert.rejects(
    () => invalidJson.complete({ messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => error instanceof LlmProviderError
      && error.code === 'LLM_INVALID_RESPONSE'
      && error.requestId === 'req-invalid-json'
      && error.httpStatus === 200,
  );

  const invalidEnvelope = new OpenAiCompatibleProvider({
    baseUrl: 'https://gateway.test/v1', apiKey: 'test-key', model: 'test-model',
    fetchImpl: async () => response({ choices: [] }),
  });
  await assert.rejects(
    () => invalidEnvelope.complete({ messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => error instanceof LlmProviderError && error.code === 'LLM_INVALID_RESPONSE' && /choices/i.test(error.message),
  );

  const nullEnvelope = new OpenAiCompatibleProvider({
    baseUrl: 'https://gateway.test/v1', apiKey: 'test-key', model: 'test-model', maxAttempts: 2, retryDelayMs: 0,
    fetchImpl: async () => new Response('null', { status: 200 }),
  });
  await assert.rejects(
    () => nullEnvelope.complete({ messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => error instanceof LlmProviderError
      && error.code === 'LLM_INVALID_RESPONSE'
      && error.transportAttempts === 1,
  );
});

test('OpenAI-compatible provider does not retry a non-retryable 400 response', async () => {
  let attempts = 0;
  const provider = new OpenAiCompatibleProvider({
    baseUrl: 'https://gateway.test/v1',
    apiKey: 'test-key',
    model: 'test-model',
    maxAttempts: 3,
    retryDelayMs: 0,
    maxRetryAfterMs: 5,
    fetchImpl: async () => {
      attempts += 1;
      return new Response(JSON.stringify({ error: { message: 'bad schema '.repeat(100) } }), {
        status: 400,
        headers: { 'retry-after': '60', 'x-request-id': `req-${'x'.repeat(300)}` },
      });
    },
  });

  await assert.rejects(
    () => provider.complete({ messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => error instanceof LlmProviderError
      && error.code === 'LLM_HTTP_ERROR'
      && error.httpStatus === 400
      && error.transportAttempts === 1
      && error.requestId?.length === 200
      && (error.errorSummary?.length ?? 0) <= 500
      && error.retryAfterMs === 5,
  );
  assert.equal(attempts, 1);
});

test('OpenAI-compatible provider uses one forced function call as the structured decision channel', async () => {
  let sent: any;
  const provider = new OpenAiCompatibleProvider({
    baseUrl: 'https://gateway.test/v1', apiKey: 'test-key', model: 'test-model', responseFormatMode: 'tool_call',
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return response({ choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ type: 'function', function: { name: 'submit_research_decision', arguments: '{"decision":"review"}' } }] } }] });
    },
  });
  const responseTool = { name: 'submit_research_decision', description: 'Submit one decision.', parameters: { type: 'object' } };

  const result = await provider.complete({ messages: [{ role: 'user', content: 'x' }], responseTool });

  assert.equal(sent.response_format, undefined);
  assert.equal(sent.tools[0].function.name, 'submit_research_decision');
  assert.deepEqual(sent.tool_choice, { type: 'function', function: { name: 'submit_research_decision' } });
  assert.equal(sent.parallel_tool_calls, false);
  assert.equal(result.text, '{"decision":"review"}');
  assert.equal(result.structuredOutputMode, 'tool_call');
  assert.equal(result.toolCallCount, 1);
});

test('OpenAI-compatible provider retries an invalid forced-tool response at the transport boundary', async () => {
  let attempts = 0;
  const events: LlmTransportEvent[] = [];
  const provider = new OpenAiCompatibleProvider({
    baseUrl: 'https://gateway.test/v1', apiKey: 'test-key', model: 'test-model', responseFormatMode: 'tool_call', maxAttempts: 2, retryDelayMs: 0,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return response({ choices: [{ finish_reason: 'stop', message: { content: '', tool_calls: [] } }] });
      return response({ choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ function: { name: 'submit_research_decision', arguments: '{"decision":"review"}' } }] } }] });
    },
  });

  const result = await provider.complete({
    messages: [{ role: 'user', content: 'x' }],
    responseTool: { name: 'submit_research_decision', description: 'Submit one decision.', parameters: { type: 'object' } },
    onTransportEvent: (event) => events.push(event),
  });
  assert.equal(attempts, 2);
  assert.equal(result.text, '{"decision":"review"}');
  assert.deepEqual(events.map((event) => event.type), ['attempt_started', 'attempt_failed', 'retry_scheduled', 'attempt_started', 'attempt_succeeded']);
  assert.equal(events[1]?.code, 'LLM_INVALID_RESPONSE');
});

test('OpenAI-compatible provider returns repeated forced-tool contract failures for agent recovery', async () => {
  const provider = new OpenAiCompatibleProvider({
    baseUrl: 'https://gateway.test/v1', apiKey: 'test-key', model: 'test-model', responseFormatMode: 'tool_call', maxAttempts: 2, retryDelayMs: 0,
    fetchImpl: async () => response({ choices: [{ message: { tool_calls: [
      { function: { name: 'submit_research_decision', arguments: '{}' } },
      { function: { name: 'submit_research_decision', arguments: '{}' } },
    ] } }] }),
  });

  const result = await provider.complete({
    messages: [{ role: 'user', content: 'x' }],
    responseTool: { name: 'submit_research_decision', description: 'Submit one decision.', parameters: { type: 'object' } },
  });
  assert.equal(result.protocolError?.code, 'INVALID_TOOL_CALL');
  assert.match(result.protocolError?.message ?? '', /Expected exactly one submit_research_decision/);
  assert.equal(result.toolCallCount, 2);
  assert.equal(result.transportAttempts, 2);
});

test('OpenAI-compatible provider never calls the gateway for an already-aborted request', async () => {
  let calls = 0;
  const provider = new OpenAiCompatibleProvider({
    baseUrl: 'https://gateway.test/v1', apiKey: 'test-key', model: 'test-model',
    fetchImpl: async () => { calls += 1; return response({ choices: [{ message: { content: 'unused' } }] }); },
  });
  const controller = new AbortController();
  controller.abort(new Error('cancelled before request'));

  await assert.rejects(() => provider.complete({ messages: [{ role: 'user', content: 'x' }], signal: controller.signal }), /cancelled before request/);
  assert.equal(calls, 0);
});

test('Anthropic provider separates system message and maps text block', async () => {
  let sent: any;
  const provider = new AnthropicProvider({ baseUrl: 'https://api.test/messages', apiKey: 'test-key', model: 'test-model', fetchImpl: async (_url, init) => { sent = JSON.parse(String(init?.body)); return response({ content: [{ type: 'text', text: 'answer' }] }); } });
  const result = await provider.complete({ messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'question' }] });
  assert.equal(result.text, 'answer');
  assert.equal(provider.structuredOutputMode, 'none');
  assert.equal(sent.system, 'rules');
  assert.deepEqual(sent.messages, [{ role: 'user', content: 'question' }]);
});
