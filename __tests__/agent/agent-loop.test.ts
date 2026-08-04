import test from 'node:test';
import assert from 'node:assert/strict';
import { runResearchAgent } from '../../src/agent/agent-loop.ts';
import { LlmProviderError } from '../../src/llm/provider.ts';
import { OpenAiCompatibleProvider } from '../../src/llm/openai-compatible.ts';

function decisionJson(input: Record<string, any>): string {
  const searchActions = (input.searchActions ?? []).map((action: Record<string, unknown>) => ({ retry: false, ...action }));
  const fetchActions = (input.fetchActions ?? []).map((action: Record<string, unknown>) => ({ retry: false, ...action }));
  return JSON.stringify({ evidenceUrls: [], findings: [], ...input, searchActions, fetchActions });
}

test('rejects an explicitly non-tool-call provider before its first request', async () => {
  let modelCalls = 0;
  await assert.rejects(
    () => runResearchAgent({ question: 'capability gate' }, {
      llm: {
        structuredOutputMode: 'none',
        complete: async () => {
          modelCalls += 1;
          return { text: decisionJson({ decision: 'review', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: null }) };
        },
      },
      search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
      fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
    }),
    /requires a tool_call-capable LLM provider/i,
  );
  assert.equal(modelCalls, 0);
});

