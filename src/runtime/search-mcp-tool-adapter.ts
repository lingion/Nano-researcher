import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio';

import type { FetchedPageRecord, KerryCleaningRecord } from '../fetch-fusion/types.js';
import { detectSuspectedReprint } from '../fetch-fusion/evidence-clues.js';
import type { SearchDiscoveryRecord, AccessSourceGrade } from '../search-fusion/types.js';
import type { FetchTool, SearchTool } from './tool-registry.js';
import { withTimeout } from './reliability.ts';
import { assertSafeNetworkTarget } from '../fetch-fusion/network-safety.js';

export interface SearchMcpToolOptions {
  command?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  providerConfigPath?: string;
  searchLimit?: number;
  fetchMaxChars?: number;
  engines?: string[];
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
  connectTimeoutMs?: number;
  createClient?: () => Client;
  createTransport?: (options: ConstructorParameters<typeof StdioClientTransport>[0]) => StdioClientTransport;
}

const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_FETCH_MAX_CHARS = 20000;
const DEFAULT_ENGINES = ['bing_cn', 'baidu', '360', 'sogou', 'bing'];
const DEFAULT_WORKER_URL = new URL('../../vendor/search-mcp/src/stdio-server.js', import.meta.url);

export function resolveSearchMcpWorkerPath(env: Pick<NodeJS.ProcessEnv, 'SEARCH_MCP_WORKER_PATH'> = process.env): string {
  return env.SEARCH_MCP_WORKER_PATH || fileURLToPath(DEFAULT_WORKER_URL);
}

