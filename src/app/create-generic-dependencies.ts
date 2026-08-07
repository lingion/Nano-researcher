import { OpenAiCompatibleProvider } from '../llm/openai-compatible.ts';
import type { LlmProvider } from '../llm/provider.ts';
import type { FetchResponse } from '../agent/types.ts';
import type { FetchProvider } from '../fetch/provider.ts';
import type { FetchedPageRecord } from '../fetch-fusion/types.ts';
import type { SearchProvider } from '../search/provider.ts';
import { closeHtmlExtractionPool, fetchWithLocalPrimary, isWeakFetchedContent } from '../fetch-fusion/local-fetch-primary.ts';
import { AutoSearchProvider } from '../search/auto/auto.ts';
import { builtInSearchEngines } from '../search/auto/providers/engines.ts';
import { createPlaywrightBrowserAdapter } from '../fetch-fusion/browser-fetch.ts';
import { assertSafeResolvedNetworkTarget, safeFetchWithRedirects } from '../fetch-fusion/network-safety.ts';
import path from 'node:path';
import { createFileDomainResolver, type DomainResolver } from '../domain/resolver.ts';

export interface GenericRuntimeEnv {
  NANOCLAW_BASE_URL?: string;
  NANOCLAW_API_KEY?: string;
  NANOCLAW_MODEL?: string;
  POLICY_AGENT_LLM_MODEL?: string;
  LIVE_AUDIT_MODEL_TIMEOUT_MS?: string;
  NANOCLAW_JSON_MODE?: string;
  NANOCLAW_RESPONSE_FORMAT?: string;
  NANOCLAW_LLM_MAX_ATTEMPTS?: string;
  NANOCLAW_LLM_RETRY_DELAY_MS?: string;
}

function optionalNumber(raw: string | undefined, name: string, options: { minimum: number; maximum?: number; integer?: boolean }): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < options.minimum || options.maximum !== undefined && value > options.maximum || options.integer && !Number.isInteger(value)) {
    throw new Error(`${name} must be ${options.integer ? 'an integer' : 'a finite number'} from ${options.minimum}${options.maximum === undefined ? '' : ` to ${options.maximum}`}.`);
  }
  return value;
}

export function createGenericLlmProvider(env: GenericRuntimeEnv = process.env): LlmProvider {
  if (!env.NANOCLAW_BASE_URL || !env.NANOCLAW_API_KEY) throw new Error('NANOCLAW_BASE_URL and NANOCLAW_API_KEY are required for the generic agent.');
  if (env.NANOCLAW_JSON_MODE === '0' || env.NANOCLAW_RESPONSE_FORMAT !== undefined && env.NANOCLAW_RESPONSE_FORMAT !== 'tool_call') {
    throw new Error('The generic agent requires NANOCLAW_RESPONSE_FORMAT=tool_call; free-text JSON is not a supported command channel.');
  }
  const timeoutMs = optionalNumber(env.LIVE_AUDIT_MODEL_TIMEOUT_MS, 'LIVE_AUDIT_MODEL_TIMEOUT_MS', { minimum: 1, integer: true });
  const maxAttempts = optionalNumber(env.NANOCLAW_LLM_MAX_ATTEMPTS, 'NANOCLAW_LLM_MAX_ATTEMPTS', { minimum: 1, maximum: 5, integer: true }) ?? 2;
  const retryDelayMs = optionalNumber(env.NANOCLAW_LLM_RETRY_DELAY_MS, 'NANOCLAW_LLM_RETRY_DELAY_MS', { minimum: 0, maximum: 60_000, integer: true }) ?? 250;
  return new OpenAiCompatibleProvider({
    baseUrl: env.NANOCLAW_BASE_URL,
    apiKey: env.NANOCLAW_API_KEY,
    model: env.POLICY_AGENT_LLM_MODEL ?? env.NANOCLAW_MODEL ?? 'gpt-5.4',
    timeoutMs,
    jsonMode: true,
    responseFormatMode: 'tool_call',
    maxAttempts,
    retryDelayMs,
  });
}

/**
 * Filesystem-backed domain resolver for the generic runtime. Reads domain
 * documents from RESEARCH_DOMAINS_DIR (default: the "domains" directory next
 * to the process cwd). The resolver is optional in the agent loop — a task
 * without a `domain` field never touches it, so the generic path stays
 * domain-agnostic.
 */
export function createGenericDomainResolver(env: NodeJS.ProcessEnv = process.env): DomainResolver {
  const root = env.RESEARCH_DOMAINS_DIR ?? path.resolve('domains');
  return createFileDomainResolver(root);
}

export function createGenericSearchProvider(): SearchProvider {
  return new AutoSearchProvider({ engines: builtInSearchEngines, maxEngineCalls: 8, deadlineMs: 15_000, limit: 12 });
}

export function classifyGenericFetchPage(page: Pick<FetchedPageRecord, 'statusCode' | 'title' | 'content'>): {
  outcome: Extract<FetchResponse['outcome'], 'success_with_content' | 'success_empty' | 'http_error'>;
  error?: { code: string; message: string };
} {
  const statusCode = Number(page.statusCode);
  if (Number.isFinite(statusCode) && statusCode >= 400) {
    return {
      outcome: 'http_error',
      error: { code: 'HTTP_STATUS', message: `Fetch returned HTTP ${statusCode}` },
    };
  }
  return page.content.trim() && !isWeakFetchedContent(page.title, page.content)
    ? { outcome: 'success_with_content' }
    : { outcome: 'success_empty' };
}

export function createGenericFetchProvider(): FetchProvider {
  const browserAdapter = createPlaywrightBrowserAdapter({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
  return {
    name: 'local-fetch-primary',
    async fetch(url, options): Promise<FetchResponse> {
      const started = Date.now();
      try {
        await assertSafeResolvedNetworkTarget(url);
        const page = await fetchWithLocalPrimary(url, 20_000, {
          fetchImpl: async (target, init) => safeFetchWithRedirects(target, init),
          signal: options?.signal,
          enableBrowserFallback: true,
          browserAdapter,
          generic: true,
        });
        const classification = classifyGenericFetchPage(page);
        return {
          outcome: classification.outcome,
          requestedUrl: page.requestedUrl,
          finalUrl: page.finalUrl,
          title: page.title,
          content: page.content,
          provider: 'local-fetch-primary',
          ...(page.statusCode !== undefined ? { statusCode: page.statusCode } : {}),
          contentType: page.contentType,
          contentLength: page.contentLength ?? new TextEncoder().encode(page.content).byteLength,
          truncated: page.truncated,
          renderMode: page.pageRenderMode === 'playwright' ? 'browser' : 'static',
          extractionWarnings: page.extractionWarnings ?? [],
          durationMs: Date.now() - started,
          retryCount: 0,
          ...(classification.error ? { error: classification.error } : {}),
        };
      } catch (error) {
        if (options?.signal?.aborted) throw options.signal.reason ?? error;
        return {
          outcome: 'transport_error', requestedUrl: url, finalUrl: url, title: '', content: '', provider: 'local-fetch-primary', extractionWarnings: [], durationMs: Date.now() - started, retryCount: 0,
          error: { code: 'FETCH_FAILED', message: error instanceof Error ? error.message : String(error) },
        };
      }
    },
    async close() {
      await Promise.all([browserAdapter.close(), closeHtmlExtractionPool()]);
    },
  };
}
