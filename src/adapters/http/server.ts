import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runAgent } from '../../app/run-agent.ts';
import type { ResearchAgentDependencies } from '../../agent/agent-loop.ts';
import type { ResearchTask } from '../../agent/types.ts';
import type { ResearchRunManager } from '../../app/run-manager.ts';
import type { ResearchRun } from '../../app/run-manager.ts';
import { monitorPage } from './monitor-page.ts';
import { validateResearchTask } from '../../agent/task-validation.ts';

const MAX_REQUEST_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 30_000;

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      request.destroy();
      throw new Error('request_body_too_large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseOptions(value: unknown): ResearchTask['options'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('options_must_be_object');
  return value as ResearchTask['options'];
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const data = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  response.end(data);
}

function runProjection(run: ResearchRun): Record<string, unknown> {
  const result = run.result;
  return {
    runId: run.runId,
    status: run.status,
    question: run.task.question,
    options: run.task.options,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    cancellationRequestedAt: run.cancellationRequestedAt,
    ...('settledAt' in run ? { settledAt: run.settledAt } : {}),
    error: run.error,
    report: run.report,
    reportStatus: run.reportStatus,
    reportError: run.reportError,
    counts: {
      events: run.events.length,
      iterations: result?.state.currentIteration ?? 0,
      searchResults: result?.state.searchResults.length ?? 0,
      fetchedPages: result?.state.fetchedPages.length ?? 0,
      findings: result?.decision.findings?.filter((finding) => finding.disposition === 'confirmed').length ?? 0,
      submittedFindings: result?.decision.findings?.length ?? 0,
      protocolErrors: run.events.filter((event) => event.type === 'agent.protocol_error').length,
      modelErrors: run.events.filter((event) => event.type === 'agent.model_error').length,
    },
    answerAvailable: typeof result?.state.finalAnswer === 'string' && result.state.finalAnswer.trim().length > 0,
  };
}

function nonNegativeInteger(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('invalid_event_cursor');
  return parsed;
}

export interface ResearchHttpServerOptions {
  exposeAtomicTools?: boolean;
  authToken?: string;
}

function authorized(request: IncomingMessage, expectedToken: string | undefined): boolean {
  if (!expectedToken) return true;
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(authorization.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

export function createResearchHttpServer(dependencies: ResearchAgentDependencies, runManager?: ResearchRunManager, options: ResearchHttpServerOptions = {}): Server {
  const exposeAtomicTools = options.exposeAtomicTools === true;
  const server = createServer(async (request, response) => {
    try {
      const parsedUrl = new URL(request.url ?? '/', 'http://local-policy-agent.invalid');
      const pathname = parsedUrl.pathname;
      if (request.method === 'GET' && pathname === '/v1/health') return json(response, 200, { ok: true });
      if (request.method === 'GET' && pathname === '/monitor') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" }); response.end(monitorPage); return;
      }
      if (!authorized(request, options.authToken)) {
        response.setHeader('www-authenticate', 'Bearer realm="research"');
        return json(response, 401, { error: 'unauthorized' });
      }
      if (request.method === 'GET' && runManager && pathname === '/v1/research') return json(response, 200, { runs: runManager.list().map(runProjection) });
      if (request.method === 'GET' && pathname.startsWith('/artifacts/')) {
        const relative = decodeURIComponent(pathname.slice(1));
        if (relative.includes('..') || path.isAbsolute(relative)) return json(response, 400, { error: 'invalid_artifact_path' });
        const filePath = path.resolve(process.cwd(), relative);
        const allowedRoot = path.resolve(process.cwd(), 'artifacts') + path.sep;
        if (!filePath.startsWith(allowedRoot)) return json(response, 403, { error: 'artifact_path_forbidden' });
        try {
          const data = await readFile(filePath);
          const contentType = filePath.endsWith('.html') ? 'text/html; charset=utf-8' : filePath.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
          response.writeHead(200, { 'content-type': contentType, 'content-length': data.byteLength }); response.end(data);
        } catch { json(response, 404, { error: 'artifact_not_found' }); }
        return;
      }
      if (request.method === 'GET' && runManager && pathname.startsWith('/v1/research/')) {
        const parts = pathname.split('/').filter(Boolean); const runId = parts[2];
        if (parts.length === 4 && parts[3] === 'events') {
          const events = runManager.events(runId);
          if (!events) return json(response, 404, { error: 'run_not_found' });
          const afterSequence = nonNegativeInteger(parsedUrl.searchParams.get('afterSequence'), 0);
          const limit = Math.min(1_000, Math.max(1, nonNegativeInteger(parsedUrl.searchParams.get('limit'), 500)));
          const page = events.filter((event) => event.sequence > afterSequence).slice(0, limit);
          return json(response, 200, { runId, events: page, nextSequence: page.at(-1)?.sequence ?? afterSequence, hasMore: events.some((event) => event.sequence > (page.at(-1)?.sequence ?? afterSequence)) });
        }
        if (parts.length !== 3) return json(response, 404, { error: 'not_found' });
        const run = runManager.get(runId);
        if (!run) return json(response, 404, { error: 'run_not_found' });
        return json(response, 200, parsedUrl.searchParams.get('include') === 'full' ? run : runProjection(run));
      }
      if (request.method === 'POST' && runManager && pathname.startsWith('/v1/research/')) {
        const parts = pathname.split('/').filter(Boolean); const runId = parts[2];
        if (parts.length !== 4 || parts[3] !== 'cancel') return json(response, 404, { error: 'not_found' });
        if (!runManager.get(runId)) return json(response, 404, { error: 'run_not_found' });
        const accepted = runManager.cancel(runId);
        return json(response, accepted ? 202 : 200, runManager.get(runId));
      }
      const allowedPostRoutes = exposeAtomicTools ? ['/v1/research', '/v1/search', '/v1/fetch'] : ['/v1/research'];
      if (request.method !== 'POST' || !allowedPostRoutes.includes(pathname)) return json(response, 404, { error: 'not_found' });
      const parsed = JSON.parse(await body(request)) as Partial<ResearchTask> & { query?: unknown; url?: unknown };
      if (pathname === '/v1/search') {
        const query = (parsed as { query?: unknown }).query;
        if (typeof query !== 'string' || !query.trim()) return json(response, 400, { error: 'query_required' });
        return json(response, 200, await dependencies.search.search(query));
      }
      if (pathname === '/v1/fetch') {
        const url = (parsed as { url?: unknown }).url;
        if (typeof url !== 'string' || !url.trim()) return json(response, 400, { error: 'url_required' });
        return json(response, 200, await dependencies.fetch.fetch(url));
      }
      if (typeof parsed.question !== 'string' || !parsed.question.trim()) return json(response, 400, { error: 'question_required' });
      const task = { question: parsed.question.trim(), ...(parsed.options !== undefined ? { options: parseOptions(parsed.options) } : {}) };
      validateResearchTask(task);
      if (runManager) return json(response, 202, runManager.start(task));
      const result = await runAgent(task, dependencies);
      return json(response, result.status === 'failed' ? 422 : 200, result);
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 5_000;
  return server;
}
