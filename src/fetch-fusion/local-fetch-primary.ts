import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Worker } from 'node:worker_threads';

import { fetchWithBrowserFallback, type BrowserAdapter } from './browser-fetch.js';
import { detectSuspectedReprint } from './evidence-clues.js';
import type { FetchEvidenceClues, FetchedPageRecord } from './types.js';
import { assertSafeNetworkTarget } from './network-safety.js';
import { DESKTOP_USER_AGENT } from './user-agents.ts';

const MAX_HTML_CHARS = 2_000_000;
const WORKER_THRESHOLD_CHARS = 100_000;
const DEFAULT_EXTRACTION_POOL_SIZE = 2;
const DEFAULT_EXTRACTION_QUEUE_SIZE = 16;
const DEFAULT_EXTRACTION_TIMEOUT_MS = 20_000;

export interface HtmlExtractionResult {
  title: string;
  content: string;
  officialUrls: string[];
  warnings?: string[];
}

interface HtmlExtractionRequest {
  id: number;
  html: string;
  url: string;
  generic?: boolean;
}

interface HtmlExtractionResponse {
  id: number;
  result?: HtmlExtractionResult;
  error?: string;
}

export interface HtmlExtractionWorker {
  postMessage(message: HtmlExtractionRequest): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  terminate(): Promise<number> | number;
  ref?(): void;
  unref?(): void;
}

export interface HtmlExtractionPool {
  extract(
    html: string,
    url: string,
    options?: { signal?: AbortSignal; timeoutMs?: number; generic?: boolean },
  ): Promise<HtmlExtractionResult>;
  close(): Promise<void>;
}

interface ExtractionJob {
  id: number;
  html: string;
  url: string;
  resolve: (result: HtmlExtractionResult) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  timer?: NodeJS.Timeout;
  state: 'queued' | 'active' | 'settled';
  slot?: WorkerSlot;
  generic?: boolean;
}

interface WorkerSlot {
  worker: HtmlExtractionWorker;
  active?: ExtractionJob;
  retiring: boolean;
  termination?: Promise<void>;
}

