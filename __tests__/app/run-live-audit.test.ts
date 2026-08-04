import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';

import {
  createLiveAuditRuntime,
  parseLiveAuditMaxIterations,
  runLiveAudit,
  runLiveAuditPreflight,
  shouldBypassEmptyResponse,
  type LiveAuditEnv,
} from '../../src/app/live-audit-runtime.ts';
import { formatLiveAuditDebugEvent, main } from '../../src/app/run-live-audit.ts';
import { NanoclawEmptyResponseError } from '../../src/runtime/nanoclaw-bridge.ts';

test('parseLiveAuditMaxIterations accepts a finite positive integer', () => {
  assert.equal(parseLiveAuditMaxIterations('4'), 4);
  assert.equal(parseLiveAuditMaxIterations('01'), 1);
});

test('shouldBypassEmptyResponse allows structurally valid empty 200 responses and rejects broken diagnostics', () => {
  assert.equal(shouldBypassEmptyResponse({
    responseMetrics: {
      status: 200,
    },
    responseFeatures: {
      hasChoicesArray: true,
      hasTextContent: false,
      messageFieldPresent: true,
      contentFieldPresent: true,
      rawTopLevelKeys: ['choices', 'id', 'model', 'usage'],
    },
  }), true);

  assert.equal(shouldBypassEmptyResponse({
    status: 200,
    hasChoices: true,
    hasContent: false,
    structuralHints: ['choices[0].message present', 'choices[0].message.content present'],
    topLevelKeys: ['choices', 'id', 'model', 'usage'],
  }), true);

  assert.equal(shouldBypassEmptyResponse({
    status: 500,
    hasChoices: false,
    hasContent: false,
    structuralHints: ['choices missing'],
    topLevelKeys: [],
  }), false);
});


test('createLiveAuditRuntime routes live model calls through the resolved NanoClaw runtime config', async () => {
  const env: LiveAuditEnv = {
    LIVE_AUDIT_TOPIC: '黑龙江高企租金减免',
    LIVE_AUDIT_MAX_ITERATIONS: '3',
  };

  const resolvedConfig = {
    apiKey: 'test-key',
    baseURL: 'https://nanoclaw.example/messages',
    model: 'claude-opus-4-8',
    provider: 'anthropic' as const,
  };

  const seenPrompts: string[] = [];
  let seenConfig: unknown;

  const runtime = createLiveAuditRuntime(env, {
    resolveConfig: () => resolvedConfig,
    callNanoclawModel: async (prompt, options) => {
      seenPrompts.push(prompt);
      seenConfig = options?.config;
      return '{"decision":"stop","reasoning":"ok","searchActions":[],"fetchActions":[],"uncertainties":[],"discardedLeads":[]}';
    },
  });

  const response = await runtime.callModel('prompt-body');

  assert.equal(runtime.topic, '黑龙江高企租金减免');
  assert.equal(runtime.maxIterations, 3);
  assert.deepEqual(seenPrompts, ['prompt-body']);
  assert.equal(seenConfig, resolvedConfig);
  assert.match(response, /"decision":"stop"/);
});

test('createLiveAuditRuntime defers NanoClaw transport validation to the explicit preflight gate', async () => {
  const calls: string[] = [];

  const runtime = createLiveAuditRuntime(
    {
      LIVE_AUDIT_TOPIC: '预检测试',
      LIVE_AUDIT_MAX_ITERATIONS: '2',
    },
    {
      resolveConfig: () => {
        calls.push('resolveConfig');
        throw new Error('missing live config');
      },
    },
  );

  assert.deepEqual(calls, []);

  await assert.rejects(
    () => runLiveAuditPreflight(runtime),
    /Live audit preflight failed before entering runPolicyTaskLoop: missing live config/,
  );

  assert.deepEqual(calls, ['resolveConfig']);
});


