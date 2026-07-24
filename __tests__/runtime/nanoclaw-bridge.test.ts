import test from 'node:test';
import assert from 'node:assert/strict';

import {
  callNanoclawModel,
  probeNanoclawGatewayModels,
  resolveNanoclawRuntimeConfig,
} from '../../src/runtime/nanoclaw-bridge.ts';

test('nanoclaw bridge hard-locks known OpenAI-compatible gateway hosts even when only ANTHROPIC_* env vars are set', () => {
  const original = {
    NANOCLAW_API_KEY: process.env.NANOCLAW_API_KEY,
    NANOCLAW_BASE_URL: process.env.NANOCLAW_BASE_URL,
    NANOCLAW_LLM_PROVIDER: process.env.NANOCLAW_LLM_PROVIDER,
    POLICY_AGENT_LLM_MODEL: process.env.POLICY_AGENT_LLM_MODEL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  };

  delete process.env.NANOCLAW_API_KEY;
  delete process.env.NANOCLAW_BASE_URL;
  delete process.env.NANOCLAW_LLM_PROVIDER;
  process.env.ANTHROPIC_API_KEY = 'gateway-key';
  process.env.ANTHROPIC_BASE_URL = 'https://987xyz.com/';
  process.env.ANTHROPIC_MODEL = 'gpt-5.4';

  try {
    assert.deepEqual(resolveNanoclawRuntimeConfig(), {
      apiKey: 'gateway-key',
      baseURL: 'https://987xyz.com/',
      model: 'gpt-5.4',
      provider: 'openai',
    });
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('nanoclaw bridge prefers NANOCLAW_* env vars over ANTHROPIC_* fallbacks', () => {
  const original = {
    NANOCLAW_API_KEY: process.env.NANOCLAW_API_KEY,
    NANOCLAW_BASE_URL: process.env.NANOCLAW_BASE_URL,
    NANOCLAW_LLM_PROVIDER: process.env.NANOCLAW_LLM_PROVIDER,
    POLICY_AGENT_LLM_MODEL: process.env.POLICY_AGENT_LLM_MODEL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  };

  process.env.NANOCLAW_API_KEY = 'nano-key';
  process.env.NANOCLAW_BASE_URL = 'https://nano.example/v1';
  process.env.NANOCLAW_LLM_PROVIDER = 'openai';
  process.env.POLICY_AGENT_LLM_MODEL = 'gpt-5.4';
  process.env.ANTHROPIC_API_KEY = 'anthropic-key';
  process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
  process.env.ANTHROPIC_MODEL = 'claude-opus-4-8';

  try {
    assert.deepEqual(resolveNanoclawRuntimeConfig(), {
      apiKey: 'nano-key',
      baseURL: 'https://nano.example/v1',
      model: 'gpt-5.4',
      provider: 'openai',
    });
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('nanoclaw bridge sends a custom model unchanged and normalizes openai-compatible text output', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  const rawText = await callNanoclawModel('prompt-body', {
    config: {
      apiKey: 'nano-key',
      baseURL: 'https://nano.example/v1',
      model: 'gpt-5.4',
      provider: 'openai',
    },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: '{"decision":"stop","reasoning":"done"}',
            },
          },
        ],
      }));
    },
  });

  assert.equal(calls[0]?.url, 'https://nano.example/v1/chat/completions');
  assert.match(String(calls[0]?.init?.body), /"model":"gpt-5\.4"/);
  assert.equal(rawText, '{"decision":"stop","reasoning":"done"}');
});

