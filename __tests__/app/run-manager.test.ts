import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ResearchRunManager } from '../../src/app/run-manager.ts';

const TERMINAL_EVENTS = new Set(['run.completed', 'run.interrupted', 'run.failed', 'run.cancelled']);

function terminalEvents(run: ReturnType<ResearchRunManager['get']>) {
  return run?.events.filter((event) => TERMINAL_EVENTS.has(event.type)) ?? [];
}

async function waitForSettled(manager: ResearchRunManager, runId: string) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const run = manager.get(runId)!;
    if (run.settledAt) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('run did not settle');
}

test('a cancellation request remains non-terminal until the provider settles', async () => {
  let release!: () => void;
  const manager = new ResearchRunManager({
    llm: {
      complete: async () => new Promise<{ text: string; finishReason: string; structuredOutputMode: 'tool_call'; toolCallCount: number }>((resolve) => {
        release = () => resolve({
          text: JSON.stringify({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'late answer', evidenceUrls: [], findings: [] }),
          finishReason: 'tool_calls', structuredOutputMode: 'tool_call', toolCallCount: 1,
        });
      }),
    },
    search: { name: 'fake', search: async () => ({ outcome: 'success_empty', provider: 'fake', results: [], durationMs: 1, retryCount: 0 }) },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
  });
  const created = manager.start({ question: 'cancel me' });
  assert.equal(created.status, 'running');
  assert.equal(manager.cancel(created.runId), true);
  const cancellationRequested = manager.get(created.runId)!;
  release();
  const settled = await waitForSettled(manager, created.runId);

  assert.equal(cancellationRequested.status, 'cancelling');
  assert.ok(cancellationRequested.cancellationRequestedAt);
  assert.equal(cancellationRequested.finishedAt, undefined);
  assert.deepEqual(terminalEvents(cancellationRequested), []);
  assert.equal(cancellationRequested.events.at(-1)?.type, 'run.cancellation_requested');
  assert.equal(settled.status, 'cancelled');
  assert.equal(settled.result?.status, 'interrupted');
  assert.equal(settled.result?.state.interrupted?.reason, 'cancelled');
  assert.equal(settled.error, undefined);
  assert.ok(settled.finishedAt);
  assert.equal(settled.finishedAt, settled.settledAt);
  assert.deepEqual(terminalEvents(settled).map((event) => event.type), ['run.cancelled']);
  assert.equal(settled.events.at(-1)?.type, 'run.cancelled');
  assert.ok(settled.events.every((event) => event.runId === created.runId));
});

test('run manager distinguishes an existing run with no events from a missing run', () => {
  const manager = new ResearchRunManager({
    llm: { complete: async () => ({ text: JSON.stringify({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'done' }) }) },
    search: { name: 'fake', search: async () => ({ outcome: 'success_empty', provider: 'fake', results: [], durationMs: 1, retryCount: 0 }) },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
  });
  assert.equal(manager.events('missing'), undefined);
  const run = manager.start({ question: 'events' });
  assert.ok(manager.events(run.runId));
});

test('cancellation during a signal-aware fetch settles as cancellation without RUN_FAILED', async () => {
  let fetchStarted!: () => void;
  const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
  const manager = new ResearchRunManager({
    llm: {
      complete: async () => ({
        text: JSON.stringify({ decision: 'fetch', searchActions: [], fetchActions: [{ url: 'https://example.test/abort', retry: false }], uncertainties: [], finalAnswer: null, evidenceUrls: [], findings: [] }),
        finishReason: 'tool_calls', structuredOutputMode: 'tool_call' as const, toolCallCount: 1,
      }),
    },
    search: { name: 'fake', search: async () => ({ outcome: 'success_empty', provider: 'fake', results: [], durationMs: 1, retryCount: 0 }) },
    fetch: {
      name: 'signal-aware-fetch',
      fetch: async (_url, options = {}) => {
        fetchStarted();
        return await new Promise((_, reject) => {
          if (options.signal?.aborted) reject(options.signal.reason);
          else options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        });
      },
    },
  });
  const created = manager.start({ question: 'cancel fetch' });
  await started;
  assert.equal(manager.cancel(created.runId), true);
  const run = await waitForSettled(manager, created.runId);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.result?.status, 'interrupted');
  assert.equal(run.result?.state.interrupted?.reason, 'cancelled');
  assert.equal(run.error, undefined);
  assert.deepEqual(terminalEvents(run).map((event) => event.type), ['run.cancelled']);
  assert.equal(run.events.at(-1)?.type, 'run.cancelled');
});