test('runLiveAudit records a preflight network failure and never enters the policy loop', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-live-audit-preflight-network-'));
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let loopCalls = 0;
  const runtime = createLiveAuditRuntime(
    {
      LIVE_AUDIT_TOPIC: '预检网络失败测试',
      LIVE_AUDIT_MAX_ITERATIONS: '2',
      LIVE_AUDIT_OUTPUT_DIR: outputDir,
      NANOCLAW_API_KEY: 'test-key',
      NANOCLAW_BASE_URL: 'https://nanoclaw.example/messages',
      NANOCLAW_LLM_PROVIDER: 'anthropic',
      POLICY_AGENT_LLM_MODEL: 'claude-opus-4-8',
    },
    {
      resolveConfig: () => ({
        apiKey: 'test-key',
        baseURL: 'https://nanoclaw.example/messages',
        model: 'claude-opus-4-8',
        provider: 'anthropic' as const,
      }),
      probeGatewayModels: async () => ({
        endpoint: 'https://nanoclaw.example/models',
        ok: true,
        status: 200,
        statusText: 'OK',
        contentType: 'application/json',
        topLevelKeys: ['data'],
        dataCount: 1,
        sampleModelIds: ['claude-opus-4-8'],
        includesConfiguredModel: true,
        configuredModel: 'claude-opus-4-8',
      }),
      callNanoclawModel: async () => {
        throw new Error('ECONNRESET during preflight');
      },
      onDebugEvent: (event) => {
        events.push(event);
      },
    },
  );

  await assert.rejects(
    () => runLiveAudit(runtime, {
      runPolicyTaskLoop: async () => {
        loopCalls += 1;
        throw new Error('loop must not run');
      },
    }),
    /Live audit preflight failed before entering runPolicyTaskLoop: ECONNRESET during preflight/,
  );

  assert.equal(loopCalls, 0);
  assert.equal(events.some((event) => event.type === 'live_audit.preflight.error'), true);
  assert.equal(events.some((event) => event.type === 'run.failure'), true);
  const trace = JSON.parse(await readFile(path.join(outputDir, 'debug-trace.json'), 'utf8')) as {
    events?: Array<{ type: string; payload: Record<string, unknown> }>;
  };
  assert.equal(trace.events?.some((event) => event.type === 'live_audit.preflight.error'), true);
  assert.equal(trace.events?.some((event) => event.type === 'run.failure'), true);
  assert.equal(trace.events?.some((event) => event.type === 'live_audit.preflight.ok'), false);
});
test('runLiveAuditPreflight retries transient failures and enters the policy loop after recovery', async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let calls = 0;
  const runtime = {
    topic: '预检恢复测试',
    maxIterations: 1,
    outputDir: await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-preflight-retry-')),
    fromDate: '2026-01-01',
    toDate: '2026-01-02',
    targetHotspotCount: 1,
    hotspotOnly: true,
    enableBrowser: false,
    runTimeoutMs: 5000,
    preflightRetryAttempts: 1,
    preflightRetryDelayMs: 0,
    resolvePreflightProvenance: async () => ({
      transport: 'nanoclaw' as const,
      provider: 'anthropic' as const,
      providerMode: 'inferred' as const,
      model: 'test-model',
      effectiveBaseURL: 'https://example.test',
      presentEnvKeys: [],
      gateway: {} as never,
    }),
    callModel: async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNRESET transient');
      return 'ok';
    },
    onDebugEvent: (event: { type: string; payload: Record<string, unknown> }) => events.push(event),
    onShellDebugEvent: () => {},
  };

  await runLiveAuditPreflight(runtime);
  assert.equal(calls, 2);
  assert.equal(events.some((event) => event.type === 'live_audit.preflight.retry'), true);
  assert.equal(events.some((event) => event.type === 'live_audit.preflight.ok'), true);
});

test('runLiveAuditPreflight does not retry permanent failures', async () => {
  let calls = 0;
  const runtime = {
    topic: '预检永久失败测试', maxIterations: 1, outputDir: await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-preflight-permanent-')),
    fromDate: '2026-01-01', toDate: '2026-01-02', targetHotspotCount: 1, hotspotOnly: true, enableBrowser: false,
    runTimeoutMs: 5000, preflightRetryAttempts: 3, preflightRetryDelayMs: 0,
    resolvePreflightProvenance: async () => ({ transport: 'nanoclaw' as const, provider: 'anthropic' as const, providerMode: 'inferred' as const, model: 'test-model', effectiveBaseURL: 'https://example.test', presentEnvKeys: [], gateway: {} as never }),
    callModel: async () => { calls += 1; throw new Error('invalid credentials'); }, onDebugEvent: () => {}, onShellDebugEvent: () => {},
  };
  await assert.rejects(() => runLiveAuditPreflight(runtime), /invalid credentials/);
  assert.equal(calls, 1);
});

test('runLiveAudit persists complete model output separately from debug trace', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-raw-output-'));
  const rawText = '{"decision":"stop","reasoning":"raw secret-like payload","searchActions":[],"fetchActions":[],"uncertainties":[],"discardedLeads":[]}';
  const runtime = createLiveAuditRuntime({
    LIVE_AUDIT_TOPIC: 'raw output persistence',
    LIVE_AUDIT_MAX_ITERATIONS: '1',
    LIVE_AUDIT_OUTPUT_DIR: outputDir,
  }, {
    resolveConfig: () => ({ apiKey: 'test-key', baseURL: 'https://example.test', model: 'test-model', provider: 'anthropic' }),
    probeGatewayModels: async () => ({
      endpoint: 'https://example.test/models', ok: true, status: 200, statusText: 'OK', contentType: 'application/json',
      topLevelKeys: ['data'], dataCount: 1, sampleModelIds: ['test-model'], includesConfiguredModel: true, configuredModel: 'test-model',
    }),
    callNanoclawModel: async (prompt) => prompt === '__live_audit_preflight__' ? 'ok' : rawText,
  });

  await runLiveAudit(runtime, {
    runPolicyTaskLoop: async (_input, options) => {
      await options.onRawModelOutput?.(rawText);
      return {
        task: { topic: runtime.topic }, discoveredCandidates: [], fetchedEvidence: [], currentIteration: 1,
        uncertainties: [], targetHotspotCount: 1, targetValidatedEvidenceCount: 0,
        decision: { decision: 'stop', reasoning: 'done', searchActions: [], fetchActions: [], uncertainties: [], discardedLeads: [] },
      };
    },
  });

  const files = (await readdir(outputDir)).filter((file) => file.startsWith('model-raw-'));
  assert.deepEqual(files, ['model-raw-0001.txt']);
  assert.equal(await readFile(path.join(outputDir, files[0]!), 'utf8'), rawText);
  const trace = JSON.parse(await readFile(path.join(outputDir, 'debug-trace.json'), 'utf8')) as { events?: Array<{ type: string; payload?: Record<string, unknown> }> };
  const persisted = trace.events?.find((event) => event.type === 'model.raw_output.persisted');
  assert.equal(persisted?.payload?.fileName, 'model-raw-0001.txt');
  assert.equal('rawText' in (persisted?.payload ?? {}), false);
  assert.equal(JSON.stringify(trace).includes(rawText), false);
});