test('runs with an OpenAI-compatible provider that explicitly supports tool calls', async () => {
  let gatewayCalls = 0;
  const llm = new OpenAiCompatibleProvider({
    baseUrl: 'https://gateway.test/v1',
    apiKey: 'test-key',
    model: 'test-model',
    responseFormatMode: 'tool_call',
    fetchImpl: async () => {
      gatewayCalls += 1;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            tool_calls: [{
              function: {
                name: 'submit_research_decision',
                arguments: decisionJson({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'done' }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const result = await runResearchAgent({ question: 'tool capability' }, {
    llm,
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.state.finalAnswer, 'done');
  assert.equal(gatewayCalls, 1);
});

test('runs a generic search, fetch, and finish sequence', async () => {
  const outputs = [
    decisionJson({ decision: 'search', searchActions: [{ query: 'example fact' }], fetchActions: [], uncertainties: [], finalAnswer: null }),
    decisionJson({ decision: 'fetch', searchActions: [], fetchActions: [{ url: 'https://example.com/' }], uncertainties: [], finalAnswer: null }),
    decisionJson({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'verified' }),
  ];
  const result = await runResearchAgent({ question: 'Find an example fact', options: { maxIterations: 3 } }, {
    llm: { complete: async () => ({ text: outputs.shift()! }) },
    search: { name: 'fake-search', search: async (query) => ({ outcome: 'success_with_content', provider: 'fake-search', results: [{ query, title: 'Example', url: 'https://example.com/', snippet: 'fact', provider: 'fake-search' }], durationMs: 1, retryCount: 0 }) },
    fetch: { name: 'fake-fetch', fetch: async (url) => ({ outcome: 'success_with_content', requestedUrl: url, finalUrl: url, title: 'Example', content: 'fact', provider: 'fake-fetch', extractionWarnings: [], durationMs: 1, retryCount: 0 }) },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.state.finalAnswer, 'verified');
  assert.equal(result.state.currentIteration, 2);
  assert.equal(result.state.fetchedPages.length, 1);
});

test('requests the native decision tool instead of using text JSON as the primary command channel', async () => {
  let requestedTool: string | undefined;
  let requestedMessages: Array<{ role: string; content: string }> = [];
  await runResearchAgent({ question: 'x', options: { maxIterations: 1 } }, {
    llm: { complete: async (input) => { requestedTool = input.responseTool?.name; requestedMessages = input.messages; return { text: decisionJson({ decision: 'review', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: null }) }; } },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
  });
  assert.equal(requestedTool, 'submit_research_decision');
  assert.deepEqual(requestedMessages.map((message) => message.role), ['system', 'user', 'user']);
  assert.match(requestedMessages[0]!.content, /untrusted data/);
  assert.equal(JSON.parse(requestedMessages[1]!.content).task.question, 'x');
  assert.equal(JSON.parse(requestedMessages[2]!.content).dataClassification, 'untrusted_tool_data');
});

test('reports repeated malformed model output as protocol failure', async () => {
  const result = await runResearchAgent({ question: 'x' }, {
    llm: { complete: async () => ({ text: '{bad' }) },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.state.interrupted?.reason, 'protocol_error');
});

test('bounds protocol recovery and records a safe diagnostic preview', async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const prompts: string[] = [];
  let calls = 0;
  const result = await runResearchAgent({ question: 'x', options: { maxIterations: 100 } }, {
    llm: { complete: async ({ messages }) => { prompts.push(messages.map((message) => message.content).join('\n\n')); calls += 1; return { text: `bad response ${calls}` }; } },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.status, 'failed');
  assert.equal(calls, 2);
  const protocolErrors = events.filter((event) => event.type === 'agent.protocol_error');
  assert.equal(protocolErrors.length, 2);
  assert.equal(protocolErrors[1]?.payload.recoveryAttempt, 2);
  assert.equal(protocolErrors[1]?.payload.maxRecoveryAttempts, 2);
  assert.equal(protocolErrors[1]?.payload.rawPreview, 'bad response 2');
  assert.match(prompts[1]!, /Call submit_research_decision exactly once with corrected arguments/);
  assert.doesNotMatch(prompts[1]!, /Return exactly one valid JSON object/);
});

test('protocol recovery does not consume the only user research iteration', async () => {
  let calls = 0;
  const outputs = [
    'malformed',
    decisionJson({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'recovered', evidenceUrls: [], findings: [] }),
  ];
  const result = await runResearchAgent({ question: 'recover in same round', options: { maxIterations: 1 } }, {
    llm: { complete: async () => { calls += 1; return { text: outputs.shift()! }; } },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'completed');
  assert.equal(result.state.finalAnswer, 'recovered');
});

test('rounds mode executes the requested number of research rounds before a separate finish call', async () => {
  let calls = 0;
  const searches: string[] = [];
  const outputs = [
    decisionJson({ decision: 'search', searchActions: [{ query: 'round-1' }], fetchActions: [], uncertainties: [], finalAnswer: null }),
    decisionJson({ decision: 'search', searchActions: [{ query: 'round-2' }], fetchActions: [], uncertainties: [], finalAnswer: null }),
    decisionJson({ decision: 'search', searchActions: [{ query: 'round-3' }], fetchActions: [], uncertainties: [], finalAnswer: null }),
    decisionJson({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'three rounds done', evidenceUrls: [], findings: [] }),
  ];
  const result = await runResearchAgent({ question: 'three rounds', options: { completionMode: 'rounds', maxIterations: 3 } }, {
    llm: { complete: async () => { calls += 1; return { text: outputs.shift()! }; } },
    search: { name: 'fake', search: async (query) => { searches.push(query); return { outcome: 'success_empty', provider: 'fake', results: [], durationMs: 1, retryCount: 0 }; } },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
  });
  assert.equal(calls, 4);
  assert.deepEqual(searches, ['round-1', 'round-2', 'round-3']);
  assert.equal(result.state.currentIteration, 3);
  assert.equal(result.status, 'completed');
});

test('rounds mode remains bounded and completes after one hundred rounds plus one finish call', async () => {
  let modelCalls = 0;
  const result = await runResearchAgent({ question: 'long bounded research', options: { completionMode: 'rounds', maxIterations: 100 } }, {
    llm: { complete: async () => {
      modelCalls += 1;
      return {
        text: modelCalls <= 100
          ? decisionJson({ decision: 'review', searchActions: [], fetchActions: [], uncertainties: [`round-${modelCalls}`], finalAnswer: null })
          : decisionJson({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'one hundred rounds complete' }),
      };
    } },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.state.currentIteration, 100);
  assert.equal(result.state.decisions.length, 101);
  assert.equal(modelCalls, 101);
  assert.equal(result.state.finalAnswer, 'one hundred rounds complete');
});

test('preserves an honest partial finish answer when the round limit is reached below target', async () => {
  const outputs = [
    decisionJson({ decision: 'review', searchActions: [], fetchActions: [], uncertainties: ['no evidence found'], finalAnswer: null }),
    decisionJson({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: ['target unavailable'], finalAnswer: 'Only a partial result is available.', evidenceUrls: [], findings: [] }),
  ];
  const result = await runResearchAgent({ question: 'need ten', options: { completionMode: 'target_results', targetResultCount: 10, maxIterations: 1 } }, {
    llm: { complete: async () => ({ text: outputs.shift()! }) },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
  });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.state.interrupted?.reason, 'max_iterations');
  assert.equal(result.state.finalAnswer, 'Only a partial result is available.');
});

test('records every model response before parsing so a protocol failure can be replayed', async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const result = await runResearchAgent({ question: 'x' }, {
    llm: {
      complete: async () => ({
        text: '{"searchActions":[',
        model: 'gateway-model',
        finishReason: 'length',
        usage: { prompt_tokens: 12, completion_tokens: 34 },
        responseFormat: { type: 'json_schema', json_schema: { name: 'decision', strict: true, schema: { type: 'object' } } },
      }),
    },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.status, 'failed');
  const responses = events.filter((event) => event.type === 'agent.model_response');
  assert.equal(responses.length, 2);
  assert.deepEqual({ ...responses[0]?.payload, durationMs: 0 }, {
    iteration: 0,
    modelCall: 0,
    model: 'gateway-model',
    finishReason: 'length',
    usage: { prompt_tokens: 12, completion_tokens: 34 },
    responseFormat: 'json_schema',
    durationMs: 0,
    rawLength: 18,
    rawOutput: '{"searchActions":[',
  });
  assert.ok(Number(responses[0]?.payload.durationMs) >= 0);
  assert.equal(events.find((event) => event.type === 'agent.protocol_error')?.payload.finishReason, 'length');
});

test('bounds prompt transport context without ranking or selecting candidates by meaning', async () => {
  const prompts: string[] = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const outputs = [
    decisionJson({ decision: 'search', searchActions: [{ query: 'broad query' }], fetchActions: [], uncertainties: [], finalAnswer: null }),
    decisionJson({ decision: 'review', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: null }),
  ];
  await runResearchAgent({ question: 'bounded prompt', options: { maxIterations: 2 } }, {
    llm: { complete: async ({ messages }) => { prompts.push(messages.at(-1)!.content); return { text: outputs.shift()! }; } },
    search: {
      name: 'fake',
      search: async (query) => ({
        outcome: 'success_with_content', provider: 'fake', durationMs: 1, retryCount: 0,
        results: Array.from({ length: 30 }, (_, index) => ({ query, title: `candidate ${index}`, url: `https://example.com/${index}`, snippet: 'evidence '.repeat(500), provider: 'fake' })),
      }),
    },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
    onEvent: (event) => events.push(event),
  });

  assert.equal(prompts.length, 2);
  const context = JSON.parse(prompts[1]!);
  assert.equal(context.contextBudget.searchResultsTotal, 30);
  assert.ok(context.contextBudget.searchResultsIncluded < 30);
  assert.ok(context.contextBudget.searchResultsChars <= 12_000);
  assert.ok(context.searchResults.some((result: { url: string }) => result.url === 'https://example.com/0'));
  assert.ok(context.contextBudget.searchResultsIncluded < context.contextBudget.searchResultsTotal);
  const modelRequest = events.find((event) => event.type === 'agent.model_request' && event.payload.iteration === 1);
  assert.equal(modelRequest?.payload.responseFormat, 'tool_call');
  assert.ok(Number(modelRequest?.payload.promptLength) > prompts[1]!.length);
});

test('transports candidates fairly across all queries in a multi-search turn', async () => {
  const prompts: string[] = [];
  const queries = Array.from({ length: 8 }, (_, index) => `query-${index}`);
  const outputs = [
    decisionJson({ decision: 'search', searchActions: queries.map((query) => ({ query })), fetchActions: [], uncertainties: [], finalAnswer: null }),
    decisionJson({ decision: 'review', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: null }),
  ];
  await runResearchAgent({ question: 'fair transport', options: { maxIterations: 2 } }, {
    llm: { complete: async ({ messages }) => { prompts.push(messages.at(-1)!.content); return { text: outputs.shift()! }; } },
    search: { name: 'fake', search: async (query) => ({ outcome: 'success_with_content', provider: 'fake', durationMs: 1, retryCount: 0, results: Array.from({ length: 20 }, (_, index) => ({ query, title: `${query}-${index}`, url: `https://example.com/${query}/${index}`, snippet: 'x'.repeat(800), provider: 'fake' })) }) },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
  });

  const context = JSON.parse(prompts[1]!);
  assert.deepEqual([...new Set(context.searchResults.map((result: { query: string }) => result.query))].sort(), [...queries].sort());
  assert.equal(Object.keys(context.contextBudget.searchResultsByQuery).length, 8);
});

test('keeps all sixteen fetched-page records visible with explicit truncation metadata', async () => {
  const prompts: string[] = [];
  const urls = Array.from({ length: 16 }, (_, index) => `https://example.com/page-${index}`);
  const outputs = [
    decisionJson({ decision: 'fetch', searchActions: [], fetchActions: urls.slice(0, 8).map((url) => ({ url })), uncertainties: [], finalAnswer: null }),
    decisionJson({ decision: 'fetch', searchActions: [], fetchActions: urls.slice(8).map((url) => ({ url })), uncertainties: [], finalAnswer: null }),
    decisionJson({ decision: 'review', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: null }),
  ];
  await runResearchAgent({ question: 'preserve evidence', options: { maxIterations: 3 } }, {
    llm: { complete: async ({ messages }) => { prompts.push(messages.at(-1)!.content); return { text: outputs.shift()! }; } },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async (url) => ({ outcome: 'success_with_content', requestedUrl: url, finalUrl: url, title: url, content: 'proof '.repeat(1000), contentLength: 6000, truncated: false, renderMode: 'static', provider: 'fake', extractionWarnings: ['test-warning'], durationMs: 1, retryCount: 0 }) },
  });

  const context = JSON.parse(prompts[2]!);
  assert.equal(context.fetchedPages.length, 16);
  assert.equal(context.contextBudget.fetchedPagesIncluded, 16);
  assert.ok(context.fetchedPages.every((page: Record<string, unknown>) => page.contentLength === 6000 && page.contentTruncatedForContext === true && page.renderMode === 'static'));
});

test('bounds accumulated uncertainties and reports what was omitted', async () => {
  const prompts: string[] = [];
  const longUncertainties = Array.from({ length: 16 }, (_, index) => `${index}-${'x'.repeat(490)}`);
  const outputs = [
    decisionJson({ decision: 'review', searchActions: [], fetchActions: [], uncertainties: longUncertainties, finalAnswer: null }),
    decisionJson({ decision: 'review', searchActions: [], fetchActions: [], uncertainties: longUncertainties.map((item) => `b${item}`), finalAnswer: null }),
  ];
  await runResearchAgent({ question: 'bounded uncertainty', options: { maxIterations: 2 } }, {
    llm: { complete: async ({ messages }) => { prompts.push(messages.at(-1)!.content); return { text: outputs.shift()! }; } },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
  });

  const context = JSON.parse(prompts[1]!);
  assert.ok(context.contextBudget.uncertaintiesChars <= context.contextBudget.uncertaintiesMaxChars);
  assert.ok(context.contextBudget.uncertaintiesIncluded < context.contextBudget.uncertaintiesTotal);
});

test('shows the agent previously executed fetch URLs so it can avoid action loops', async () => {
  const prompts: string[] = [];
  const outputs = [
    decisionJson({ decision: 'fetch', searchActions: [], fetchActions: [{ url: 'https://example.com/evidence' }], uncertainties: [], finalAnswer: null }),
    decisionJson({ decision: 'review', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: null }),
  ];
  await runResearchAgent({ question: 'history', options: { maxIterations: 2 } }, {
    llm: { complete: async ({ messages }) => { prompts.push(messages.map((message) => message.content).join('\n\n')); return { text: outputs.shift()! }; } },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async (url) => ({ outcome: 'success_with_content', requestedUrl: url, finalUrl: url, title: 'Evidence', content: 'proof', provider: 'fake', extractionWarnings: [], durationMs: 1, retryCount: 0 }) },
  });

  const context = JSON.parse(prompts[1]!.split('\n\n').at(-1)!);
  assert.deepEqual(context.actionHistory.fetchUrls, ['https://example.com/evidence']);
  assert.equal(context.actionHistory.fetchActionCount, 1);
  assert.equal(context.actionHistory.uniqueFetchUrlCount, 1);
  assert.match(prompts[1]!, /Set retry=true only when deliberately repeating an exact action already listed in actionHistory/);
});

test('rejects a cross-turn duplicate action unless the agent explicitly marks it as a retry', async () => {
  const fetches: string[] = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const outputs = [
    decisionJson({ decision: 'fetch', searchActions: [], fetchActions: [{ url: 'https://example.com/evidence' }], uncertainties: [], finalAnswer: null }),
    decisionJson({ decision: 'fetch', searchActions: [], fetchActions: [{ url: 'https://example.com/evidence' }], uncertainties: [], finalAnswer: null }),
    decisionJson({ decision: 'review', searchActions: [], fetchActions: [], uncertainties: ['duplicate corrected'], finalAnswer: null }),
  ];

  await runResearchAgent({ question: 'no implicit retry', options: { maxIterations: 2 } }, {
    llm: { complete: async () => ({ text: outputs.shift()! }) },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: {
      name: 'fake',
      fetch: async (url) => {
        fetches.push(url);
        return { outcome: 'success_with_content', requestedUrl: url, finalUrl: url, title: 'Evidence', content: 'proof', provider: 'fake', extractionWarnings: [], durationMs: 1, retryCount: 0 };
      },
    },
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(fetches, ['https://example.com/evidence']);
  assert.equal(events.find((event) => event.type === 'agent.protocol_error')?.payload.code, 'RETRY_REQUIRED');
});

test('executes an intentional bounded retry and exposes retry intent in action history', async () => {
  const prompts: string[] = [];
  const fetches: string[] = [];
  const outputs = [
    decisionJson({ decision: 'fetch', searchActions: [], fetchActions: [{ url: 'https://example.com/evidence' }], uncertainties: [], finalAnswer: null }),
    decisionJson({ decision: 'fetch', searchActions: [], fetchActions: [{ url: 'https://example.com/evidence', retry: true }], uncertainties: ['retry after weak extraction'], finalAnswer: null }),
    decisionJson({ decision: 'review', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: null }),
  ];

  await runResearchAgent({ question: 'explicit retry', options: { maxIterations: 3 } }, {
    llm: { complete: async ({ messages }) => { prompts.push(messages.at(-1)!.content); return { text: outputs.shift()! }; } },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: {
      name: 'fake',
      fetch: async (url) => {
        fetches.push(url);
        return { outcome: 'success_with_content', requestedUrl: url, finalUrl: url, title: 'Evidence', content: 'proof', provider: 'fake', extractionWarnings: [], durationMs: 1, retryCount: 0 };
      },
    },
  });

  assert.deepEqual(fetches, ['https://example.com/evidence', 'https://example.com/evidence']);
  const thirdContext = JSON.parse(prompts[2]!);
  assert.deepEqual(thirdContext.actionHistory.fetchActions, [
    { url: 'https://example.com/evidence', retry: false },
    { url: 'https://example.com/evidence', retry: true },
  ]);
});

test('does not misclassify a generic LLM provider failure as a timeout', async () => {
  const result = await runResearchAgent({ question: 'x' }, {
    llm: { complete: async () => { throw new Error('gateway timeout'); } },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.state.interrupted?.reason, 'provider_error');
});

test('records provider transport attempts with iteration and model call correlation', async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  await runResearchAgent({ question: 'transport telemetry', options: { maxIterations: 1 } }, {
    llm: {
      complete: async (input) => {
        input.onTransportEvent?.({ type: 'attempt_started', attempt: 1, maxAttempts: 2 });
        input.onTransportEvent?.({ type: 'attempt_failed', attempt: 1, maxAttempts: 2, durationMs: 3, code: 'LLM_HTTP_ERROR', httpStatus: 503, requestId: 'req-1', retryable: true, errorSummary: 'busy' });
        input.onTransportEvent?.({ type: 'retry_scheduled', attempt: 1, maxAttempts: 2, delayMs: 4, retryAfterMs: 4 });
        input.onTransportEvent?.({ type: 'attempt_started', attempt: 2, maxAttempts: 2 });
        input.onTransportEvent?.({ type: 'attempt_succeeded', attempt: 2, maxAttempts: 2, durationMs: 5, httpStatus: 200, requestId: 'req-2' });
        return {
          text: decisionJson({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'done', evidenceUrls: [], findings: [] }),
          transportAttempts: 2,
          requestId: 'req-2',
          httpStatus: 200,
        };
      },
    },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
    onEvent: (event) => events.push(event),
  });

  const transport = events.filter((event) => event.type.startsWith('agent.model_transport_'));
  assert.deepEqual(transport.map((event) => event.type), [
    'agent.model_transport_attempt', 'agent.model_transport_result', 'agent.model_transport_retry',
    'agent.model_transport_attempt', 'agent.model_transport_result',
  ]);
  assert.ok(transport.every((event) => event.payload.iteration === 0 && event.payload.modelCall === 0));
  const response = events.find((event) => event.type === 'agent.model_response');
  assert.equal(response?.payload.modelCall, 0);
  assert.equal(response?.payload.requestId, 'req-2');
  assert.equal(response?.payload.httpStatus, 200);
});

test('classifies an attachment-style provider timeout as an interruption, never a protocol error', async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const timeout = new LlmProviderError('LLM_TIMEOUT', 'LLM request timed out');
  timeout.transportAttempts = 2;
  const result = await runResearchAgent({ question: 'timeout' }, {
    llm: { complete: async () => { throw timeout; } },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.status, 'interrupted');
  assert.equal(result.state.interrupted?.reason, 'timeout');
  assert.equal(events.some((event) => event.type === 'agent.protocol_error'), false);
  const modelError = events.find((event) => event.type === 'agent.model_error');
  assert.equal(modelError?.payload.code, 'MODEL_TIMEOUT');
  assert.equal(modelError?.payload.providerErrorCode, 'LLM_TIMEOUT');
  assert.equal(modelError?.payload.transportAttempts, 2);
});

test('discards a late model response when the provider ignores cancellation', async () => {
  const controller = new AbortController();
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let release!: () => void;
  const running = runResearchAgent({ question: 'cancelled request' }, {
    llm: {
      complete: async () => new Promise((resolve) => {
        release = () => resolve({
          text: decisionJson({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'late', evidenceUrls: [], findings: [] }),
          finishReason: 'tool_calls', structuredOutputMode: 'tool_call' as const, toolCallCount: 1,
        });
      }),
    },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
    onEvent: (event) => events.push(event),
  }, { signal: controller.signal });

  controller.abort(new Error('cancel now'));
  release();
  const result = await running;
  assert.equal(result.status, 'interrupted');
  assert.equal(result.state.interrupted?.reason, 'cancelled');
  assert.equal(result.state.finalAnswer, undefined);
  assert.equal(events.filter((event) => event.type === 'agent.model_response_discarded').length, 1);
  assert.equal(events.some((event) => event.type === 'agent.model_response'), false);
});

test('records and recovers a provider-level structured-output error as a protocol error', async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let calls = 0;
  const result = await runResearchAgent({ question: 'recover', options: { maxIterations: 1 } }, {
    llm: {
      complete: async () => {
        calls += 1;
        if (calls === 1) return {
          text: '{"tool_calls":[{},{}]}',
          structuredOutputMode: 'tool_call' as const,
          toolCallCount: 2,
          protocolError: { code: 'INVALID_TOOL_CALL', message: 'Expected exactly one submit_research_decision call.' },
        };
        return { text: decisionJson({ decision: 'review', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: null }) };
      },
    },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
    onEvent: (event) => events.push(event),
  });

  assert.equal(calls, 2);
  assert.equal(result.state.interrupted?.reason, 'max_iterations');
  assert.equal(events.find((event) => event.type === 'agent.model_response')?.payload.toolCallCount, 2);
  assert.equal(events.find((event) => event.type === 'agent.protocol_error')?.payload.code, 'INVALID_TOOL_CALL');
});

test('rejects a truncated finish response instead of completing the run', async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const result = await runResearchAgent({ question: 'truncated', options: { maxIterations: 2 } }, {
    llm: { complete: async () => ({
      text: decisionJson({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'looks complete' }),
      finishReason: 'length',
      structuredOutputMode: 'tool_call' as const,
      toolCallCount: 1,
    }) },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.state.interrupted?.reason, 'protocol_error');
  assert.equal(events.find((event) => event.type === 'agent.protocol_error')?.payload.code, 'INCOMPLETE_MODEL_RESPONSE');
});

test('rejects a response above the caller action budget and only executes a compliant recovery decision', async () => {
  const searches: string[] = [];
  const fetches: string[] = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const outputs = [
    decisionJson({ decision: 'search', searchActions: [{ query: 'one' }, { query: 'two' }], fetchActions: [], uncertainties: [], finalAnswer: null }),
    decisionJson({ decision: 'search', searchActions: [{ query: 'one' }], fetchActions: [], uncertainties: [], finalAnswer: null }),
  ];
  const result = await runResearchAgent({ question: 'bounded', options: { maxIterations: 1, maxSearchActionsPerTurn: 1, maxFetchActionsPerTurn: 1 } }, {
    llm: { complete: async () => ({ text: outputs.shift()! }) },
    search: { name: 'fake', search: async (query) => { searches.push(query); return { outcome: 'success_empty', provider: 'fake', results: [], durationMs: 1, retryCount: 0 }; } },
    fetch: { name: 'fake', fetch: async (url) => { fetches.push(url); throw new Error('must not fetch'); } },
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(searches, ['one']);
  assert.deepEqual(fetches, []);
  assert.equal(events.find((event) => event.type === 'agent.protocol_error')?.payload.code, 'ACTION_BUDGET_EXCEEDED');
  assert.equal(result.state.interrupted?.reason, 'max_iterations');
});

test('target-results mode counts unique canonical URLs', async () => {
  const outputs = [
    decisionJson({ decision: 'search', searchActions: [{ query: 'first' }], fetchActions: [], uncertainties: [], finalAnswer: null }),
    decisionJson({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'done' }),
  ];
  const result = await runResearchAgent({ question: 'unique target', options: { completionMode: 'target_results', targetResultCount: 2, maxIterations: 1 } }, {
    llm: { complete: async () => ({ text: outputs.shift()! }) },
    search: { name: 'fake', search: async (query) => ({ outcome: 'success_with_content', provider: 'fake', results: [{ query, title: 'same', url: 'https://example.com/page/?utm_source=test', snippet: 'x', provider: 'fake' }, { query, title: 'same again', url: 'https://example.com/page', snippet: 'x', provider: 'fake' }], durationMs: 1, retryCount: 0 }) },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
  });
  assert.equal(result.status, 'interrupted');
  assert.match(result.state.uncertainties.join(' '), /confirmed findings/);
});

test('evidence-required target cannot complete from search discovery alone', async () => {
  const outputs = [
    decisionJson({ decision: 'search', searchActions: [{ query: 'official beta' }], fetchActions: [], uncertainties: [], finalAnswer: null }),
    decisionJson({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'unverified' }),
  ];
  const result = await runResearchAgent({ question: 'Find verified beta', options: { completionMode: 'target_results', targetResultCount: 1, evidenceRequired: true, minFetchedPages: 1, maxIterations: 1 } }, {
    llm: { complete: async () => ({ text: outputs.shift()! }) },
    search: { name: 'fake', search: async (query) => ({ outcome: 'success_with_content', provider: 'fake', results: [{ query, title: 'Beta', url: 'https://example.com/beta', snippet: 'beta', provider: 'fake' }], durationMs: 1, retryCount: 0 }) },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not auto-fetch'); } },
  });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.state.fetchedPages.length, 0);
  assert.match(result.state.uncertainties.join(' '), /evidence-bound findings/);
});

test('evidence-required target cannot complete from a fetched page the agent did not cite', async () => {
  const outputs = [
    decisionJson({ decision: 'fetch', searchActions: [], fetchActions: [{ url: 'https://example.com/source' }], uncertainties: [], finalAnswer: null }),
    decisionJson({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'unsupported', evidenceUrls: [] }),
  ];
  const result = await runResearchAgent({ question: 'Find verified evidence', options: { evidenceRequired: true, minFetchedPages: 1, maxIterations: 1 } }, {
    llm: { complete: async () => ({ text: outputs.shift()! }) },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async (url) => ({ outcome: 'success_with_content', requestedUrl: url, finalUrl: 'https://www.example.com/source/', title: 'Source', content: 'evidence', provider: 'fake', extractionWarnings: [], durationMs: 1, retryCount: 0 }) },
  });
  assert.equal(result.status, 'interrupted');
  assert.match(result.state.uncertainties.join(' '), /cited fetched evidence/);
});

test('evidence-required target completes only when finish cites a successfully fetched URL', async () => {
  const outputs = [
    decisionJson({ decision: 'fetch', searchActions: [], fetchActions: [{ url: 'https://example.com/source' }], uncertainties: [], finalAnswer: null }),
    decisionJson({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'supported', evidenceUrls: ['https://www.example.com/source/#proof'], findings: [{ id: 'fact-1', claim: 'supported fact', disposition: 'confirmed', evidenceUrls: ['https://www.example.com/source/#proof'] }] }),
  ];
  const result = await runResearchAgent({ question: 'Find verified evidence', options: { evidenceRequired: true, minFetchedPages: 1, maxIterations: 2 } }, {
    llm: { complete: async () => ({ text: outputs.shift()! }) },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async (url) => ({ outcome: 'success_with_content', requestedUrl: url, finalUrl: 'https://www.example.com/source/', title: 'Source', content: 'evidence', provider: 'fake', extractionWarnings: [], durationMs: 1, retryCount: 0 }) },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.decision.evidenceUrls, ['https://www.example.com/source/#proof']);
});

test('does not treat ten cited URLs as ten target results when the agent submits only one finding', async () => {
  const urls = Array.from({ length: 10 }, (_, index) => `https://example.com/${index}`);
  const outputs = [
    decisionJson({ decision: 'fetch', searchActions: [], fetchActions: urls.slice(0, 8).map((url) => ({ url })), uncertainties: [], finalAnswer: null }),
    decisionJson({ decision: 'fetch', searchActions: [], fetchActions: urls.slice(8).map((url) => ({ url })), uncertainties: [], finalAnswer: null }),
    decisionJson({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'only one result', evidenceUrls: urls, findings: [{ id: 'only-one', claim: 'one finding', disposition: 'confirmed', evidenceUrls: urls }] }),
  ];
  const result = await runResearchAgent({ question: 'ten findings', options: { completionMode: 'target_results', targetResultCount: 10, evidenceRequired: true, minFetchedPages: 10, maxIterations: 2 } }, {
    llm: { complete: async () => ({ text: outputs.shift()! }) },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async (url) => ({ outcome: 'success_with_content', requestedUrl: url, finalUrl: url, title: url, content: 'proof', provider: 'fake', extractionWarnings: [], durationMs: 1, retryCount: 0 }) },
  });
  assert.equal(result.status, 'interrupted');
  assert.match(result.state.uncertainties.join(' '), /findings/);
});

test('completes a ten-result target only with ten evidence-bound findings and ten fetched sources', async () => {
  const urls = Array.from({ length: 10 }, (_, index) => `https://example.com/${index}`);
  const findings = urls.map((url, index) => ({ id: `finding-${index}`, claim: `supported fact ${index}`, disposition: 'confirmed' as const, evidenceUrls: [url] }));
  const outputs = [
    decisionJson({ decision: 'fetch', searchActions: [], fetchActions: urls.slice(0, 8).map((url) => ({ url })), uncertainties: [], finalAnswer: null }),
    decisionJson({ decision: 'fetch', searchActions: [], fetchActions: urls.slice(8).map((url) => ({ url })), uncertainties: [], finalAnswer: null }),
    decisionJson({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'ten supported results', evidenceUrls: urls, findings }),
  ];
  const result = await runResearchAgent({ question: 'ten findings', options: { completionMode: 'target_results', targetResultCount: 10, evidenceRequired: true, minFetchedPages: 10, maxIterations: 3 } }, {
    llm: { complete: async () => ({ text: outputs.shift()! }) },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async (url) => ({ outcome: 'success_with_content', requestedUrl: url, finalUrl: url, title: url, content: 'proof', provider: 'fake', extractionWarnings: [], durationMs: 1, retryCount: 0 }) },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.decision.findings?.length, 10);
});

test('bounds repeated incomplete finish decisions and preserves the partial answer', async () => {
  let calls = 0;
  const result = await runResearchAgent({ question: 'avoid a no-progress finish loop', options: { completionMode: 'target_results', targetResultCount: 10, maxIterations: 100 } }, {
    llm: { complete: async () => {
      calls += 1;
      return { text: decisionJson({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: ['not enough reliable evidence'], finalAnswer: 'Only a partial result is available.', evidenceUrls: [], findings: [] }) };
    } },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.state.interrupted?.reason, 'completion_not_reached');
  assert.equal(result.state.finalAnswer, 'Only a partial result is available.');
  assert.equal(result.state.decisions.length, 2);
});

test('target-results mode counts only agent-classified confirmed findings', async () => {
  let calls = 0;
  const finish = decisionJson({
    decision: 'finish', searchActions: [], fetchActions: [], uncertainties: ['one lead is not confirmed'], finalAnswer: 'One confirmed result and one lead.', evidenceUrls: [],
    findings: [
      { id: 'confirmed', claim: 'verified result', disposition: 'confirmed', evidenceUrls: [] },
      { id: 'uncertain', claim: 'unverified lead', disposition: 'uncertain', evidenceUrls: [] },
    ],
  });
  const result = await runResearchAgent({ question: 'need two confirmed results', options: { completionMode: 'target_results', targetResultCount: 2, maxIterations: 100 } }, {
    llm: { complete: async () => { calls += 1; return { text: finish }; } },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.state.interrupted?.reason, 'completion_not_reached');
  assert.match(result.state.interrupted?.message ?? '', /1\/2 confirmed findings/);
});
