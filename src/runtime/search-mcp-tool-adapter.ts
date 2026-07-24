import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio';

import type { FetchedPageRecord, KerryCleaningRecord } from '../fetch-fusion/types.js';
import type { SearchDiscoveryRecord } from '../search-fusion/types.js';
import type { FetchTool, SearchTool } from './tool-registry.js';
import { withTimeout } from './reliability.ts';

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
    access_source_grade: typeof item.access_source_grade === 'string'
      ? item.access_source_grade as SearchDiscoveryRecord['access_source_grade']
      : undefined,
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
      is_suspected_reprint: false,
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

  const client = new Client({ name: 'local-policy-agent', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command,
    args,
    env,
    cwd: options.cwd,
    stderr: 'inherit',
  });

  await client.connect(transport);

  const searchLimit = options.searchLimit ?? DEFAULT_SEARCH_LIMIT;
  const fetchMaxChars = options.fetchMaxChars ?? DEFAULT_FETCH_MAX_CHARS;
  const engines = options.engines ?? DEFAULT_ENGINES;

  return {
    searchTool: {
      search: async (query: string) => {
        const result = await withTimeout(client.callTool({
          name: 'search_auto',
          arguments: {
            query,
            limit: searchLimit,
            engines,
          },
        }), options.requestTimeoutMs ?? Number(process.env.LIVE_AUDIT_SEARCH_TIMEOUT_MS ?? 45_000), `search:${query}`);
        const structured = getStructuredContent(result);
        const items = Array.isArray(structured.results) ? structured.results : [];
        return items
          .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
          .map((item) => mapSearchResult(query, item));
      },
    },
    fetchTool: {
      fetch: async (url: string) => {
        const result = await withTimeout(client.callTool({
          name: 'fetch_url',
          arguments: {
            url,
            maxChars: fetchMaxChars,
          },
        }), options.requestTimeoutMs ?? Number(process.env.LIVE_AUDIT_FETCH_TIMEOUT_MS ?? 45_000), `fetch:${url}`);
        const structured = getStructuredContent(result);
        return mapFetchResult(url, structured);
      },
    },
    close: async () => {
      await withTimeout(transport.close(), options.closeTimeoutMs ?? Number(process.env.LIVE_AUDIT_MCP_CLOSE_TIMEOUT_MS ?? 10_000), 'mcp:close');
    },
  };
}