test('runLiveAudit times out a hanging policy loop', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-live-audit-timeout-'));
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const runtime = createLiveAuditRuntime({
    LIVE_AUDIT_TOPIC: '运行超时测试',
    LIVE_AUDIT_MAX_ITERATIONS: '2',
    LIVE_AUDIT_RUN_TIMEOUT_MS: '25',
    LIVE_AUDIT_OUTPUT_DIR: outputDir,
    NANOCLAW_API_KEY: 'test-key',
    NANOCLAW_BASE_URL: 'https://nanoclaw.example/messages',
    NANOCLAW_LLM_PROVIDER: 'anthropic',
    POLICY_AGENT_LLM_MODEL: 'claude-opus-4-8',
  }, {
    resolveConfig: () => ({
      apiKey: 'test-key',
      baseURL: 'https://nanoclaw.example/messages',
      model: 'claude-opus-4-8',
      provider: 'anthropic' as const,
    }),
    probeGatewayModels: async () => ({
      endpoint: 'https://nanoclaw.example/models',
      ok: true,
      status: 200,
      statusText: 'OK',
      contentType: 'application/json',
      topLevelKeys: ['data'],
      dataCount: 1,
      sampleModelIds: ['claude-opus-4-8'],
      includesConfiguredModel: true,
      configuredModel: 'claude-opus-4-8',
    }),
    callNanoclawModel: async () => '{"decision":"stop","reasoning":"ok","searchActions":[],"fetchActions":[],"uncertainties":[],"discardedLeads":[]}',
    onDebugEvent: (event) => events.push(event),
  });

  await assert.rejects(
    () => runLiveAudit(runtime, {
      runPolicyTaskLoop: async () => await new Promise(() => {}),
    }),
    /live-audit:run timed out after 25ms/,
  );
  assert.equal(events.some((event) => event.type === 'live_audit.run.timeout'), true);
});

test('runLiveAuditPreflight bypasses structurally valid empty Nanoclaw responses and emits a warning', async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const diagnostics = {
    traceId: 'trace-preflight',
    shapeType: 'GENUINE_EMPTY',
    finishReason: 'missing',
    refusal: 'none',
    streamModeDetected: false,
    requestMetrics: {
      bodyBytes: 87,
      promptChars: 24,
      messageCount: 1,
      model: 'gpt-5.4',
      stream: false,
      maxTokens: null,
      temperature: null,
      responseFormat: null,
    },
    responseMetrics: {
      status: 200,
      bodyBytes: 52,
      topLevelKeys: ['choices', 'id', 'model', 'usage'],
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
      rawTopLevelKeys: ['choices', 'id', 'model', 'usage'],
    },
  };

  await runLiveAuditPreflight({
    topic: '空文本放行测试',
    maxIterations: 2,
    resolvePreflightProvenance: async () => ({
      transport: 'nanoclaw',
      provider: 'openai',
      providerMode: 'explicit',
      model: 'gpt-5.4',
      effectiveBaseURL: 'https://nanoclaw.example/v1',
      presentEnvKeys: ['NANOCLAW_BASE_URL'],
      gateway: {
        endpoint: 'https://nanoclaw.example/v1/models',
        ok: true,
        status: 200,
        statusText: 'OK',
        contentType: 'application/json',
        topLevelKeys: ['data', 'object'],
        dataCount: 1,
        sampleModelIds: ['gpt-5.4'],
        includesConfiguredModel: true,
        configuredModel: 'gpt-5.4',
      },
    }),
    callModel: async () => {
      throw new NanoclawEmptyResponseError(diagnostics);
    },
    onDebugEvent: (event) => {
      events.push(event);
    },
    onShellDebugEvent: () => {},
    outputDir: path.join(os.tmpdir(), 'local-policy-agent-live-audit-preflight-warning'),
  });

  assert.deepEqual(events.map((event) => event.type), [
    'live_audit.preflight.start',
    'live_audit.preflight.provenance',
    'live_audit.preflight.warning',
  ]);
  assert.equal(events[2]?.payload.bypassedEmptyResponse, true);
  assert.equal('message' in (events[2]?.payload ?? {}), false);
  assert.equal('diagnostics' in (events[2]?.payload ?? {}), false);
});

test('runLiveAuditPreflight validates the NanoClaw-backed runtime path before the loop starts', async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

  await runLiveAuditPreflight({
    topic: '网关探针测试',
    maxIterations: 2,
    resolvePreflightProvenance: async () => ({
      transport: 'nanoclaw',
      provider: 'anthropic',
      providerMode: 'inferred',
      model: 'claude-opus-4-8',
      effectiveBaseURL: 'https://nanoclaw.example/messages',
      presentEnvKeys: ['NANOCLAW_BASE_URL'],
      gateway: {
        endpoint: 'https://nanoclaw.example/models',
        ok: true,
        status: 200,
        statusText: 'OK',
        contentType: 'application/json',
        topLevelKeys: ['data', 'object'],
        dataCount: 2,
        sampleModelIds: ['claude-opus-4-8', 'claude-sonnet-4-5'],
        includesConfiguredModel: true,
        configuredModel: 'claude-opus-4-8',
      },
    }),
    callModel: async (prompt) => {
      assert.equal(prompt, '__live_audit_preflight__');
      return '{"decision":"stop","reasoning":"ok","searchActions":[],"fetchActions":[],"uncertainties":[],"discardedLeads":[]}';
    },
    onDebugEvent: (event) => {
      events.push(event);
    },
    onShellDebugEvent: () => {},
    outputDir: path.join(os.tmpdir(), 'local-policy-agent-live-audit-gateway-probe-ok'),
  });

  assert.deepEqual(events, [
    {
      type: 'live_audit.preflight.start',
      payload: {
        topic: '网关探针测试',
        maxIterations: 2,
      },
    },
    {
      type: 'live_audit.preflight.provenance',
      payload: {
        topic: '网关探针测试',
        maxIterations: 2,
        transport: 'nanoclaw',
        provider: 'anthropic',
        providerMode: 'inferred',
        model: 'claude-opus-4-8',
        effectiveBaseURL: 'https://nanoclaw.example/messages',
        presentEnvKeys: ['NANOCLAW_BASE_URL'],
        gateway: {
          endpoint: 'https://nanoclaw.example/models',
          ok: true,
          status: 200,
          statusText: 'OK',
          contentType: 'application/json',
          topLevelKeys: ['data', 'object'],
          dataCount: 2,
          sampleModelIds: ['claude-opus-4-8', 'claude-sonnet-4-5'],
          includesConfiguredModel: true,
          configuredModel: 'claude-opus-4-8',
        },
      },
    },
    {
      type: 'live_audit.preflight.ok',
      payload: {
        topic: '网关探针测试',
        maxIterations: 2,
      },
    },
  ]);
});