test('nanoclaw bridge normalizes openai-compatible gateway roots onto /v1 for probe and live calls', async () => {
  const probeCalls: Array<{ url: string; init?: RequestInit }> = [];
  const liveCalls: Array<{ url: string; init?: RequestInit }> = [];

  const probe = await probeNanoclawGatewayModels({
    config: {
      apiKey: 'nano-key',
      baseURL: 'https://user:secret@nano.example/chat/completions?token=hidden',
      model: 'gpt-5.4',
      provider: 'openai',
    },
    fetchImpl: async (url, init) => {
      probeCalls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        object: 'list',
        data: [{ id: 'gpt-5.4', object: 'model' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const rawText = await callNanoclawModel('prompt-body', {
    config: {
      apiKey: 'nano-key',
      baseURL: 'https://nano.example/chat/completions',
      model: 'gpt-5.4',
      provider: 'openai',
    },
    fetchImpl: async (url, init) => {
      liveCalls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
      }));
    },
  });

  assert.equal(probeCalls[0]?.url, 'https://nano.example/v1/models');
  assert.equal(probe.endpoint, 'https://nano.example/v1/models');
  assert.equal(liveCalls[0]?.url, 'https://nano.example/v1/chat/completions');
  assert.equal(rawText, 'ok');
});

test('nanoclaw bridge probes the gateway models endpoint with sanitized intelligence', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  const probe = await probeNanoclawGatewayModels({
    config: {
      apiKey: 'nano-key',
      baseURL: 'https://user:secret@nano.example/v1/chat/completions?token=hidden',
      model: 'gpt-5.4',
      provider: 'openai',
    },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        object: 'list',
        data: [
          { id: 'gpt-5.4', object: 'model' },
          { id: 'gpt-4.1', object: 'model' },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(calls[0]?.url, 'https://nano.example/v1/models');
  assert.equal(calls[0]?.init?.method, 'GET');
  assert.deepEqual(probe, {
    endpoint: 'https://nano.example/v1/models',
    ok: true,
    status: 200,
    statusText: '',
    contentType: 'application/json',
    topLevelKeys: ['data', 'object'],
    dataCount: 2,
    sampleModelIds: ['gpt-5.4', 'gpt-4.1'],
    includesConfiguredModel: true,
    configuredModel: 'gpt-5.4',
  });
});

test('nanoclaw bridge surfaces safe enriched empty-response diagnostics without secrets', async () => {
  await assert.rejects(
    () => callNanoclawModel('prompt-body', {
      config: {
        apiKey: 'nano-key',
        baseURL: 'https://nano.example/v1',
        model: 'gpt-5.4',
        provider: 'openai',
      },
      fetchImpl: async () => new Response(JSON.stringify({
        id: 'resp_123',
        choices: [{ message: { role: 'assistant' } }],
        usage: { total_tokens: 42 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      jitterSource: () => 0,
      sleepImpl: async () => {},
    }),
    (error) => {
      assert.equal(error instanceof Error, true);
      assert.match((error as Error).message, /verified empty response after retries/);
      const diagnostics = (error as Error & { diagnostics?: Record<string, unknown> }).diagnostics;
      assert.deepEqual(diagnostics, {
        traceId: 'no-trace-id',
        shapeType: 'PARSING_LOST',
        finishReason: 'missing',
        refusal: 'none',
        streamModeDetected: false,
        requestMetrics: {
          bodyBytes: 87,
          promptChars: 11,
          messageCount: 1,
          model: 'gpt-5.4',
          stream: false,
          maxTokens: null,
          temperature: null,
          responseFormat: null,
        },
        responseMetrics: {
          status: 200,
          bodyBytes: 90,
          topLevelKeys: ['choices', 'id', 'usage'],
        },
        responseFeatures: {
          hasChoicesArray: true,
          hasTextContent: false,
          messageFieldPresent: true,
          deltaFieldPresent: false,
          contentFieldPresent: false,
          contentFieldType: 'undefined',
          toolCallsPresent: false,
          refusalFieldPresent: false,
          choiceTopLevelKeys: ['message'],
          rawTopLevelKeys: ['choices', 'id', 'usage'],
        },
      });
      assert.equal(JSON.stringify(diagnostics).includes('nano-key'), false);
      return true;
    },
  );
});

test('nanoclaw bridge normalizes anthropic-compatible text blocks', async () => {
  const rawText = await callNanoclawModel('prompt-body', {
    config: {
      apiKey: 'nano-key',
      baseURL: 'https://nano.example',
      model: 'gpt-5.4',
      provider: 'anthropic',
    },
    fetchImpl: async () => new Response(JSON.stringify({
      content: [
        { type: 'text', text: '{"decision":"stop","reasoning":"done"}' },
      ],
    })),
  });

  assert.equal(rawText, '{"decision":"stop","reasoning":"done"}');
});



test('nanoclaw bridge retries once when the gateway returns a structurally valid empty response before succeeding', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  const rawText = await callNanoclawModel('prompt-body', {
    config: {
      apiKey: 'nano-key',
      baseURL: 'https://nano.example/v1',
      model: 'gpt-5.4',
      provider: 'openai',
    },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: '' } }],
          usage: { total_tokens: 14 },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"decision":"stop","reasoning":"done"}' } }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(rawText, '{"decision":"stop","reasoning":"done"}');
});



test('nanoclaw bridge retries up to three times with injected backoff before surfacing enriched empty-response diagnostics', async () => {
  let attempts = 0;
  const delays: number[] = [];

  await assert.rejects(
    () => callNanoclawModel('prompt-body', {
      config: {
        apiKey: 'nano-key',
        baseURL: 'https://nano.example/v1',
        model: 'gpt-5.4',
        provider: 'openai',
      },
      fetchImpl: async () => {
        attempts += 1;
        return new Response(JSON.stringify({
          id: 'resp_retry',
          choices: [{ message: { content: '' } }],
          usage: { total_tokens: 14 },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-request-id': 'trace-empty-1' },
        });
      },
      jitterSource: () => 0,
      sleepImpl: async (delayMs) => {
        delays.push(delayMs);
      },
    }),
    (error) => {
      assert.equal(error instanceof Error, true);
      assert.match((error as Error).message, /verified empty response after retries/);
      const diagnostics = (error as Error & { diagnostics?: Record<string, unknown> }).diagnostics;
      assert.deepEqual(diagnostics, {
        traceId: 'trace-empty-1',
        shapeType: 'GENUINE_EMPTY',
        finishReason: 'missing',
        refusal: 'none',
        streamModeDetected: false,
        requestMetrics: {
          bodyBytes: 87,
          promptChars: 11,
          messageCount: 1,
          model: 'gpt-5.4',
          stream: false,
          maxTokens: null,
          temperature: null,
          responseFormat: null,
        },
        responseMetrics: {
          status: 200,
          bodyBytes: 86,
          topLevelKeys: ['choices', 'id', 'usage'],
        },
        responseFeatures: {
          hasChoicesArray: true,
          hasTextContent: false,
          messageFieldPresent: true,
          deltaFieldPresent: false,
          contentFieldPresent: true,
          contentFieldType: 'string',
          toolCallsPresent: false,
          refusalFieldPresent: false,
          choiceTopLevelKeys: ['message'],
          rawTopLevelKeys: ['choices', 'id', 'usage'],
        },
      });
      assert.equal(attempts, 3);
      assert.deepEqual(delays, [200, 600]);
      return true;
    },
  );
});

test('nanoclaw bridge retries transient upstream failures with the same centralized backoff budget', async () => {
  let attempts = 0;
  const delays: number[] = [];

  const rawText = await callNanoclawModel('prompt-body', {
    config: {
      apiKey: 'nano-key',
      baseURL: 'https://nano.example/v1',
      model: 'gpt-5.4',
      provider: 'openai',
    },
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        return new Response('gateway unavailable', { status: 503, statusText: 'Service Unavailable' });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"decision":"stop","reasoning":"done"}' } }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    jitterSource: () => 0,
    sleepImpl: async (delayMs) => {
      delays.push(delayMs);
    },
  });

  assert.equal(rawText, '{"decision":"stop","reasoning":"done"}');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [200, 600]);
});


test('nanoclaw bridge switches to configured fallback model after primary request timeout', async () => {
  const models: string[] = [];
  const rawText = await callNanoclawModel('prompt-body', {
    config: {
      apiKey: 'nano-key',
      baseURL: 'https://nano.example/v1',
      model: 'gpt-5.4',
      fallbackModel: 'gpt-5.4-mini',
      provider: 'openai',
      requestTimeoutMs: 5,
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      models.push(body.model);
      if (body.model === 'gpt-5.4') {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'fallback-ok' } }] }));
    },
    jitterSource: () => 0,
    sleepImpl: async () => {},
  });

  assert.equal(rawText, 'fallback-ok');
  assert.deepEqual(models, ['gpt-5.4', 'gpt-5.4', 'gpt-5.4', 'gpt-5.4-mini']);
});