test('report failure is recorded before the sole business terminal event', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-report-status-'));
  let reportWrites = 0;
  try {
    const manager = new ResearchRunManager({
      llm: { complete: async () => ({ text: JSON.stringify({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'done', evidenceUrls: [], findings: [] }) }) },
      search: { name: 'fake', search: async () => ({ outcome: 'success_empty', provider: 'fake', results: [], durationMs: 1, retryCount: 0 }) },
      fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
    }, 100, outputDir, undefined, async () => { reportWrites += 1; throw new Error('renderer crashed'); });
    const created = manager.start({ question: 'report lifecycle' });
    const run = await waitForSettled(manager, created.runId);
    assert.equal(run.status, 'completed');
    assert.equal(run.result?.status, 'completed');
    assert.equal(run.reportStatus, 'failed');
    assert.equal(run.report, undefined);
    assert.deepEqual(run.reportError, { code: 'REPORT_FAILED', message: 'renderer crashed' });
    assert.equal(reportWrites, 1);
    assert.equal(run.events.filter((event) => event.type === 'report.failed').length, 1);
    assert.deepEqual(terminalEvents(run).map((event) => event.type), ['run.completed']);
    assert.equal(run.events.at(-1)?.type, 'run.completed');
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('persistence failure is observable without rewriting a completed business result', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'research-persistence-failure-'));
  const outputDir = path.join(parent, 'output-blocker');
  await fs.writeFile(outputDir, 'not a directory', 'utf8');
  try {
    const manager = new ResearchRunManager({
      llm: { complete: async () => ({ text: JSON.stringify({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'done', evidenceUrls: [], findings: [] }) }) },
      search: { name: 'fake', search: async () => ({ outcome: 'success_empty', provider: 'fake', results: [], durationMs: 1, retryCount: 0 }) },
      fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
    }, 100, outputDir, undefined, async () => { throw new Error('report path unavailable'); });
    const created = manager.start({ question: 'business result survives persistence failure' });
    const run = await waitForSettled(manager, created.runId);
    assert.equal(run.status, 'completed');
    assert.equal(run.result?.status, 'completed');
    assert.equal(run.error, undefined);
    assert.equal(run.persistenceError?.code, 'RUN_PERSIST_FAILED');
    assert.deepEqual(terminalEvents(run).map((event) => event.type), ['run.completed']);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a failed persistence operation does not poison a later terminal write', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'research-persistence-recovery-'));
  const outputDir = path.join(parent, 'output-blocker');
  await fs.writeFile(outputDir, 'temporarily blocked', 'utf8');
  let reportWrites = 0;
  try {
    const manager = new ResearchRunManager({
      llm: { complete: async () => ({ text: JSON.stringify({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'done', evidenceUrls: [], findings: [] }) }) },
      search: { name: 'fake', search: async () => ({ outcome: 'success_empty', provider: 'fake', results: [], durationMs: 1, retryCount: 0 }) },
      fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
    }, 100, outputDir, undefined, async () => {
      reportWrites += 1;
      await fs.rm(outputDir, { force: true });
      await fs.mkdir(outputDir, { recursive: true });
      return { jsonPath: 'report/report.json', markdownPath: 'report/report.md', htmlPath: 'report/report.html' };
    });
    const created = manager.start({ question: 'recover persistence queue' });
    const run = await waitForSettled(manager, created.runId);
    const persisted = JSON.parse(await fs.readFile(path.join(outputDir, created.runId, 'run.json'), 'utf8'));
    assert.equal(reportWrites, 1);
    assert.equal(run.status, 'completed');
    assert.equal(run.persistenceError, undefined);
    assert.equal(persisted.status, 'completed');
    assert.deepEqual(terminalEvents(persisted).map((event) => event.type), ['run.completed']);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('hydrate atomically persists SERVICE_RESTARTED exactly once', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-hydrate-'));
  const runId = 'run_restart_fixture';
  const runDir = path.join(outputDir, runId);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'run.json'), `${JSON.stringify({
    runId,
    status: 'running',
    task: { question: 'resume after restart' },
    createdAt: '2026-08-04T00:00:00.000Z',
    startedAt: '2026-08-04T00:00:01.000Z',
    reportStatus: 'pending',
    events: [
      { runId, sequence: 1, type: 'run.queued', timestamp: '2026-08-04T00:00:00.000Z', payload: {} },
      { runId, sequence: 2, type: 'run.started', timestamp: '2026-08-04T00:00:01.000Z', payload: {} },
    ],
  }, null, 2)}\n`, 'utf8');
  const dependencies = {
    llm: { complete: async () => ({ text: '{}' }) },
    search: { name: 'fake', search: async () => ({ outcome: 'success_empty' as const, provider: 'fake', results: [], durationMs: 1, retryCount: 0 }) },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
  };
  try {
    const first = new ResearchRunManager(dependencies, 100, outputDir);
    await first.hydrate();
    const firstDisk = JSON.parse(await fs.readFile(path.join(runDir, 'run.json'), 'utf8'));
    assert.equal(firstDisk.status, 'failed');
    assert.equal(firstDisk.error.code, 'SERVICE_RESTARTED');
    assert.ok(firstDisk.settledAt);
    assert.deepEqual(terminalEvents(firstDisk).map((event) => event.type), ['run.failed']);

    const second = new ResearchRunManager(dependencies, 100, outputDir);
    await second.hydrate();
    const secondDisk = JSON.parse(await fs.readFile(path.join(runDir, 'run.json'), 'utf8'));
    assert.deepEqual(secondDisk, firstDisk);
    assert.deepEqual(terminalEvents(second.get(runId)).map((event) => event.type), ['run.failed']);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test('agent-result persistence failure is observable without changing the completed result', async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const { runAgent } = await import('../../src/app/run-agent.ts');
  const result = await runAgent({ question: 'persist result' }, {
    llm: { complete: async () => ({ text: JSON.stringify({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'done', evidenceUrls: [], findings: [] }) }) },
    search: { name: 'fake', search: async () => ({ outcome: 'success_empty', provider: 'fake', results: [], durationMs: 1, retryCount: 0 }) },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
    onEvent: (event) => events.push(event),
  }, { evidenceStore: { saveAgentResult: async () => { throw new Error('disk full'); } } });
  assert.equal(result.status, 'completed');
  assert.deepEqual(events.find((event) => event.type === 'evidence.write_error')?.payload, {
    operation: 'saveAgentResult', code: 'EVIDENCE_WRITE_FAILED', message: 'disk full',
  });
});

test('manager-backed success persists the full search-fetch-finish evidence and report bundle', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'research-manager-success-'));
  const outputDir = path.join(parent, 'runs');
  const evidenceRoot = path.join(parent, 'evidence');
  const sourceUrl = 'https://example.test/research-source';
  let modelCalls = 0;
  try {
    const manager = new ResearchRunManager({
      llm: {
        structuredOutputMode: 'tool_call',
        complete: async () => {
          modelCalls += 1;
          const decisions = [
            {
              decision: 'search', searchActions: [{ query: 'manager persistence contract', retry: false }], fetchActions: [],
              uncertainties: [], finalAnswer: null, evidenceUrls: [], findings: [],
            },
            {
              decision: 'fetch', searchActions: [], fetchActions: [{ url: sourceUrl, retry: false }],
              uncertainties: [], finalAnswer: null, evidenceUrls: [], findings: [],
            },
            {
              decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'The fetched page supports the claim.', evidenceUrls: [],
              findings: [{ id: 'finding-1', claim: 'The source contains the requested fact.', disposition: 'confirmed', evidenceUrls: [sourceUrl] }],
            },
          ];
          return {
            text: JSON.stringify(decisions[Math.min(modelCalls - 1, decisions.length - 1)]),
            finishReason: 'tool_calls', structuredOutputMode: 'tool_call' as const, toolCallCount: 1,
          };
        },
      },
      search: {
        name: 'fake-search',
        search: async (query) => ({
          outcome: 'success_with_content' as const,
          provider: 'fake-search',
          results: [{ query, title: 'Research source', url: sourceUrl, snippet: 'The requested fact appears here.', provider: 'fake-search', rank: 1 }],
          durationMs: 1,
          retryCount: 0,
        }),
      },
      fetch: {
        name: 'fake-fetch',
        fetch: async (url) => ({
          outcome: 'success_with_content' as const,
          requestedUrl: url,
          finalUrl: url,
          title: 'Research source',
          content: 'The requested fact appears here.',
          provider: 'fake-fetch',
          statusCode: 200,
          contentType: 'text/plain',
          contentLength: 31,
          truncated: false,
          renderMode: 'static' as const,
          extractionWarnings: [],
          durationMs: 1,
          retryCount: 0,
        }),
      },
    }, 100, outputDir, evidenceRoot);

    const created = manager.start({
      question: 'manager persistence contract',
      options: { completionMode: 'target_results', targetResultCount: 1, evidenceRequired: true, minFetchedPages: 1, maxIterations: 4 },
    });
    const run = await waitForSettled(manager, created.runId);
    const runDirectory = path.join(outputDir, created.runId);
    const evidenceDirectory = path.join(evidenceRoot, created.runId);
    const persisted = JSON.parse(await fs.readFile(path.join(runDirectory, 'run.json'), 'utf8'));
    const evidenceEvents = (await fs.readFile(path.join(evidenceDirectory, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const searchRows = (await fs.readFile(path.join(evidenceDirectory, 'search-results.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const fetchedRows = (await fs.readFile(path.join(evidenceDirectory, 'fetched-pages.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const agentResult = JSON.parse(await fs.readFile(path.join(evidenceDirectory, 'agent-result.json'), 'utf8'));

    assert.equal(modelCalls, 3);
    assert.equal(run.status, 'completed');
    assert.equal(run.reportStatus, 'completed');
    assert.equal(run.result?.status, 'completed');
    assert.equal(run.result?.state.searchResults.length, 1);
    assert.equal(run.result?.state.fetchedPages.length, 1);
    assert.equal(run.result?.decision.findings?.[0]?.evidenceUrls[0], sourceUrl);
    assert.equal(run.events.at(-1)?.type, 'run.completed');
    assert.equal(persisted.status, 'completed');
    assert.equal(persisted.reportStatus, 'completed');
    assert.equal(evidenceEvents.some((event) => event.type === 'run.started'), true);
    assert.equal(searchRows[0][0].url, sourceUrl);
    assert.equal(fetchedRows[0].finalUrl, sourceUrl);
    assert.equal(agentResult.status, 'completed');
    for (const file of ['report.json', 'report.md', 'report.html']) {
      assert.equal(await fs.stat(path.join(runDirectory, 'report', file)).then(() => true), true);
    }
  } finally {
    await fs.rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('wall-clock deadline interrupts the run, writes a report, and emits one terminal event', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-deadline-'));
  let reportStatus: string | undefined;
  const manager = new ResearchRunManager({
    llm: {
      structuredOutputMode: 'tool_call',
      complete: async ({ signal }) => await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    },
    search: { name: 'fake', search: async () => { throw new Error('must not search'); } },
    fetch: { name: 'fake', fetch: async () => { throw new Error('must not fetch'); } },
  }, 100, outputDir, undefined, async (_directory, report) => {
    reportStatus = report.status;
    return { jsonPath: 'report/report.json', markdownPath: 'report/report.md', htmlPath: 'report/report.html' };
  }, 10);
  try {
    const created = manager.start({ question: 'deadline' });
    const run = await waitForSettled(manager, created.runId);
    assert.equal(run.status, 'interrupted');
    assert.equal(run.result?.status, 'interrupted');
    assert.equal(run.result?.state.interrupted?.reason, 'timeout');
    assert.equal(run.error, undefined);
    assert.equal(run.reportStatus, 'completed');
    assert.equal(reportStatus, 'interrupted');
    assert.equal(run.events.some((event) => event.type === 'agent.protocol_error'), false);
    assert.equal(run.events.find((event) => event.type === 'agent.model_error')?.payload.code, 'MODEL_TIMEOUT');
    assert.deepEqual(terminalEvents(run).map((event) => event.type), ['run.interrupted']);
    assert.equal(run.events.at(-1)?.type, 'run.interrupted');
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