test('createLiveAuditRuntime resolves sanitized gateway intelligence alongside transport provenance', async () => {
  const runtime = createLiveAuditRuntime(
    {
      LIVE_AUDIT_TOPIC: '预检测试',
      LIVE_AUDIT_MAX_ITERATIONS: '2',
      NANOCLAW_API_KEY: 'nano-secret',
      NANOCLAW_BASE_URL: 'https://user:secret@nanoclaw.example/messages?api_key=hidden#frag',
      NANOCLAW_LLM_PROVIDER: 'anthropic',
      POLICY_AGENT_LLM_MODEL: 'claude-opus-4-8',
    },
    {
      resolveConfig: () => ({
        apiKey: 'nano-secret',
        baseURL: 'https://user:secret@nanoclaw.example/messages?api_key=hidden#frag',
        model: 'claude-opus-4-8',
        provider: 'anthropic',
      }),
      probeGatewayModels: async () => ({
        endpoint: 'https://nanoclaw.example/models',
        ok: true,
        status: 200,
        statusText: 'OK',
        contentType: 'application/json',
        topLevelKeys: ['data', 'object'],
        dataCount: 1,
        sampleModelIds: ['claude-opus-4-8'],
        includesConfiguredModel: true,
        configuredModel: 'claude-opus-4-8',
      }),
    },
  );

  assert.deepEqual(await runtime.resolvePreflightProvenance(), {
    transport: 'nanoclaw',
    provider: 'anthropic',
    providerMode: 'explicit',
    model: 'claude-opus-4-8',
    effectiveBaseURL: 'https://nanoclaw.example/messages',
    presentEnvKeys: [
      'NANOCLAW_API_KEY',
      'NANOCLAW_BASE_URL',
      'NANOCLAW_LLM_PROVIDER',
      'POLICY_AGENT_LLM_MODEL',
    ],
    gateway: {
      endpoint: 'https://nanoclaw.example/models',
      ok: true,
      status: 200,
      statusText: 'OK',
      contentType: 'application/json',
      topLevelKeys: ['data', 'object'],
      dataCount: 1,
      sampleModelIds: ['claude-opus-4-8'],
      includesConfiguredModel: true,
      configuredModel: 'claude-opus-4-8',
    },
  });
});

test('runLiveAudit preserves the original runtime error when trace persistence fails during failure handling', async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-live-audit-trace-failure-'));
  const shellEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const originalRenameSync = fs.renameSync.bind(fs);
  let renameCalls = 0;

  t.mock.method(fs, 'renameSync', (oldPath: fs.PathLike, newPath: fs.PathLike) => {
    renameCalls += 1;
    if (renameCalls >= 6 && String(newPath).endsWith('debug-trace.json')) {
      throw new Error('trace rename exploded');
    }
    return originalRenameSync(oldPath, newPath);
  });

  const runtime = createLiveAuditRuntime(
    {
      LIVE_AUDIT_TOPIC: '错误保留测试',
      LIVE_AUDIT_MAX_ITERATIONS: '2',
      LIVE_AUDIT_OUTPUT_DIR: outputDir,
    },
    {
      resolveConfig: () => ({
        apiKey: 'test-key',
        baseURL: 'https://nanoclaw.example/messages',
        model: 'claude-opus-4-8',
        provider: 'anthropic',
      }),
      probeGatewayModels: async () => ({
        endpoint: 'https://nanoclaw.example/models',
        ok: true,
        status: 200,
        statusText: 'OK',
        contentType: 'application/json',
        topLevelKeys: ['data'],
        dataCount: 1,
        sampleModelIds: ['claude-opus-4-8'],
        includesConfiguredModel: true,
        configuredModel: 'claude-opus-4-8',
      }),
      callNanoclawModel: async () => '{"decision":"stop","reasoning":"ok","searchActions":[],"fetchActions":[],"uncertainties":[],"discardedLeads":[]}',
      onDebugEvent: (event) => {
        shellEvents.push(event);
      },
    },
  );

  const originalError = new Error('upstream loop exploded');

  await assert.rejects(
    () => runLiveAudit(runtime, {
      runPolicyTaskLoop: async () => {
        throw originalError;
      },
    }),
    (error) => {
      assert.equal(error, originalError);
      return true;
    },
  );

  assert.equal(shellEvents.some((event) => event.type === 'debug_trace.write_error'), true);
  const traceWriteEvent = shellEvents.find((event) => event.type === 'debug_trace.write_error');
  assert.equal(traceWriteEvent?.payload.tracePath, path.join(outputDir, 'debug-trace.json'));
  assert.equal(traceWriteEvent?.payload.failedEventType, 'run.failure');
  const originalErrorProjection = traceWriteEvent?.payload.originalError as Record<string, unknown> | undefined;
  assert.equal(originalErrorProjection?.name, 'Error');
  assert.equal('message' in (originalErrorProjection ?? {}), false);
  assert.equal('stack' in (originalErrorProjection ?? {}), false);
  assert.equal('diagnostics' in (originalErrorProjection ?? {}), false);
  assert.equal((traceWriteEvent?.payload.traceWriteError as { name?: string }).name, 'Error');
  assert.equal('message' in ((traceWriteEvent?.payload.traceWriteError ?? {}) as Record<string, unknown>), false);
  assert.equal('stack' in ((traceWriteEvent?.payload.traceWriteError ?? {}) as Record<string, unknown>), false);
  assert.equal('diagnostics' in ((traceWriteEvent?.payload.traceWriteError ?? {}) as Record<string, unknown>), false);

  const debugTrace = JSON.parse(await readFile(path.join(outputDir, 'debug-trace.json'), 'utf8')) as {
    events?: Array<{ type: string }>;
  };
  assert.deepEqual(
    debugTrace.events?.map((event) => event.type),
    ['live_audit.preflight.start', 'live_audit.preflight.provenance', 'stage.start', 'stage.end', 'live_audit.preflight.ok'],
  );
});