test('nanoclaw bridge logs raw SSE chunk forensics only when live audit debug is enabled', async (t) => {
  const originalDebug = process.env.LIVE_AUDIT_DEBUG;
  process.env.LIVE_AUDIT_DEBUG = '1';
  const logs: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });

  try {
    await callNanoclawModel('prompt-body', {
      config: {
        apiKey: 'nano-key',
        baseURL: 'https://nano.example/v1',
        model: 'gpt-5.4',
        provider: 'openai',
      },
      fetchImpl: async () => new Response([
        'data: {"choices":[{"delta":{"content":"A"}}]}',
        'data: {"choices":[{"delta":{"content":"CK"},"finish_reason":"stop"}]}',
        'data: [DONE]',
        '',
      ].join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    });
  } finally {
    if (originalDebug === undefined) delete process.env.LIVE_AUDIT_DEBUG;
    else process.env.LIVE_AUDIT_DEBUG = originalDebug;
  }

  assert.equal(logs.some((line) => line.includes('=== [SSE RAW STREAM CUTTING SHAPES] ===')), true);
  assert.equal(logs.some((line) => line.includes('Total raw lines detected: 4')), true);
  assert.equal(logs.some((line) => line.includes('[Verdict Metadata] Total Chunks: 2, Non-Empty Chunks: 2')), true);
  assert.equal(logs.some((line) => line.includes('[Chunk 1] text="A"')), true);
});

test('nanoclaw bridge does not emit SSE chunk forensics when live audit debug is disabled', async (t) => {
  const originalDebug = process.env.LIVE_AUDIT_DEBUG;
  delete process.env.LIVE_AUDIT_DEBUG;
  const logs: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });

  try {
    const rawText = await callNanoclawModel('prompt-body', {
      config: {
        apiKey: 'nano-key',
        baseURL: 'https://nano.example/v1',
        model: 'gpt-5.4',
        provider: 'openai',
      },
      fetchImpl: async () => new Response('data: {"choices":[{"delta":{"content":"ACK"}}]}\n\ndata: [DONE]\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    });

    assert.equal(rawText, 'ACK');
  } finally {
    if (originalDebug === undefined) delete process.env.LIVE_AUDIT_DEBUG;
    else process.env.LIVE_AUDIT_DEBUG = originalDebug;
  }

  assert.deepEqual(logs, []);
});

