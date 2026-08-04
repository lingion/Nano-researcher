import type { DebugEvent } from './ask-real-claude.js';

export interface DebugSanitizeOptions {
  maxStringLength?: number;
  maxArrayItems?: number;
  maxObjectKeys?: number;
}

const DEFAULTS: Required<DebugSanitizeOptions> = {
  maxStringLength: 256,
  maxArrayItems: 20,
  maxObjectKeys: 40,
};

const SENSITIVE_KEYS = new Set([
  'prompt', 'state', 'rawtext', 'rawoutput', 'content', 'body', 'html', 'text',
  'headers', 'requestheaders', 'responseheaders', 'stack', 'message', 'diagnostics',
  'token', 'apikey', 'authorization', 'cookie', 'password', 'secret', 'accesstoken', 'refreshtoken',
  'query', 'why',
]);

function keyToken(key: string): string {
  return key.replace(/[-_\s]/g, '').toLowerCase();
}

function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

function sanitize(value: unknown, options: Required<DebugSanitizeOptions>, seen: WeakSet<object>, key?: string, preserveActionFields = false): unknown {
  if (key && SENSITIVE_KEYS.has(keyToken(key)) && !(preserveActionFields && (keyToken(key) === 'query' || keyToken(key) === 'why'))) return undefined;
  if (typeof value === 'string') {
    const result = keyToken(key ?? '') === 'url' ? safeUrl(value) : value;
    return result?.slice(0, options.maxStringLength);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return `[bigint:${value.toString().slice(0, 32)}]`;
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'undefined') return undefined;
  if (value instanceof Error) return summarizeError(value);
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, options.maxArrayItems).map((item) => sanitize(item, options, seen, undefined, preserveActionFields)).filter((item) => item !== undefined);
    }
    const result: Record<string, unknown> = {};
    for (const objectKey of Object.keys(value).slice(0, options.maxObjectKeys)) {
      let child: unknown;
      try { child = (value as Record<string, unknown>)[objectKey]; } catch { continue; }
      const childPreservesActionFields = preserveActionFields || keyToken(objectKey) === 'searchactions' || keyToken(objectKey) === 'fetchactions';
      const sanitized = sanitize(child, options, seen, objectKey, childPreservesActionFields);
      if (sanitized !== undefined) result[objectKey] = sanitized;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function sanitizeDebugValue(value: unknown, options: DebugSanitizeOptions = {}): unknown {
  return sanitize(value, { ...DEFAULTS, ...options }, new WeakSet<object>());
}

export function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const result: Record<string, unknown> = { name: error.name };
    for (const key of ['code', 'status', 'statusCode', 'retryable', 'scope']) {
      try {
        const value = (error as unknown as Record<string, unknown>)[key];
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') result[key] = value;
      } catch { /* ignore hostile getters */ }
    }
    return result;
  }
  return { name: 'UnknownError', type: typeof error };
}

export function summarizeSearchResults(results: unknown): Record<string, unknown> {
  const items = Array.isArray(results) ? results : [];
  return {
    count: items.length,
    items: items.slice(0, DEFAULTS.maxArrayItems).map((item) => {
      if (!item || typeof item !== 'object') return { type: typeof item };
      const record = item as Record<string, unknown>;
      const summary: Record<string, unknown> = {};
      const url = typeof record.url === 'string' ? safeUrl(record.url) : undefined;
      if (url) summary.url = url;
      for (const key of ['status', 'title', 'source', 'publishedAt', 'updatedAt']) {
        const value = record[key];
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') summary[key] = typeof value === 'string' ? value.slice(0, DEFAULTS.maxStringLength) : value;
      }
      return summary;
    }),
  };
}

export function summarizeFetchedPage(page: unknown): Record<string, unknown> {
  if (!page || typeof page !== 'object') return { type: typeof page };
  const record = page as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  if (typeof record.url === 'string') {
    const url = safeUrl(record.url);
    if (url) result.url = url;
  }
  for (const key of ['status', 'statusCode', 'contentType', 'title', 'publishedAt', 'updatedAt', 'qualityCategory', 'freshnessStatus']) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') result[key] = typeof value === 'string' ? value.slice(0, DEFAULTS.maxStringLength) : value;
  }
  for (const key of ['content', 'body', 'text', 'html']) {
    if (typeof record[key] === 'string') result[`${key}Length`] = (record[key] as string).length;
  }
  return result;
}

export function sanitizeDebugEvent(event: DebugEvent, options: DebugSanitizeOptions = {}): DebugEvent {
  return { type: event.type, payload: (sanitizeDebugValue(event.payload, options) as Record<string, unknown>) ?? {} };
}

export function safeSerializeDebugPayload(value: unknown): string {
  try { return JSON.stringify(sanitizeDebugValue(value)) ?? 'null'; } catch { return JSON.stringify({ type: 'unserializable_debug_value' }); }
}