function poolError(code: string, message: string, name = 'Error'): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.name = name;
  error.code = code;
  return error;
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function createHtmlExtractionPool(options: {
  size?: number;
  maxQueue?: number;
  timeoutMs?: number;
  workerFactory?: () => HtmlExtractionWorker;
} = {}): HtmlExtractionPool {
  const size = positiveInteger(String(options.size ?? ''), DEFAULT_EXTRACTION_POOL_SIZE);
  const maxQueue = Number.isSafeInteger(options.maxQueue) && (options.maxQueue ?? -1) >= 0
    ? options.maxQueue!
    : DEFAULT_EXTRACTION_QUEUE_SIZE;
  const defaultTimeoutMs = positiveInteger(String(options.timeoutMs ?? ''), DEFAULT_EXTRACTION_TIMEOUT_MS);
  const workerFactory = options.workerFactory ?? (() =>
    new Worker(new URL('./html-extraction-worker.cjs', import.meta.url)) as unknown as HtmlExtractionWorker);
  const slots = new Set<WorkerSlot>();
  const queue: ExtractionJob[] = [];
  let nextJobId = 1;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const settle = (job: ExtractionJob, outcome: { result: HtmlExtractionResult } | { error: unknown }) => {
    if (job.state === 'settled') return;
    job.state = 'settled';
    if (job.timer) clearTimeout(job.timer);
    if (job.abortListener) job.signal?.removeEventListener('abort', job.abortListener);
    job.slot = undefined;
    if ('result' in outcome) job.resolve(outcome.result);
    else job.reject(outcome.error);
  };

  const retireSlot = (slot: WorkerSlot): Promise<void> => {
    if (slot.termination) return slot.termination;
    slot.retiring = true;
    slot.termination = Promise.resolve(slot.worker.terminate())
      .catch(() => undefined)
      .then(() => {
        slots.delete(slot);
        dispatch();
      });
    return slot.termination;
  };

  function dispatch(): void {
    if (closed) return;
    while (queue.length > 0) {
      let slot = Array.from(slots).find((candidate) => !candidate.retiring && !candidate.active);
      if (!slot && slots.size < size) {
        try {
          const worker = workerFactory();
          slot = { worker, retiring: false };
          slots.add(slot);
          worker.on('message', (message: HtmlExtractionResponse) => {
            if (slot?.retiring || !slot?.active || message.id !== slot.active.id) return;
            const completed = slot.active;
            slot.active = undefined;
            worker.unref?.();
            if (message.error) {
              settle(completed, { error: poolError('HTML_EXTRACTION_FAILED', message.error) });
            } else if (message.result) {
              settle(completed, { result: message.result });
            } else {
              settle(completed, { error: poolError('HTML_EXTRACTION_INVALID_RESPONSE', 'HTML extraction worker returned an invalid response.') });
            }
            dispatch();
          });
          worker.on('error', (error: Error) => {
            if (!slot || slot.retiring) return;
            slot.retiring = true;
            if (slot.active) {
              const failed = slot.active;
              slot.active = undefined;
              settle(failed, { error: poolError('HTML_EXTRACTION_WORKER_ERROR', error.message) });
            }
            void retireSlot(slot);
          });
          worker.on('exit', (code: number) => {
            if (!slot || slot.retiring) return;
            slot.retiring = true;
            if (slot.active) {
              const failed = slot.active;
              slot.active = undefined;
              settle(failed, {
                error: poolError('HTML_EXTRACTION_WORKER_EXIT', `HTML extraction worker exited unexpectedly with code ${code}.`),
              });
            }
            slots.delete(slot);
            dispatch();
          });
          worker.unref?.();
        } catch (error) {
          const failed = queue.shift();
          if (failed) settle(failed, { error });
          continue;
        }
      }
      if (!slot) return;
      const job = queue.shift();
      if (!job || job.state !== 'queued') continue;
      slot.active = job;
      job.state = 'active';
      job.slot = slot;
      slot.worker.ref?.();
      try {
        slot.worker.postMessage({ id: job.id, html: job.html, url: job.url, generic: job.generic });
      } catch (error) {
        slot.active = undefined;
        settle(job, { error });
        void retireSlot(slot);
      }
    }
  }

  const retireActive = (job: ExtractionJob, error: unknown) => {
    const slot = job.slot;
    if (!slot || slot.retiring) {
      settle(job, { error });
      return;
    }
    slot.active = undefined;
    settle(job, { error });
    void retireSlot(slot);
  };

  return {
    extract(html, url, extractOptions = {}) {
      if (closed) return Promise.reject(poolError('HTML_EXTRACTION_POOL_CLOSED', 'HTML extraction pool is closed.'));
      if (extractOptions.signal?.aborted) return Promise.reject(abortReason(extractOptions.signal));
      const hasCapacity = Array.from(slots).some((slot) => !slot.retiring && !slot.active) || slots.size < size;
      if (!hasCapacity && queue.length >= maxQueue) {
        return Promise.reject(poolError('HTML_EXTRACTION_QUEUE_FULL', `HTML extraction queue is full (${maxQueue}).`));
      }

      return new Promise<HtmlExtractionResult>((resolve, reject) => {
        const job: ExtractionJob = {
          id: nextJobId++,
          html,
          url,
          resolve,
          reject,
          signal: extractOptions.signal,
          generic: extractOptions.generic,
          state: 'queued',
        };
        const timeoutMs = positiveInteger(String(extractOptions.timeoutMs ?? ''), defaultTimeoutMs);
        job.abortListener = () => {
          if (job.state === 'queued') {
            const index = queue.indexOf(job);
            if (index >= 0) queue.splice(index, 1);
            settle(job, { error: abortReason(job.signal) });
          } else if (job.state === 'active') {
            retireActive(job, abortReason(job.signal));
          }
        };
        extractOptions.signal?.addEventListener('abort', job.abortListener, { once: true });
        job.timer = setTimeout(() => {
          const error = poolError(
            'HTML_EXTRACTION_TIMEOUT',
            `HTML extraction timed out after ${timeoutMs} ms.`,
            'TimeoutError',
          );
          if (job.state === 'queued') {
            const index = queue.indexOf(job);
            if (index >= 0) queue.splice(index, 1);
            settle(job, { error });
          } else if (job.state === 'active') {
            retireActive(job, error);
          }
        }, timeoutMs);
        queue.push(job);
        dispatch();
      });
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      const error = poolError('HTML_EXTRACTION_POOL_CLOSED', 'HTML extraction pool is closed.');
      for (const job of queue.splice(0)) settle(job, { error });
      const terminations = Array.from(slots).map(async (slot) => {
        if (slot.active) {
          const active = slot.active;
          slot.active = undefined;
          settle(active, { error });
        }
        await retireSlot(slot);
      });
      closePromise = Promise.all(terminations).then(() => { slots.clear(); });
      return closePromise;
    },
  };
}

