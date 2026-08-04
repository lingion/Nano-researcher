import os from 'node:os';
import path from 'node:path';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';

import { runPolicyTaskLoop } from './run-policy-task.ts';
import {
  callNanoclawModel,
  NanoclawEmptyResponseError,
  probeNanoclawGatewayModels,
  resolveNanoclawRuntimeConfig,
  type GatewayModelProbeResult,
  type NanoclawRuntimeConfig,
} from '../runtime/nanoclaw-bridge.ts';
import type { DebugEvent } from '../runtime/ask-real-claude.ts';
import { writeRunTranscript, writeTextFileAtomic } from '../artifacts/write-run-transcript.ts';
import { summarizeError, safeSerializeDebugPayload, sanitizeDebugEvent, sanitizeDebugValue } from '../runtime/sanitize-debug.ts';
import { normalizeFinalPackage, writeEarlyAccessReport } from '../artifacts/write-early-access-report.ts';
import { withTimeout, isRetryableRuntimeError } from '../runtime/reliability.ts';

export interface LiveAuditEnv {
  LIVE_AUDIT_TOPIC?: string;
  LIVE_AUDIT_MAX_ITERATIONS?: string;
  LIVE_AUDIT_OUTPUT_DIR?: string;
  LIVE_AUDIT_FROM?: string;
  LIVE_AUDIT_TO?: string;
  LIVE_AUDIT_TARGET_COUNT?: string;
  LIVE_AUDIT_HOTSPOT_ONLY?: string;
  LIVE_AUDIT_ENABLE_BROWSER?: string;
  LIVE_AUDIT_MODEL_TIMEOUT_MS?: string;
  LIVE_AUDIT_HEARTBEAT_MS?: string;
  LIVE_AUDIT_RUN_TIMEOUT_MS?: string;
  LIVE_AUDIT_PREFLIGHT_RETRY_ATTEMPTS?: string;
  LIVE_AUDIT_PREFLIGHT_RETRY_DELAY_MS?: string;
}

export interface LiveAuditTransportProvenance {
  transport: 'nanoclaw';
  provider: NanoclawRuntimeConfig['provider'];
  providerMode: 'explicit' | 'inferred';
  model: string;
  fallbackModel?: string;
  effectiveBaseURL: string;
  presentEnvKeys: string[];
  gateway: GatewayModelProbeResult;
}

export interface LiveAuditRuntime {
  topic: string;
  maxIterations: number;
  outputDir: string;
  fromDate: string;
  toDate: string;
  targetHotspotCount: number;
  hotspotOnly: boolean;
  enableBrowser: boolean;
  runTimeoutMs: number;
  preflightRetryAttempts: number;
  preflightRetryDelayMs?: number;
  callModel: (prompt: string, signal?: AbortSignal) => Promise<string>;
  resolvePreflightProvenance: (signal?: AbortSignal) => Promise<LiveAuditTransportProvenance>;
  onDebugEvent: (event: DebugEvent) => void;
  onShellDebugEvent: (event: DebugEvent) => void;
}

const LIVE_AUDIT_PREFLIGHT_PROMPT = '__live_audit_preflight__';
const LIVE_AUDIT_PROVENANCE_ENV_KEYS = [
  'NANOCLAW_API_KEY',
  'ANTHROPIC_API_KEY',
  'NANOCLAW_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'NANOCLAW_LLM_PROVIDER',
  'POLICY_AGENT_LLM_MODEL',
  'NANOCLAW_MODEL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
] as const;

export function parseLiveAuditDate(raw: string | undefined, fallback: string): string {
  const value = raw ?? fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error(`Live audit date must be ISO YYYY-MM-DD; received ${JSON.stringify(value)}`);
  return value;
}

export function parseLiveAuditTargetCount(raw: string | undefined, fallback = 20): number {
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error('LIVE_AUDIT_TARGET_COUNT must be a positive integer');
  return value;
}

export function parseLiveAuditBoolean(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined) return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`Invalid boolean value: ${raw}`);
}

export function parseLiveAuditMaxIterations(rawValue: string | undefined): number {
  const candidate = rawValue ?? '4';
  const parsed = Number(candidate);

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`LIVE_AUDIT_MAX_ITERATIONS must be a finite positive integer; received ${JSON.stringify(candidate)}`);
  }

  return parsed;
}