test('main preserves a primary error and persists cleanup failure diagnostics', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-main-cleanup-'));
  await fs.promises.writeFile(path.join(outputDir, 'debug-trace.json'), JSON.stringify({ task: { topic: 'main cleanup' }, events: [] }), 'utf8');
  const cleanupError = new Error('main close failed');
  const primaryError = new Error('main run failed');

  await assert.rejects(
    () => main(
      {
        LIVE_AUDIT_TOPIC: 'main cleanup',
        LIVE_AUDIT_MAX_ITERATIONS: '1',
        LIVE_AUDIT_OUTPUT_DIR: outputDir,
      },
      {
        createToolset: async () => ({
          searchTool: { search: async () => [] },
          fetchTool: { fetch: async () => { throw new Error('unused'); } },
          close: async () => { throw cleanupError; },
        }),
        runLiveAudit: async () => { throw primaryError; },
      },
    ),
    (error: unknown) => error === primaryError,
  );

  const log = await readFile(path.join(outputDir, 'live.log'), 'utf8');
  assert.match(log, /mcp\.cleanup\.failure/);
  assert.doesNotMatch(log, /main close failed|main run failed/);
  const trace = JSON.parse(await readFile(path.join(outputDir, 'debug-trace.json'), 'utf8')) as {
    events?: Array<{ type: string; payload?: Record<string, unknown> }>;
  };
  const cleanupEvent = trace.events?.find((event) => event.type === 'mcp.cleanup.failure');
  const cleanupProjection = cleanupEvent?.payload?.cleanupError as Record<string, unknown> | undefined;
  const originalProjection = cleanupEvent?.payload?.originalError as Record<string, unknown> | undefined;
  assert.equal(cleanupProjection?.name, 'Error');
  assert.equal(originalProjection?.name, 'Error');
  for (const projection of [cleanupProjection, originalProjection]) {
    assert.equal('message' in (projection ?? {}), false);
    assert.equal('stack' in (projection ?? {}), false);
    assert.equal('diagnostics' in (projection ?? {}), false);
  }
});

test('main surfaces cleanup failure when the live audit succeeds', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-main-cleanup-success-'));
  await fs.promises.writeFile(path.join(outputDir, 'debug-trace.json'), JSON.stringify({ task: { topic: 'main cleanup success' }, events: [] }), 'utf8');
  const cleanupError = new Error('successful run close failed');

  await assert.rejects(
    () => main(
      {
        LIVE_AUDIT_TOPIC: 'main cleanup success',
        LIVE_AUDIT_MAX_ITERATIONS: '1',
        LIVE_AUDIT_OUTPUT_DIR: outputDir,
      },
      {
        createToolset: async () => ({
          searchTool: { search: async () => [] },
          fetchTool: { fetch: async () => ({}) as never },
          close: async () => { throw cleanupError; },
        }),
        runLiveAudit: async () => ({
          currentIteration: 0,
          discoveredCandidates: [],
          fetchedEvidence: [],
          decision: { decision: 'stop' },
          debugTracePath: path.join(outputDir, 'debug-trace.json'),
        }) as never,
      },
    ),
    (error: unknown) => error === cleanupError,
  );

  const trace = JSON.parse(await readFile(path.join(outputDir, 'debug-trace.json'), 'utf8')) as {
    events?: Array<{ type: string }>;
  };
  assert.equal(trace.events?.some((event) => event.type === 'mcp.cleanup.failure'), true);
});

test('createLiveAuditRuntime uses a durable home-directory default output directory when env does not provide one', () => {
  const runtime = createLiveAuditRuntime({
    LIVE_AUDIT_TOPIC: '默认输出目录测试',
    LIVE_AUDIT_MAX_ITERATIONS: '2',
  });

  assert.equal(runtime.outputDir, path.join(os.homedir(), '.local-policy-agent', 'live-audit'));
  assert.equal(runtime.outputDir.startsWith(os.tmpdir()), false);
});