let defaultExtractionPool: HtmlExtractionPool | undefined;

function getDefaultExtractionPool(): HtmlExtractionPool {
  defaultExtractionPool ??= createHtmlExtractionPool({
    size: positiveInteger(process.env.FETCH_HTML_WORKER_POOL_SIZE, DEFAULT_EXTRACTION_POOL_SIZE),
    maxQueue: positiveInteger(process.env.FETCH_HTML_QUEUE_CAPACITY, DEFAULT_EXTRACTION_QUEUE_SIZE),
    timeoutMs: positiveInteger(process.env.FETCH_HTML_TIMEOUT_MS, DEFAULT_EXTRACTION_TIMEOUT_MS),
  });
  return defaultExtractionPool;
}

export async function closeHtmlExtractionPool(): Promise<void> {
  const pool = defaultExtractionPool;
  defaultExtractionPool = undefined;
  await pool?.close();
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted)
    || (error instanceof Error && (error.name === 'AbortError' || error.name === 'RuntimeTimeoutError'));
}

function parseHtml(html: string, url?: string, warnings: string[] = []): JSDOM {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error: { message: string }) => {
    if (/stylesheet|css/i.test(error.message)) warnings.push(`css_parse_warning: ${error.message}`);
    else console.warn(error.message);
  });
  return new JSDOM(html, { ...(url ? { url } : {}), virtualConsole });
}

export function normalizeFetchedPage(input: FetchedPageRecord, options: { generic?: boolean } = {}): FetchedPageRecord {
  const normalized: FetchedPageRecord = {
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    title: input.title,
    content: input.content,
    backend: input.backend,
    ...(options.generic ? {} : {
      evidence_clues: input.evidence_clues ?? {
        is_suspected_reprint: false,
        extracted_doc_no: null,
        potential_official_urls: [],
      },
    }),
  };

  const optionalFields: Array<keyof Pick<
    FetchedPageRecord,
    | 'publishedAt'
    | 'updatedAt'
    | 'lastVerifiedAt'
    | 'statusCode'
    | 'contentType'
    | 'contentLength'
    | 'truncated'
    | 'pageRenderMode'
    | 'accessSignals'
    | 'freshnessStatus'
    | 'dateEvidence'
    | 'extractionWarnings'
    | 'qualityCategory'
    | 'validationReason'
  >> = [
    'publishedAt',
    'updatedAt',
    'lastVerifiedAt',
    'statusCode',
    'contentType',
    'contentLength',
    'truncated',
    'pageRenderMode',
    'accessSignals',
    'freshnessStatus',
    'dateEvidence',
    'extractionWarnings',
    'qualityCategory',
    'validationReason',
  ];

  for (const field of optionalFields) {
    if (input[field] !== undefined) {
      (normalized as unknown as Record<string, unknown>)[field] = input[field];
    }
  }

  if (input.kerry_cleaning) {
    normalized.kerry_cleaning = input.kerry_cleaning;
  }

  return normalized;
}

export function normalizeDocumentNumber(rawDocNo: string | null): string | null {
  if (!rawDocNo) {
    return null;
  }

  return rawDocNo
    .replace(/[\s ]+/g, '')
    .replace(/[\[\{\(【]/g, '〔')
    .replace(/[\]\}\)】]/g, '〕');
}

function cleanGovernmentContent(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .filter((line) => !/^(首页导航|登录|注册)$/i.test(line))
    .filter((line) => !/^(首页导航|登录|注册)\b/i.test(line))
    .filter((line) => !/^(首页导航|登录|注册)(\s+|$)/i.test(line))
    .filter((line) => !/(上一篇|下一篇)/i.test(line))
    .filter((line) => !/(热门解读|相关推荐)/i.test(line))
    .join('\n');
}

function extractPotentialOfficialUrls(document: Document, url: string): string[] {
  try {
    const urls = Array.from(document.querySelectorAll('a[href]'))
      .map((anchor) => (anchor as Element).getAttribute('href') ?? '')
      .map((href) => {
        try {
          return new URL(href, url).toString();
        } catch {
          return '';
        }
      })
      .filter((href) => /\.gov\.cn(?=\/|$)/i.test(href));

    return Array.from(new Set(urls));
  } catch {
    return [];
  }
}

