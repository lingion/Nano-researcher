import os from 'node:os';
import path from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';

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
import { writeRunTranscript } from '../artifacts/write-run-transcript.ts';

export interface LiveAuditEnv {
  LIVE_AUDIT_TOPIC?: string;
  LIVE_AUDIT_MAX_ITERATIONS?: string;
  LIVE_AUDIT_OUTPUT_DIR?: string;
  LIVE_AUDIT_FROM?: string;
  LIVE_AUDIT_TO?: string;
  LIVE_AUDIT_TARGET_COUNT?: string;
  LIVE_AUDIT_HOTSPOT_ONLY?: string;
  LIVE_AUDIT_ENABLE_BROWSER?: string;}

export interface LiveAuditTransportProvenance {
  transport: 'nanoclaw';
  provider: NanoclawRuntimeConfig['provider'];
  providerMode: 'explicit' | 'inferred';
  model: string;
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
  callModel: (prompt: string) => Promise<string>;
  resolvePreflightProvenance: () => Promise<LiveAuditTransportProvenance>;
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
  });
  appendFileSync(liveLogPath, `${new Date().toISOString()} ${JSON.stringify(events.at(-1))}\n`);
  return debugTracePath;
}

function reportShellDebugEvent(runtime: Pick<LiveAuditRuntime, 'onShellDebugEvent'>, event: DebugEvent): void {
  try {
    runtime.onShellDebugEvent(event);
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
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
      ...(error instanceof NanoclawEmptyResponseError
        ? { diagnostics: error.diagnostics }
        : {}),
    };
  }

  return {
    message: String(error),
  };
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
    callNanoclawModel?: (prompt: string, options?: { config?: NanoclawRuntimeConfig }) => Promise<string>;
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
    callModel: async (prompt: string) => {
      resolvedConfig ??= resolveConfig();
      return await (deps.callNanoclawModel ?? callNanoclawModel)(prompt, { config: resolvedConfig });
    },
    resolvePreflightProvenance: async () => {
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

export async function runLiveAuditPreflight(runtime: LiveAuditRuntime): Promise<void> {
  runtime.onDebugEvent({
    type: 'live_audit.preflight.start',
    payload: {
      topic: runtime.topic,
      maxIterations: runtime.maxIterations,
    },
  });

  try {
    runtime.onDebugEvent({
      type: 'live_audit.preflight.provenance',
      payload: {
        topic: runtime.topic,
        maxIterations: runtime.maxIterations,
        ...(await runtime.resolvePreflightProvenance()),
      },
    });

    await runtime.callModel(LIVE_AUDIT_PREFLIGHT_PROMPT);
  } catch (error) {
    if (error instanceof NanoclawEmptyResponseError && shouldBypassEmptyResponse(error.diagnostics)) {
      runtime.onDebugEvent({
        type: 'live_audit.preflight.warning',
        payload: {
          topic: runtime.topic,
          maxIterations: runtime.maxIterations,
          message: 'Structurally valid empty preflight response; bypassing strict text requirement.',
          diagnostics: error.diagnostics,
        },
      });
      return;
    }

    const preflightError = new Error(
      `Live audit preflight failed before entering runPolicyTaskLoop: ${error instanceof Error ? error.message : String(error)}`,
    );
    emitFailureDebugEventSafely(
      runtime,
      {
        type: 'live_audit.preflight.error',
        payload: {
          topic: runtime.topic,
          maxIterations: runtime.maxIterations,
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof NanoclawEmptyResponseError
            ? { diagnostics: error.diagnostics }
            : {}),
        },
      },
      preflightError,
    );
    throw preflightError;
  }

  runtime.onDebugEvent({
    type: 'live_audit.preflight.ok',
    payload: {
      topic: runtime.topic,
      maxIterations: runtime.maxIterations,
    },
  });
}

export async function runLiveAudit(
  runtime: LiveAuditRuntime,
  deps: {
    runPolicyTaskLoop?: typeof runPolicyTaskLoop;
  } = {},
): Promise<Awaited<ReturnType<typeof runPolicyTaskLoop>> & { debugTracePath: string }> {
  const debugEvents: DebugEvent[] = [];
  let debugTracePath = path.join(runtime.outputDir, 'debug-trace.json');

  const forwardDebugEvent = (event: DebugEvent) => {
    debugEvents.push(event);
    debugTracePath = writeLiveAuditDebugTrace(runtime.outputDir, { topic: runtime.topic }, debugEvents);
    reportShellDebugEvent(runtime, event);
  };

  let debugTraceWriteFailed = false;

  const writeDebugEventSafely = (event: DebugEvent) => {
    if (debugTraceWriteFailed) {
      reportShellDebugEvent(runtime, event);
      return;
    }

    try {
      forwardDebugEvent(event);
    } catch (error) {
      debugTraceWriteFailed = true;
      throw error;
    }
  };

  try {
    await runLiveAuditPreflight({
      ...runtime,
      onDebugEvent: writeDebugEventSafely,
    });

    const result = await (deps.runPolicyTaskLoop ?? runPolicyTaskLoop)(
      { topic: runtime.topic },
      {
        maxIterations: runtime.maxIterations,
        targetHotspotCount: runtime.targetHotspotCount,
        fromDate: runtime.fromDate,
        toDate: runtime.toDate,
        enableBrowser: runtime.enableBrowser,
        onDebugEvent: writeDebugEventSafely,
      },
    );

    return {
      ...result,
      debugTracePath,
    };
  } catch (error) {
    emitFailureDebugEventSafely(
      {
        onDebugEvent: writeDebugEventSafely,
        onShellDebugEvent: runtime.onShellDebugEvent,
        outputDir: runtime.outputDir,
      },
      {
        type: 'run.failure',
        payload: serializeErrorPayload(error),
      },
      error,
    );
    throw error;
  }
}