function toEnvRecord(input: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function getStructuredContent(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object') return {};
  const record = result as { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> };
  if (record.structuredContent && typeof record.structuredContent === 'object') {
    return record.structuredContent as Record<string, unknown>;
  }
  const textBlock = Array.isArray(record.content)
    ? record.content.find((item) => item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string')
    : null;
  if (textBlock?.text) {
    try {
      return JSON.parse(textBlock.text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string');
  return strings.length ? strings : undefined;
}

const ACCESS_SOURCE_GRADES = new Set<AccessSourceGrade>([
  'official_product',
  'official_access',
  'official_docs',
  'official_announcement',
  'official_github',
  'credible_reporting',
  'noise',
  'corrupted',
]);

function asAccessSourceGrade(value: unknown): AccessSourceGrade | undefined {
  return typeof value === 'string' && ACCESS_SOURCE_GRADES.has(value as AccessSourceGrade)
    ? value as AccessSourceGrade
    : undefined;
}

function mapSearchResult(query: string, item: Record<string, unknown>): SearchDiscoveryRecord {
  return {
    query,
    title: asString(item.title, asString(item.url, 'Untitled result')),
    url: asString(item.url),
    snippet: asString(item.snippet),
    source: asString(item.source || item.engine, 'search-mcp'),
    sources: asStringArray(item.sources),
    quality_status: item.quality_status === 'green' || item.quality_status === 'yellow' ? item.quality_status : undefined,
    quality_reason: asString(item.quality_reason),
    filtered_count: typeof item.filtered_count === 'number' ? item.filtered_count : undefined,
    access_source_grade: asAccessSourceGrade(item.access_source_grade),
    kerry_quality_status: typeof item.quality_status === 'string'
      ? item.quality_status as SearchDiscoveryRecord['kerry_quality_status']
      : typeof item.quality_reason === 'string'
        ? 'usable_results'
        : undefined,
    kerry_quality_reason: asString(item.quality_reason),
  };
}

function mapFetchResult(requestedUrl: string, structured: Record<string, unknown>): FetchedPageRecord {
  const title = asString(structured.title, requestedUrl);
  const finalUrl = asString(structured.finalUrl || structured.url, requestedUrl);
  const cleanedText = asString(structured.cleaned_text || structured.text);
  const rawText = asString(structured.raw_text);
  const kerryCleaning: KerryCleaningRecord = {
    raw_text: rawText || undefined,
    cleaned_text: cleanedText || undefined,
    metadata: structured.metadata && typeof structured.metadata === 'object'
      ? structured.metadata as Record<string, unknown>
      : undefined,
    removed_fragments: Array.isArray(structured.removed_fragments) ? structured.removed_fragments : undefined,
    cleaning_alerts: Array.isArray(structured.cleaning_alerts) ? structured.cleaning_alerts : undefined,
    cleaning_stats: structured.cleaning_stats && typeof structured.cleaning_stats === 'object'
      ? structured.cleaning_stats as Record<string, unknown>
      : undefined,
  };

  const docNo = typeof kerryCleaning.metadata?.document_number === 'string'
    ? kerryCleaning.metadata.document_number
    : null;
  const officialUrls = Array.isArray(kerryCleaning.metadata?.potential_official_urls)
    ? kerryCleaning.metadata.potential_official_urls.filter((item): item is string => typeof item === 'string')
    : [];

  return {
    requestedUrl,
    finalUrl,
    title,
    content: cleanedText,
    backend: 'search-mcp:fetch_url',
    evidence_clues: {
      is_suspected_reprint: detectSuspectedReprint({
      requestedUrl,
      finalUrl,
      title,
      content: cleanedText || rawText,
    }),
      extracted_doc_no: docNo,
      potential_official_urls: officialUrls,
    },
    kerry_cleaning: kerryCleaning,
  };
}

export async function createSearchMcpTools(options: SearchMcpToolOptions = {}): Promise<{
  searchTool: SearchTool;
  fetchTool: FetchTool;
  close: () => Promise<void>;
}> {
  const workerPath = resolveSearchMcpWorkerPath();
  const command = options.command || 'node';
  const args = options.args || [workerPath];
  const env = toEnvRecord({
    ...process.env,
    ...options.env,
    ...(options.providerConfigPath ? { SEARCH_MCP_PROVIDER_CONFIG_PATH: options.providerConfigPath } : {}),
  });

  const client = options.createClient?.() ?? new Client({ name: 'nano-researcher', version: '0.1.0' });
  const transport = options.createTransport?.({
    command,
    args,
    env,
    cwd: options.cwd,
    stderr: 'inherit',
  }) ?? new StdioClientTransport({
    command,
    args,
    env,
    cwd: options.cwd,
    stderr: 'inherit',
  });

  try {
    await withTimeout(
      client.connect(transport),
      options.connectTimeoutMs ?? Number(process.env.LIVE_AUDIT_MCP_CONNECT_TIMEOUT_MS ?? 10_000),
      'mcp:connect',
    );
  } catch (error) {
    try {
      await withTimeout(
        transport.close(),
        options.closeTimeoutMs ?? Number(process.env.LIVE_AUDIT_MCP_CLOSE_TIMEOUT_MS ?? 10_000),
        'mcp:connect-cleanup',
      );
    } catch {
      // Preserve the handshake failure; cleanup is best-effort on failed setup.
    }
    throw error;
  }

  const searchLimit = options.searchLimit ?? DEFAULT_SEARCH_LIMIT;
  const fetchMaxChars = options.fetchMaxChars ?? DEFAULT_FETCH_MAX_CHARS;
  const engines = options.engines ?? DEFAULT_ENGINES;
  let closed = false;

  return {
    searchTool: {
      search: async (query: string, signal?: AbortSignal) => {
        const result = await withTimeout(
          (requestSignal) => client.callTool({
            name: 'search_auto',
            arguments: {
              query,
              limit: searchLimit,
              engines,
            },
          }, undefined, { signal: requestSignal }),
          options.requestTimeoutMs ?? Number(process.env.LIVE_AUDIT_SEARCH_TIMEOUT_MS ?? 45_000), `search:${query}`, undefined, signal);
        const structured = getStructuredContent(result);
        const items = Array.isArray(structured.results) ? structured.results : [];
        return items
          .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
          .map((item) => mapSearchResult(query, item));
      },
    },
    fetchTool: {
      fetch: async (url: string, signal?: AbortSignal) => {
        assertSafeNetworkTarget(url);
        const result = await withTimeout(
          (requestSignal) => client.callTool({
            name: 'fetch_url',
            arguments: {
              url,
              maxChars: fetchMaxChars,
            },
          }, undefined, { signal: requestSignal }),
          options.requestTimeoutMs ?? Number(process.env.LIVE_AUDIT_FETCH_TIMEOUT_MS ?? 45_000), `fetch:${url}`, undefined, signal);
        const structured = getStructuredContent(result);
        return mapFetchResult(url, structured);
      },
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await withTimeout(transport.close(), options.closeTimeoutMs ?? Number(process.env.LIVE_AUDIT_MCP_CLOSE_TIMEOUT_MS ?? 10_000), 'mcp:close');
    },
  };
}