function extractDocumentNumber(text: string): string | null {
  const normalizedText = text.replace(/[\s ]+/g, '');
  const match = normalizedText.match(/[一-龥]{1,12}(?:发|规|办发|字|函|通|〔)\[(?:20\d{2})\]\d+号|[一-龥]{1,12}(?:发|规|办发|字|函|通)?〔20\d{2}〕\d+号/u);
  return match?.[0] ?? null;
}

function buildEvidenceClues(args: {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  content: string;
  potentialOfficialUrls?: string[];
}): FetchEvidenceClues {
  const combinedText = `${args.title}\n${args.content}`;
  return {
    is_suspected_reprint: detectSuspectedReprint(args),
    extracted_doc_no: normalizeDocumentNumber(extractDocumentNumber(combinedText)),
    potential_official_urls: args.potentialOfficialUrls ?? [],
  };
}

function cleanGenericContent(content: string): string {
  return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join('\n');
}

export function isWeakFetchedContent(title: string, content: string): boolean {
  const combined = `${title}\n${content}`.trim();
  const readableChars = (combined.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return !combined
    || combined.length < 400
    || readableChars < 80
    || /enable javascript|javascript required|请启用 javascript|正在加载|loading\.\.\.|captcha|验证码|安全验证|登录后继续|sign in to continue|access denied/i.test(combined);
}

function extractMainArticleSync(html: string, url: string, generic = false): HtmlExtractionResult {
  let dom: JSDOM | undefined;
  const warnings: string[] = [];
  try {
    dom = parseHtml(html, url, warnings);
    const documentTitle = dom.window.document.title?.trim() ?? '';
    const officialUrls = generic ? [] : extractPotentialOfficialUrls(dom.window.document, url);
    const rawText = dom.window.document.body?.textContent ?? '';
    const article = new Readability(dom.window.document).parse();
    const container = dom.window.document.createElement('div');
    container.innerHTML = article?.content ?? '';
    const result = {
      title: article?.title?.trim() || documentTitle,
      content: generic ? cleanGenericContent(container.textContent || rawText) : cleanGovernmentContent(container.textContent || rawText),
      officialUrls,
      warnings,
    };
    return result;
  } catch {
    return { title: '', content: '', officialUrls: [], warnings };
  } finally {
    dom?.window.close();
  }
}

async function extractMainArticle(
  html: string,
  url: string,
  options: { signal?: AbortSignal; timeoutMs?: number; pool?: HtmlExtractionPool; generic?: boolean } = {},
): Promise<HtmlExtractionResult> {
  if (html.length < WORKER_THRESHOLD_CHARS) return extractMainArticleSync(html, url, options.generic);
  return await (options.pool ?? getDefaultExtractionPool()).extract(html, url, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    generic: options.generic,
  });
}