function writeLiveAuditDebugTrace(
  outputDir: string,
  task: { topic: string },
  events: DebugEvent[],
): string {
  mkdirSync(outputDir, { recursive: true });
  const debugTracePath = path.join(outputDir, 'debug-trace.json');
  const liveLogPath = path.join(outputDir, 'live.log');
  writeRunTranscript.sync(debugTracePath, {
    task,
    events,
  }, { mode: 'debug' });
  const latest = events.at(-1);
  if (latest) appendFileSync(liveLogPath, `${new Date().toISOString()} ${safeSerializeDebugPayload(latest)}\n`, 'utf8');
  return debugTracePath;
}

function initializeLiveAuditLog(outputDir: string, topic: string): string {
  mkdirSync(outputDir, { recursive: true });
  const liveLogPath = path.join(outputDir, 'live.log');
  appendFileSync(liveLogPath, `${new Date().toISOString()} ${safeSerializeDebugPayload({ type: 'live_audit.start', payload: { topic } })}\n`, 'utf8');
  return liveLogPath;
}

function reportShellDebugEvent(runtime: Pick<LiveAuditRuntime, 'onShellDebugEvent'>, event: DebugEvent): void {
  try {
    runtime.onShellDebugEvent(sanitizeDebugEvent(event));
  } catch {
    // Shell-side debug hooks are best-effort only and must not fail the runtime.
  }
}

function resolveDefaultLiveAuditOutputDir(): string {
  return path.join(os.homedir(), '.local-policy-agent', 'live-audit');
}