test('runLiveAudit writes a durable debug trace artifact instead of stdout-only debug visibility', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-live-audit-'));

  const result = await runLiveAudit(
    createLiveAuditRuntime(
      {
        LIVE_AUDIT_TOPIC: '预检顺序测试',
        LIVE_AUDIT_MAX_ITERATIONS: '2',
        LIVE_AUDIT_OUTPUT_DIR: outputDir,
        NANOCLAW_API_KEY: 'test-key',
        NANOCLAW_BASE_URL: 'https://user:secret@nanoclaw.example/messages?token=hidden',
        NANOCLAW_LLM_PROVIDER: 'anthropic',
        POLICY_AGENT_LLM_MODEL: 'claude-opus-4-8',
      },
      {
        resolveConfig: () => ({
          apiKey: 'test-key',
          baseURL: 'https://user:secret@nanoclaw.example/messages?token=hidden',
          model: 'claude-opus-4-8',
          provider: 'anthropic' as const,
        }),
        probeGatewayModels: async () => ({
          endpoint: 'https://nanoclaw.example/models',
          ok: true,
          status: 200,
          statusText: 'OK',
          contentType: 'application/json',
          topLevelKeys: ['data', 'object'],
          dataCount: 1,
          sampleModelIds: ['claude-opus-4-8'],
          includesConfiguredModel: true,
          configuredModel: 'claude-opus-4-8',
        }),
        callNanoclawModel: async () => '{"decision":"stop","reasoning":"ok","searchActions":[],"fetchActions":[],"uncertainties":[],"discardedLeads":[]}',
      },
    ),
    {
      runPolicyTaskLoop: async (_input, options) => {
        options.onDebugEvent?.({
          type: 'loop.debug',
          payload: { phase: 'loop' },
        });
        return {
          task: { topic: '预检顺序测试' },
          discoveredCandidates: [],
          fetchedEvidence: [],
          currentIteration: 0,
          uncertainties: [],
          decision: {
            decision: 'stop',
            reasoning: 'ok',
            searchActions: [],
            fetchActions: [],
            uncertainties: [],
            discardedLeads: [],
          },
        };
      },
    },
  );

  assert.equal(result.decision.decision, 'stop');
  assert.equal(typeof result.debugTracePath, 'string');
  assert.equal(result.debugTracePath, path.join(outputDir, 'debug-trace.json'));

  const debugTrace = JSON.parse(await readFile(result.debugTracePath, 'utf8')) as {
    events?: Array<{ type: string; payload: Record<string, unknown> }>;
  };

  assert.equal(debugTrace.events?.some((event) => event.type === 'live_audit.preflight.start'), true);
  assert.equal(debugTrace.events?.some((event) => event.type === 'live_audit.preflight.provenance'), true);
  assert.equal(debugTrace.events?.some((event) => event.type === 'live_audit.preflight.ok'), true);
  assert.equal(debugTrace.events?.some((event) => event.type === 'loop.debug'), true);
  const provenanceEvent = debugTrace.events?.find((event) => event.type === 'live_audit.preflight.provenance');
  assert.deepEqual(provenanceEvent?.payload, {
    topic: '预检顺序测试',
    maxIterations: 2,
    transport: 'nanoclaw',
    provider: 'anthropic',
    providerMode: 'explicit',
    model: 'claude-opus-4-8',
    effectiveBaseURL: 'https://nanoclaw.example/messages',
    presentEnvKeys: [
      'NANOCLAW_API_KEY',
      'NANOCLAW_BASE_URL',
      'NANOCLAW_LLM_PROVIDER',
      'POLICY_AGENT_LLM_MODEL',
    ],
    gateway: {
      endpoint: 'https://nanoclaw.example/models',
      ok: true,
      status: 200,
      statusText: 'OK',
      contentType: 'application/json',
      topLevelKeys: ['data', 'object'],
      dataCount: 1,
      sampleModelIds: ['claude-opus-4-8'],
      includesConfiguredModel: true,
      configuredModel: 'claude-opus-4-8',
    },
  });
});

test('runLiveAudit persists each debug event before invoking the shell callback and isolates callback failures from runtime failure', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-live-audit-callback-'));
  const persistedSnapshots: string[][] = [];
  let callbackCalls = 0;

  const result = await runLiveAudit(
    createLiveAuditRuntime(
      {
        LIVE_AUDIT_TOPIC: '回调隔离测试',
        LIVE_AUDIT_MAX_ITERATIONS: '2',
        LIVE_AUDIT_OUTPUT_DIR: outputDir,
      },
      {
        resolveConfig: () => ({
          apiKey: 'test-key',
          baseURL: 'https://nanoclaw.example/messages',
          model: 'claude-opus-4-8',
          provider: 'anthropic' as const,
        }),
        probeGatewayModels: async () => ({
          endpoint: 'https://nanoclaw.example/models',
          ok: true,
          status: 200,
          statusText: 'OK',
          contentType: 'application/json',
          topLevelKeys: ['data'],
          dataCount: 1,
          sampleModelIds: ['claude-opus-4-8'],
          includesConfiguredModel: true,
          configuredModel: 'claude-opus-4-8',
        }),
        callNanoclawModel: async () => '{"decision":"stop","reasoning":"ok","searchActions":[],"fetchActions":[],"uncertainties":[],"discardedLeads":[]}',
        onDebugEvent: (event) => {
          callbackCalls += 1;
          const debugTrace = JSON.parse(
            fs.readFileSync(path.join(outputDir, 'debug-trace.json'), 'utf8'),
          ) as { events?: Array<{ type: string }> };
          persistedSnapshots.push((debugTrace.events ?? []).map((entry) => entry.type));
          if (event.type === 'live_audit.preflight.ok') {
            throw new Error('shell callback exploded');
          }
        },
      },
    ),
    {
      runPolicyTaskLoop: async () => ({
        task: { topic: '回调隔离测试' },
        discoveredCandidates: [],
        fetchedEvidence: [],
        currentIteration: 0,
        uncertainties: [],
        decision: {
          decision: 'stop',
          reasoning: 'ok',
          searchActions: [],
          fetchActions: [],
          uncertainties: [],
          discardedLeads: [],
        },
      }),
    },
  );

  assert.equal(result.decision.decision, 'stop');
  assert.equal(callbackCalls >= 3, true);
  assert.deepEqual(persistedSnapshots, [
    ['live_audit.preflight.start'],
    ['live_audit.preflight.start', 'live_audit.preflight.provenance'],
    ['live_audit.preflight.start', 'live_audit.preflight.provenance', 'stage.start'],
    ['live_audit.preflight.start', 'live_audit.preflight.provenance', 'stage.start', 'stage.end'],
    ['live_audit.preflight.start', 'live_audit.preflight.provenance', 'stage.start', 'stage.end', 'live_audit.preflight.ok'],
    ['live_audit.preflight.start', 'live_audit.preflight.provenance', 'stage.start', 'stage.end', 'live_audit.preflight.ok', 'run.complete'],
  ]);

  const debugTrace = JSON.parse(await readFile(result.debugTracePath, 'utf8')) as {
    events?: Array<{ type: string; payload?: Record<string, unknown> }>;
  };
  assert.deepEqual(
    debugTrace.events?.map((event) => event.type),
    ['live_audit.preflight.start', 'live_audit.preflight.provenance', 'stage.start', 'stage.end', 'live_audit.preflight.ok', 'run.complete'],
  );
});