export async function fetchWithLocalPrimary(
  url: string,
  maxChars = 20000,
  options: {
    fetchImpl?: (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ text: () => Promise<string>; url?: string; status?: number; headers?: { get(name: string): string | null } }>;
    enableBrowserFallback?: boolean;
    browserAdapter?: BrowserAdapter;
    browserTimeoutMs?: number;
    dateWindow?: { start: string; end: string };
    signal?: AbortSignal;
    extractionTimeoutMs?: number;
    extractionPool?: HtmlExtractionPool;
    generic?: boolean;
  } = {},
): Promise<FetchedPageRecord> {
  assertSafeNetworkTarget(url);
  const webFetch = (globalThis as {
    WebFetch?: (input: { url: string; prompt: string; signal?: AbortSignal }) => Promise<{
      content?: string;
      finalUrl?: string;
      title?: string;
    } | string>;
  }).WebFetch;
  let webFetchWarning: string | undefined;

  const prompt = options.generic
    ? `Fetch this page and return its main readable content. Limit output to about ${maxChars} characters. Preserve the page's title, body text, and links needed to understand the source.`
    : `Fetch this page and return the main policy text. Limit output to about ${maxChars} characters. Focus on the official body content and skip site chrome, login links, and prev/next navigation.`;

  if (typeof webFetch === 'function') {
    try {
      const response = await webFetch({
        url,
        prompt,
        signal: options.signal,
      });

      const webFetchContent = typeof response === 'string' ? response : response && typeof response === 'object' ? response.content ?? '' : '';
      const content = (options.generic ? cleanGenericContent(webFetchContent) : cleanGovernmentContent(webFetchContent)).slice(0, maxChars);
      const finalUrl = typeof response === 'object' && response?.finalUrl ? response.finalUrl : url;
      const title = typeof response === 'object' && response?.title ? response.title : '';
      assertSafeNetworkTarget(finalUrl);
      const weakWebFetch = isWeakFetchedContent(title, content);
      if (!weakWebFetch || typeof options.fetchImpl !== 'function') {
        return normalizeFetchedPage({
          requestedUrl: url,
          finalUrl,
          title,
          content,
          backend: 'local-fetch-primary',
          contentLength: new TextEncoder().encode(content).byteLength,
          ...(weakWebFetch ? { extractionWarnings: ['webfetch_weak: response is empty, short, or appears to be a challenge page'] } : {}),
          ...(options.generic ? {} : { evidence_clues: buildEvidenceClues({ requestedUrl: url, finalUrl, title, content }) }),
        }, { generic: options.generic });
      }

      webFetchWarning = 'webfetch_weak: response is empty, short, or appears to be a challenge page; falling back to local fetch';
    } catch (error) {
      if (isCancellation(error, options.signal)) throw error;
      if (typeof options.fetchImpl !== 'function') {
        throw error;
      }
    }
  }

  if (typeof options.fetchImpl !== 'function') {
    throw new Error('WebFetch is not available in this runtime.');
  }

  const fallbackResponse = await options.fetchImpl(url, {
    headers: {
      'user-agent': DESKTOP_USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      referer: 'https://www.baidu.com/',
    },
    signal: options.signal,
  });
  const rawFallbackText = await fallbackResponse.text();
  const htmlWasTruncated = rawFallbackText.length > MAX_HTML_CHARS;
  const fallbackText = rawFallbackText.slice(0, MAX_HTML_CHARS);
  const finalUrl = fallbackResponse.url ?? url;
  assertSafeNetworkTarget(finalUrl);
  let extracted: HtmlExtractionResult = { title: '', content: '', officialUrls: [], warnings: [] };
  let extractionWarnings: string[] = [];
  try {
    extracted = await extractMainArticle(fallbackText, finalUrl, {
      signal: options.signal,
      timeoutMs: options.extractionTimeoutMs,
      pool: options.extractionPool,
      generic: options.generic,
    });
    extractionWarnings = extracted.warnings ?? [];
  } catch (error) {
    if (isCancellation(error, options.signal)) throw error;
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : 'HTML_EXTRACTION_FAILED';
    extractionWarnings = [`static_extraction_failed: ${code}: ${error instanceof Error ? error.message : String(error)}`];
  }
  const content = extracted.content.slice(0, maxChars);
  const title = extracted.title;

  const record = normalizeFetchedPage({
    requestedUrl: url,
    finalUrl,
    title,
    content,
    backend: 'local-fetch-primary',
    statusCode: fallbackResponse.status,
    contentType: fallbackResponse.headers?.get('content-type') ?? undefined,
    contentLength: new TextEncoder().encode(rawFallbackText).byteLength,
    truncated: htmlWasTruncated,
    ...(options.generic ? {} : { evidence_clues: buildEvidenceClues({ requestedUrl: url, finalUrl, title, content, potentialOfficialUrls: extracted.officialUrls }) }),
    extractionWarnings: [
      ...(webFetchWarning ? [webFetchWarning] : []),
      ...extractionWarnings,
      ...(htmlWasTruncated ? [`html_truncated: response exceeded ${MAX_HTML_CHARS} characters`] : []),
      ...(content.length < 400 ? ['static_extraction_weak: extracted content is too short for reliable evidence'] : []),
    ],
  }, { generic: options.generic });

  if (!options.enableBrowserFallback) {
    return record;
  }

  return await fetchWithBrowserFallback(url, {
    staticFetch: async (_url, signal) => {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
      }
      return {
        title: record.title,
        content: record.content,
        finalUrl: record.finalUrl,
        statusCode: record.statusCode,
        contentType: record.contentType,
        contentLength: record.contentLength,
        truncated: record.truncated,
        extractionWarnings: record.extractionWarnings,
      };
    },
    browser: options.browserAdapter,
    timeoutMs: options.browserTimeoutMs,
    now: new Date().toISOString(),
    dateWindow: options.dateWindow,
    signal: options.signal,
    derivePageFacts: !options.generic,
    extractHtml: async (html, extractedUrl, extractionOptions) => {
      const extracted = await extractMainArticle(html, extractedUrl, {
        signal: extractionOptions.signal,
        timeoutMs: extractionOptions.timeoutMs ?? options.extractionTimeoutMs,
        pool: options.extractionPool,
        generic: options.generic,
      });
      return { title: extracted.title, content: extracted.content, warnings: extracted.warnings };
    },
  });
}