function sanitizeBaseUrl(baseURL: string): string {
  try {
    const url = new URL(baseURL);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return baseURL
      .replace(/\/\/[^/@]+@/, '//')
      .replace(/[?#].*$/, '');
  }
}

function serializeErrorPayload(error: unknown): Record<string, unknown> {
  return summarizeError(error);
}

function resolvePresentEnvKeys(env: LiveAuditEnv): string[] {
  const envRecord = env as Record<string, string | undefined>;
  return LIVE_AUDIT_PROVENANCE_ENV_KEYS.filter((key) => typeof envRecord[key] === 'string' && envRecord[key] !== '');
}

async function buildLiveAuditTransportProvenance(
  config: NanoclawRuntimeConfig,
  env: LiveAuditEnv,
  probeGatewayModels: (options?: { config?: NanoclawRuntimeConfig }) => Promise<GatewayModelProbeResult>,
): Promise<LiveAuditTransportProvenance> {
  return {
    transport: 'nanoclaw',
    provider: config.provider,
    providerMode:
      env.NANOCLAW_LLM_PROVIDER === 'openai' || env.NANOCLAW_LLM_PROVIDER === 'anthropic'
        ? 'explicit'
        : 'inferred',
    model: config.model,
    ...(config.fallbackModel && config.fallbackModel !== config.model ? { fallbackModel: config.fallbackModel } : {}),
    effectiveBaseURL: sanitizeBaseUrl(config.baseURL),
    presentEnvKeys: resolvePresentEnvKeys(env),
    gateway: await probeGatewayModels({ config }),
  };
}

function emitFailureDebugEventSafely(
  runtime: Pick<LiveAuditRuntime, 'onDebugEvent' | 'onShellDebugEvent' | 'outputDir'>,
  event: DebugEvent,
  originalError: unknown,
): void {
  try {
    runtime.onDebugEvent(event);
  } catch (traceWriteError) {
    reportShellDebugEvent(runtime, {
      type: 'debug_trace.write_error',
      payload: {
        tracePath: path.join(runtime.outputDir, 'debug-trace.json'),
        failedEventType: event.type,
        originalError: serializeErrorPayload(originalError),
        traceWriteError: serializeErrorPayload(traceWriteError),
      },
    });
  }
}

export function createLiveAuditRuntime(
  env: LiveAuditEnv = process.env,
  deps: {
    resolveConfig?: () => NanoclawRuntimeConfig;
    callNanoclawModel?: (prompt: string, options?: { config?: NanoclawRuntimeConfig; signal?: AbortSignal }) => Promise<string>;
    probeGatewayModels?: (options?: { config?: NanoclawRuntimeConfig }) => Promise<GatewayModelProbeResult>;
    resolveDefaultOutputDir?: () => string;
    onDebugEvent?: (event: DebugEvent) => void;
  } = {},
): LiveAuditRuntime {
  const topic = env.LIVE_AUDIT_TOPIC ?? '最新 AI 新品、模型发布、内测资格、Beta/Preview、Waitlist 和申请入口';
  const maxIterations = parseLiveAuditMaxIterations(env.LIVE_AUDIT_MAX_ITERATIONS);
  const toDate = parseLiveAuditDate(env.LIVE_AUDIT_TO, new Date().toISOString().slice(0, 10));
  const fromDate = parseLiveAuditDate(env.LIVE_AUDIT_FROM, toDate);
  const targetHotspotCount = parseLiveAuditTargetCount(env.LIVE_AUDIT_TARGET_COUNT);
  const hotspotOnly = parseLiveAuditBoolean(env.LIVE_AUDIT_HOTSPOT_ONLY, true);
  const enableBrowser = parseLiveAuditBoolean(env.LIVE_AUDIT_ENABLE_BROWSER, false);
  const runTimeoutMs = Number(env.LIVE_AUDIT_RUN_TIMEOUT_MS ?? 0);
  if (!Number.isFinite(runTimeoutMs) || runTimeoutMs < 0) throw new Error('LIVE_AUDIT_RUN_TIMEOUT_MS must be a non-negative finite number');
  const preflightRetryAttempts = Number(env.LIVE_AUDIT_PREFLIGHT_RETRY_ATTEMPTS ?? 1);
  if (!Number.isInteger(preflightRetryAttempts) || preflightRetryAttempts < 0) throw new Error('LIVE_AUDIT_PREFLIGHT_RETRY_ATTEMPTS must be a non-negative integer');
  const preflightRetryDelayMs = Number(env.LIVE_AUDIT_PREFLIGHT_RETRY_DELAY_MS ?? 200);
  if (!Number.isFinite(preflightRetryDelayMs) || preflightRetryDelayMs < 0) throw new Error('LIVE_AUDIT_PREFLIGHT_RETRY_DELAY_MS must be a non-negative finite number');
  if (fromDate > toDate) throw new Error('LIVE_AUDIT_FROM must be on or before LIVE_AUDIT_TO');
  const outputDir = env.LIVE_AUDIT_OUTPUT_DIR ?? (deps.resolveDefaultOutputDir ?? resolveDefaultLiveAuditOutputDir)();
  const forwardShellDebugEvent = deps.onDebugEvent ?? (() => {});
  const resolveConfig = deps.resolveConfig ?? resolveNanoclawRuntimeConfig;
  const probeGatewayModels = deps.probeGatewayModels ?? probeNanoclawGatewayModels;
  let resolvedConfig: NanoclawRuntimeConfig | undefined;

  return {
    topic,
    maxIterations,
    outputDir,
    fromDate,
    toDate,
    targetHotspotCount,
    hotspotOnly,
    enableBrowser,
    runTimeoutMs,
    preflightRetryAttempts,
    preflightRetryDelayMs,
    callModel: async (prompt: string, signal?: AbortSignal) => {
      resolvedConfig ??= resolveConfig();
      return await (deps.callNanoclawModel ?? callNanoclawModel)(prompt, { config: resolvedConfig, signal, onDebugEvent: forwardShellDebugEvent });
    },
    resolvePreflightProvenance: async (_signal?: AbortSignal) => {
      resolvedConfig ??= resolveConfig();
      return await buildLiveAuditTransportProvenance(resolvedConfig, env, probeGatewayModels);
    },
    onDebugEvent: (event: DebugEvent) => {
      forwardShellDebugEvent(event);
    },
    onShellDebugEvent: (event: DebugEvent) => {
      forwardShellDebugEvent(event);
    },
  };
}

export function shouldBypassEmptyResponse(diagnostics: unknown): boolean {
  if (!diagnostics || typeof diagnostics !== 'object') {
    return false;
  }

  const record = diagnostics as {
    status?: unknown;
    hasChoices?: unknown;
    hasContent?: unknown;
    structuralHints?: unknown;
    topLevelKeys?: unknown;
    responseMetrics?: { status?: unknown };
    responseFeatures?: {
      hasChoicesArray?: unknown;
      hasTextContent?: unknown;
      messageFieldPresent?: unknown;
      contentFieldPresent?: unknown;
      rawTopLevelKeys?: unknown;
    };
  };

  if (record.responseMetrics && record.responseFeatures) {
    const rawTopLevelKeys = Array.isArray(record.responseFeatures.rawTopLevelKeys)
      ? record.responseFeatures.rawTopLevelKeys.filter((key): key is string => typeof key === 'string')
      : [];

    return record.responseMetrics.status === 200
      && record.responseFeatures.hasChoicesArray === true
      && record.responseFeatures.hasTextContent === false
      && record.responseFeatures.messageFieldPresent === true
      && rawTopLevelKeys.includes('choices');
  }

  if (record.status !== 200 || record.hasChoices !== true || record.hasContent !== false) {
    return false;
  }

  const structuralHints = Array.isArray(record.structuralHints)
    ? record.structuralHints.filter((hint): hint is string => typeof hint === 'string')
    : [];
  const topLevelKeys = Array.isArray(record.topLevelKeys)
    ? record.topLevelKeys.filter((key): key is string => typeof key === 'string')
    : [];

  const hasMessageSkeleton = structuralHints.includes('choices[0].message present')
    || structuralHints.includes('choices[0].message.content present');
  const hasChoicesKey = topLevelKeys.includes('choices');

  return hasMessageSkeleton && hasChoicesKey;
}

function waitForPreflightRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runLiveAuditPreflight(runtime: LiveAuditRuntime, signal?: AbortSignal): Promise<void> {
  const retryAttempts = runtime.preflightRetryAttempts ?? 0;
  const retryDelay = runtime.preflightRetryDelayMs ?? 200;
  runtime.onDebugEvent({
    type: 'live_audit.preflight.start',
    payload: {
      topic: runtime.topic,
      maxIterations: runtime.maxIterations,
      ...(retryAttempts > 0 ? { retryAttempts } : {}),
    },
  });

  let lastError: unknown;
  for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
    try {
      runtime.onDebugEvent({
        type: 'live_audit.preflight.provenance',
        payload: { topic: runtime.topic, maxIterations: runtime.maxIterations, ...(attempt > 0 ? { attempt: attempt + 1 } : {}), ...(await runtime.resolvePreflightProvenance(signal)) },
      });
      await runtime.callModel(LIVE_AUDIT_PREFLIGHT_PROMPT, signal);
      runtime.onDebugEvent({ type: 'live_audit.preflight.ok', payload: { topic: runtime.topic, maxIterations: runtime.maxIterations, ...(attempt > 0 ? { attempt: attempt + 1 } : {}) } });
      return;
    } catch (error) {
      if (error instanceof NanoclawEmptyResponseError && shouldBypassEmptyResponse(error.diagnostics)) {
        runtime.onDebugEvent({ type: 'live_audit.preflight.warning', payload: { topic: runtime.topic, maxIterations: runtime.maxIterations, bypassedEmptyResponse: true } });
        return;
      }
      lastError = error;
      const retryable = isRetryableRuntimeError(error);
      const hasRetry = retryable && attempt < retryAttempts;
      if (!hasRetry) break;
      const delayMs = retryDelay + Math.max(0, attempt * retryDelay);
      runtime.onDebugEvent({ type: 'live_audit.preflight.retry', payload: { topic: runtime.topic, maxIterations: runtime.maxIterations, attempt: attempt + 1, nextAttempt: attempt + 2, delayMs, error: serializeErrorPayload(error) } });
      await waitForPreflightRetry(delayMs, signal);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  const preflightError = new Error(`Live audit preflight failed before entering runPolicyTaskLoop: ${message}`);
  emitFailureDebugEventSafely(runtime, { type: 'live_audit.preflight.error', payload: { topic: runtime.topic, maxIterations: runtime.maxIterations, error: serializeErrorPayload(lastError) } }, preflightError);
  throw preflightError;
}

type LiveAuditReportMetadata = {
  status: 'complete' | 'incomplete' | 'failed';
  executionStatus: 'complete' | 'bounded_interruption' | 'failed';
  businessAcceptance: 'PASS' | 'CONDITIONAL_PASS' | 'FAIL';
  validatedEarlyAccessItems: number;
  reportedEarlyAccessItems: number;
  earlyAccessTarget: number;
  earlyAccessShortfall: number;
  earlyAccessReportPath: string;
};

export async function runLiveAudit(
  runtime: LiveAuditRuntime,
  deps: {
    runPolicyTaskLoop?: typeof runPolicyTaskLoop;
  } = {},
): Promise<Awaited<ReturnType<typeof runPolicyTaskLoop>> & LiveAuditReportMetadata & { debugTracePath: string }> {
  const debugEvents: DebugEvent[] = [];
  initializeLiveAuditLog(runtime.outputDir, runtime.topic);  let debugTracePath = path.join(runtime.outputDir, 'debug-trace.json');

  const forwardDebugEvent = (event: DebugEvent) => {
    debugEvents.push(event);
    debugTracePath = writeLiveAuditDebugTrace(runtime.outputDir, { topic: runtime.topic }, debugEvents);
    reportShellDebugEvent(runtime, event);
  };

  let debugTraceWriteFailed = false;
  let rawModelOutputSequence = 0;

  const persistRawModelOutput = async (rawText: string): Promise<void> => {
    rawModelOutputSequence += 1;
    const fileName = `model-raw-${String(rawModelOutputSequence).padStart(4, '0')}.txt`;
    const filePath = path.join(runtime.outputDir, fileName);
    try {
      mkdirSync(runtime.outputDir, { recursive: true });
      await writeTextFileAtomic(filePath, rawText);
      writeDebugEventSafely({
        type: 'model.raw_output.persisted',
        payload: { fileName, rawTextLength: rawText.length },
      });
    } catch (error) {
      writeDebugEventSafely({
        type: 'model.raw_output.persistence_error',
        payload: { fileName, rawTextLength: rawText.length, error: serializeErrorPayload(error) },
      });
    }
  };

  const writeDebugEventSafely = (event: DebugEvent) => {
    const safeEvent = sanitizeDebugEvent(event);
    if (debugTraceWriteFailed) {
      reportShellDebugEvent(runtime, safeEvent);
      return;
    }

    try {
      forwardDebugEvent(safeEvent);
    } catch (error) {
      debugTraceWriteFailed = true;
      reportShellDebugEvent(runtime, {
        type: 'debug_trace.write_error',
        payload: {
          tracePath: path.join(runtime.outputDir, 'debug-trace.json'),
          failedEventType: safeEvent.type,
          originalError: safeEvent.type === 'run.failure'
            ? sanitizeDebugValue(safeEvent.payload)
            : undefined,
          traceWriteError: serializeErrorPayload(error),
        },
      });
      reportShellDebugEvent(runtime, safeEvent);
    }
  };

  const runStartedAt = Date.now();
  const runOperation = async (signal: AbortSignal) => {
    if (signal.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
    const instrumentedCallModel = async (prompt: string): Promise<string> => {
      const startedAt = Date.now();
      const stage = 'model';
      const heartbeatMs = Number(runtime.onShellDebugEvent ? (process.env.LIVE_AUDIT_HEARTBEAT_MS ?? 30_000) : 0);
      writeDebugEventSafely({ type: 'stage.start', payload: { stage, startedAt: new Date(startedAt).toISOString() } });
      const heartbeat = Number.isFinite(heartbeatMs) && heartbeatMs > 0
        ? setInterval(() => writeDebugEventSafely({ type: 'stage.heartbeat', payload: { stage, startedAt: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt } }), heartbeatMs)
        : undefined;
      try {
        const result = await runtime.callModel(prompt, signal);
        writeDebugEventSafely({ type: 'stage.end', payload: { stage, startedAt: new Date(startedAt).toISOString(), completedAt: new Date().toISOString(), durationMs: Date.now() - startedAt } });
        return result;
      } catch (error) {
        writeDebugEventSafely({ type: 'stage.failure', payload: { stage, startedAt: new Date(startedAt).toISOString(), completedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, error: serializeErrorPayload(error) } });
        throw error;
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
    };

    await runLiveAuditPreflight({
      ...runtime,
      callModel: instrumentedCallModel,
      onDebugEvent: writeDebugEventSafely,
    }, signal);

    const result = await (deps.runPolicyTaskLoop ?? runPolicyTaskLoop)(
      { topic: runtime.topic },
      {
        maxIterations: runtime.maxIterations,
        targetHotspotCount: runtime.targetHotspotCount,
        fromDate: runtime.fromDate,
        toDate: runtime.toDate,
        enableBrowser: runtime.enableBrowser,
        callModel: instrumentedCallModel,
        onDebugEvent: writeDebugEventSafely,
        onRawModelOutput: persistRawModelOutput,
        signal,
      },
    );

    const completedAt = new Date().toISOString();
    const earlyAccessItems = normalizeFinalPackage(result.decision.finalPackage);
    const earlyAccessReport = writeEarlyAccessReport({
      target: runtime.targetHotspotCount,
      items: earlyAccessItems,
    });
    writeFileSync(path.join(runtime.outputDir, 'early-access-report.md'), earlyAccessReport.markdown);
    const terminalDecision = result.decision.decision === 'finalize'
      || result.decision.decision === 'stop'
      || result.decision.decision === 'summarize_and_stop';
    const businessAcceptance = terminalDecision
      && earlyAccessReport.shortfall === 0
      ? 'PASS'
      : result.loop_interrupted_by_gate
        ? 'FAIL'
        : terminalDecision && earlyAccessReport.validCount > 0
          ? 'CONDITIONAL_PASS'
          : 'FAIL';
    const executionStatus = result.loop_interrupted_by_gate ? 'bounded_interruption' : 'complete';
    const status = businessAcceptance === 'PASS' && executionStatus === 'complete' ? 'complete' : 'incomplete';
    const summary = {
      status,
      executionStatus,
      businessAcceptance,
      startedAt: new Date(runStartedAt).toISOString(),
      completedAt,
      durationMs: Date.now() - runStartedAt,
      currentIteration: result.currentIteration,
      decision: result.decision.decision,
      discoveredCandidates: result.discoveredCandidates.length,
      fetchedEvidence: result.fetchedEvidence.length,
      validatedEarlyAccessItems: earlyAccessReport.validCount,
      reportedEarlyAccessItems: earlyAccessReport.validCount,
      earlyAccessTarget: earlyAccessReport.target,
      earlyAccessShortfall: earlyAccessReport.shortfall,
      earlyAccessReportPath: path.join(runtime.outputDir, 'early-access-report.md'),
    };
    writeFileSync(path.join(runtime.outputDir, 'run-summary.json'), JSON.stringify(summary, null, 2));
    writeDebugEventSafely({ type: 'run.complete', payload: summary });
    return {
      ...result,
      debugTracePath,
      status,
      executionStatus,
      businessAcceptance,
      validatedEarlyAccessItems: earlyAccessReport.validCount,
      reportedEarlyAccessItems: earlyAccessReport.validCount,
      earlyAccessTarget: earlyAccessReport.target,
      earlyAccessShortfall: earlyAccessReport.shortfall,
      earlyAccessReportPath: path.join(runtime.outputDir, 'early-access-report.md'),
    };
  };

  try {
    return await withTimeout((signal) => runOperation(signal), runtime.runTimeoutMs, 'live-audit:run');
  } catch (error) {
    emitFailureDebugEventSafely(
      {
        onDebugEvent: writeDebugEventSafely,
        onShellDebugEvent: runtime.onShellDebugEvent,
        outputDir: runtime.outputDir,
      },
      {
        type: error instanceof Error && error.name === 'RuntimeTimeoutError' ? 'live_audit.run.timeout' : 'run.failure',
        payload: { ...serializeErrorPayload(error), startedAt: new Date(runStartedAt).toISOString(), completedAt: new Date().toISOString(), durationMs: Date.now() - runStartedAt },
      },
      error,
    );
    throw error;
  }
}
