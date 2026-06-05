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
import { formatLiveAuditDebugEvent } from '../../src/app/run-live-audit.ts';
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
  assert.match(String(events[2]?.payload.message), /Structurally valid empty preflight response/);
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
    if (renameCalls >= 4 && String(newPath).endsWith('debug-trace.json')) {
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
  assert.deepEqual(traceWriteEvent?.payload.originalError, {
    name: 'Error',
    message: 'upstream loop exploded',
    stack: originalError.stack ?? null,
  });
  assert.equal((traceWriteEvent?.payload.traceWriteError as { name?: string }).name, 'Error');
  assert.equal((traceWriteEvent?.payload.traceWriteError as { message?: string }).message, 'trace rename exploded');
  assert.equal(typeof (traceWriteEvent?.payload.traceWriteError as { stack?: unknown }).stack, 'string');

  const debugTrace = JSON.parse(await readFile(path.join(outputDir, 'debug-trace.json'), 'utf8')) as {
    events?: Array<{ type: string }>;
  };
  assert.deepEqual(
    debugTrace.events?.map((event) => event.type),
    ['live_audit.preflight.start', 'live_audit.preflight.provenance', 'live_audit.preflight.ok'],
  );
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
    ['live_audit.preflight.start', 'live_audit.preflight.provenance', 'live_audit.preflight.ok'],
  ]);

  const debugTrace = JSON.parse(await readFile(result.debugTracePath, 'utf8')) as {
    events?: Array<{ type: string; payload?: Record<string, unknown> }>;
  };
  assert.deepEqual(
    debugTrace.events?.map((event) => event.type),
    ['live_audit.preflight.start', 'live_audit.preflight.provenance', 'live_audit.preflight.ok'],
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