test('runLiveAudit writes incremental debug trace through a temp file before atomically replacing the final JSON', async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-live-audit-atomic-'));
  const atomicProbe = path.join(outputDir, 'debug-trace.json');
  const seenRenamePairs: Array<{ from: string; to: string }> = [];

  const originalRenameSync = fs.renameSync.bind(fs);
  t.mock.method(fs, 'renameSync', (oldPath: fs.PathLike, newPath: fs.PathLike) => {
    seenRenamePairs.push({ from: String(oldPath), to: String(newPath) });
    return originalRenameSync(oldPath, newPath);
  });

  const result = await runLiveAudit(
    createLiveAuditRuntime(
      {
        LIVE_AUDIT_TOPIC: '原子持久化测试',
        LIVE_AUDIT_MAX_ITERATIONS: '2',
        LIVE_AUDIT_OUTPUT_DIR: outputDir,
      },
      {
        resolveConfig: () => ({
          apiKey: 'test-key',
          baseURL: 'https://nanoclaw.example/messages',
          model: 'claude-opus-4-8',
          provider: 'anthropic' as const,
        }),
        probeGatewayModels: async () => ({
          endpoint: 'https://nanoclaw.example/models',
          ok: true,
          status: 200,
          statusText: 'OK',
          contentType: 'application/json',
          topLevelKeys: ['data'],
          dataCount: 1,
          sampleModelIds: ['claude-opus-4-8'],
          includesConfiguredModel: true,
          configuredModel: 'claude-opus-4-8',
        }),
        callNanoclawModel: async () => '{"decision":"stop","reasoning":"ok","searchActions":[],"fetchActions":[],"uncertainties":[],"discardedLeads":[]}',
      },
    ),
  );

  assert.equal(result.debugTracePath, atomicProbe);
  assert.equal(
    seenRenamePairs.some(({ to }) => to === atomicProbe),
    true,
  );
  assert.equal(
    seenRenamePairs.some(({ from, to }) => path.dirname(from) === outputDir && path.basename(from).includes('debug-trace.json') && path.basename(from) !== 'debug-trace.json' && to === atomicProbe),
    true,
  );
  const tempEntries = await readdir(outputDir);
  assert.deepEqual(tempEntries.filter((entry) => entry.includes('debug-trace') && entry !== 'debug-trace.json'), []);
  const debugTrace = JSON.parse(await readFile(atomicProbe, 'utf8')) as { events?: Array<{ type: string }> };
  assert.equal(Array.isArray(debugTrace.events), true);
});

test('createLiveAuditRuntime defers CLI stdout formatting to the shell via structured debug events', async () => {
  const formattedLines: string[] = [];
  const runtime = createLiveAuditRuntime(
    {
      LIVE_AUDIT_TOPIC: '结构化事件测试',
      LIVE_AUDIT_MAX_ITERATIONS: '2',
    },
    {
      resolveDefaultOutputDir: () => '/tmp/local-policy-agent-live-audit-default',
      onDebugEvent: (event) => {
        formattedLines.push(formatLiveAuditDebugEvent(event));
      },
    },
  );

  runtime.onDebugEvent({
    type: 'live_audit.preflight.start',
    payload: {
      topic: '结构化事件测试',
      maxIterations: 2,
    },
  });

  assert.deepEqual(formattedLines, [
    '[live-audit-debug] {"type":"live_audit.preflight.start","payload":{"topic":"结构化事件测试","maxIterations":2}}',
  ]);
});

test('runLiveAudit calls preflight before entering runPolicyTaskLoop', async () => {
  const calls: string[] = [];

  const result = await runLiveAudit(
    {
      topic: '预检顺序测试',
      maxIterations: 2,
      outputDir: path.join(os.tmpdir(), 'local-policy-agent-live-audit-preflight-order'),
      callModel: async (prompt) => {
        calls.push(`callModel:${prompt}`);
        return '{"decision":"stop","reasoning":"ok","searchActions":[],"fetchActions":[],"uncertainties":[],"discardedLeads":[]}';
      },
      resolvePreflightProvenance: () => ({
        transport: 'nanoclaw',
        provider: 'anthropic',
        providerMode: 'inferred',
        model: 'claude-opus-4-8',
        effectiveBaseURL: 'https://nanoclaw.example/messages',
        presentEnvKeys: [],
      }),
      onDebugEvent: () => {},
      onShellDebugEvent: () => {},
    },
    {
      runPolicyTaskLoop: async (_input, options) => {
        calls.push(`loop:${options.maxIterations}`);
        return {
          task: { topic: '预检顺序测试' },
          discoveredCandidates: [],
          fetchedEvidence: [],
          currentIteration: 0,
          uncertainties: [],
          decision: {
            decision: 'stop',
            reasoning: 'ok',
            searchActions: [],
            fetchActions: [],
            uncertainties: [],
            discardedLeads: [],
          },
        };
      },
    },
  );

  assert.deepEqual(calls, ['callModel:__live_audit_preflight__', 'loop:2']);
  assert.equal(result.decision.decision, 'stop');
});

test('runLiveAudit does not report complete when the model stops before any discovery or fetch', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-live-audit-empty-stop-'));
  await runLiveAudit(
    {
      topic: '首轮空停止验收测试',
      maxIterations: 1,
      outputDir,
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
      targetHotspotCount: 20,
      hotspotOnly: true,
      enableBrowser: false,
      runTimeoutMs: 5000,
      preflightRetryAttempts: 0,
      preflightRetryDelayMs: 0,
      callModel: async () => 'ok',
      resolvePreflightProvenance: async () => ({
        transport: 'nanoclaw',
        provider: 'anthropic',
        providerMode: 'inferred',
        model: 'test-model',
        effectiveBaseURL: 'https://example.test',
        presentEnvKeys: [],
        gateway: {} as never,
      }),
      onDebugEvent: () => {},
      onShellDebugEvent: () => {},
    },
    {
      runPolicyTaskLoop: async () => ({
        task: { topic: '首轮空停止验收测试' },
        discoveredCandidates: [],
        fetchedEvidence: [],
        currentIteration: 1,
        uncertainties: [],
        decision: {
          decision: 'stop',
          reasoning: 'No evidence yet',
          searchActions: [],
          fetchActions: [],
          uncertainties: [],
          discardedLeads: [],
        },
      }),
    },
  );

  const summary = JSON.parse(await readFile(path.join(outputDir, 'run-summary.json'), 'utf8')) as Record<string, unknown>;
  assert.notEqual(summary.status, 'complete');
  assert.equal(summary.businessAcceptance, 'FAIL');
  assert.equal(summary.decision, 'stop');
});
test('runLiveAudit writes early-access report and keeps report metrics separate', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-live-audit-report-'));
  const result = await runLiveAudit(
    {
      topic: '报告契约测试',
      maxIterations: 1,
      outputDir,
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
      targetHotspotCount: 2,
      hotspotOnly: true,
      enableBrowser: false,
      runTimeoutMs: 5000,
      preflightRetryAttempts: 0,
      preflightRetryDelayMs: 0,
      callModel: async () => 'ok',
      resolvePreflightProvenance: async () => ({
        transport: 'nanoclaw',
        provider: 'anthropic',
        providerMode: 'inferred',
        model: 'test-model',
        effectiveBaseURL: 'https://example.test',
        presentEnvKeys: [],
        gateway: {} as never,
      }),
      onDebugEvent: () => {},
      onShellDebugEvent: () => {},
    },
    {
      runPolicyTaskLoop: async () => ({
        task: { topic: '报告契约测试' },
        discoveredCandidates: [{ url: 'https://example.test/candidate' }],
        fetchedEvidence: [{
          requestedUrl: 'https://example.test/early-access',
          finalUrl: 'https://example.test/early-access',
          title: 'Example 内测',
          content: '2026-07-20 开启内测，申请入口见官网。',
          backend: 'fixture',
          qualityCategory: 'GOLD_STANDARD',
          freshnessStatus: 'in_window',
          publishedAt: '2026-07-20',
        }],
        currentIteration: 1,
        uncertainties: [],
        decision: {
          decision: 'stop',
          reasoning: 'model-owned stop',
          searchActions: [],
          fetchActions: [],
          uncertainties: [],
          discardedLeads: [],
          finalPackage: [{
            product_name: 'Example 内测',
            official_url: 'https://example.test/early-access',
            access_status: 'private beta',
          }],
        },
      }),
    },
  );

  assert.equal(result.decision.reasoning, 'model-owned stop');
  assert.equal(result.validatedEarlyAccessItems, 1);
  assert.equal(result.reportedEarlyAccessItems, 1);
  assert.equal(result.earlyAccessTarget, 2);
  assert.equal(result.earlyAccessShortfall, 1);
  assert.equal(result.earlyAccessReportPath, path.join(outputDir, 'early-access-report.md'));
  assert.equal(result.businessAcceptance, 'CONDITIONAL_PASS');
  assert.equal(result.executionStatus, 'complete');
  assert.match(await readFile(result.earlyAccessReportPath, 'utf8'), /valid_count: 1/);

  const summary = JSON.parse(await readFile(path.join(outputDir, 'run-summary.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(summary.discoveredCandidates, 1);
  assert.equal(summary.fetchedEvidence, 1);
  assert.equal(summary.validatedEarlyAccessItems, 1);
  assert.equal(summary.reportedEarlyAccessItems, 1);
  assert.equal(summary.earlyAccessShortfall, 1);
});
