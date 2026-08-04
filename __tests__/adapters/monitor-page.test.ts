import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { monitorPage } from '../../src/adapters/http/monitor-page.ts';

type Timer = {
  id: number;
  kind: 'timeout' | 'interval';
  delay: number;
  callback: () => void;
};

type JsonResponse = {
  ok: boolean;
  json: () => Promise<unknown>;
};

type FetchInit = {
  headers?: Record<string, string>;
};

function jsonResponse(value: unknown, ok = true): JsonResponse {
  return { ok, json: async () => value };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function flushBrowserTasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function openMonitor(
  fetchImpl: (url: string, init?: FetchInit) => Promise<JsonResponse>,
  runId = 'run_test',
  fragment = '',
  storedToken = '',
) {
  const timers = new Map<number, Timer>();
  const scriptErrors: Error[] = [];
  const consoleMessages: string[] = [];
  let nextTimerId = 1;
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => scriptErrors.push(error));
  for (const eventName of ['log', 'info', 'warn', 'error'] as const) {
    virtualConsole.on(eventName, (...values) => consoleMessages.push(values.map(String).join(' ')));
  }

  const dom = new JSDOM(monitorPage, {
    url: `${runId ? `http://127.0.0.1/monitor?runId=${encodeURIComponent(runId)}` : 'http://127.0.0.1/monitor'}${fragment}`,
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      (window as any).fetch = fetchImpl;
      if (storedToken) window.sessionStorage.setItem('researchHttpAuthToken', storedToken);
      (window as any).setTimeout = (callback: () => void, delay = 0) => {
        const id = nextTimerId++;
        timers.set(id, { id, kind: 'timeout', delay, callback });
        return id;
      };
      (window as any).clearTimeout = (id: number) => timers.delete(Number(id));
      (window as any).setInterval = (callback: () => void, delay = 0) => {
        const id = nextTimerId++;
        timers.set(id, { id, kind: 'interval', delay, callback });
        return id;
      };
      (window as any).clearInterval = (id: number) => timers.delete(Number(id));
    },
  });

  function runNextTimer(delay: number): void {
    const timer = [...timers.values()].find((candidate) => candidate.delay === delay);
    assert.ok(timer, `expected a ${delay}ms timer`);
    if (timer.kind === 'timeout') timers.delete(timer.id);
    timer.callback();
  }

  return { dom, timers, scriptErrors, consoleMessages, runNextTimer };
}

function event(sequence: number, type = 'search.result', payload: Record<string, unknown> = { sequence }) {
  return {
    runId: 'run_test',
    sequence,
    type,
    timestamp: new Date(1_700_000_000_000 + sequence).toISOString(),
    payload,
  };
}

function runSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run_test',
    status: 'running',
    reportStatus: 'pending',
    task: { question: 'question' },
    events: [],
    ...overrides,
  };
}

test('monitor renders every untrusted value as text without dynamic innerHTML', async () => {
  const injection = '<img id="monitor-xss" src=x onerror="window.__xss=1">';
  const responses = [
    jsonResponse(runSnapshot({
      status: 'completed',
      reportStatus: 'completed',
      task: { question: injection },
      report: { jsonPath: injection, markdownPath: 'report.md', htmlPath: 'report.html' },
    })),
    jsonResponse({ events: [event(1, `search.result${injection}`, { value: injection })] }),
  ];
  const { dom, scriptErrors } = openMonitor(async () => responses.shift()!);

  await flushBrowserTasks();

  assert.deepEqual(scriptErrors, []);
  assert.doesNotMatch(monitorPage, /\.innerHTML\s*=/);
  assert.equal(dom.window.document.querySelector('#question')?.textContent, injection);
  assert.equal(dom.window.document.querySelector('#eventList b')?.textContent, `search.result${injection}`);
  assert.equal(dom.window.document.querySelector('#eventList pre')?.textContent, JSON.stringify({ value: injection }, null, 2));
  assert.equal(dom.window.document.querySelectorAll('img').length, 0);
  assert.equal((dom.window as any).__xss, undefined);
  dom.window.close();
});
test('monitor consumes a fragment token into sessionStorage and authenticates every run fetch without leaking it', async () => {
  const token = 'monitor-secret_A1/plus+equals==';
  const calls: Array<{ url: string; init?: FetchInit }> = [];
  const responses = [
    jsonResponse(runSnapshot({ status: 'completed', reportStatus: 'completed' })),
    jsonResponse({ events: [] }),
  ];
  const { dom, consoleMessages } = openMonitor(async (url, init) => {
    calls.push({ url, init });
    return responses.shift()!;
  }, 'run_test', `#token=${encodeURIComponent(token)}`);

  await flushBrowserTasks();

  assert.equal(dom.window.location.hash, '');
  assert.equal(dom.window.location.pathname, '/monitor/run_test');
  assert.equal(dom.window.location.search, '');
  assert.equal(dom.window.sessionStorage.getItem('researchHttpAuthToken'), token);
  assert.equal(dom.window.localStorage.length, 0);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.init?.headers?.Authorization === `Bearer ${token}`));
  assert.ok(calls.every((call) => !call.url.includes(token) && !call.url.includes(encodeURIComponent(token))));
  assert.equal(dom.window.document.body.textContent?.includes(token), false);
  assert.equal(consoleMessages.some((message) => message.includes(token)), false);
  dom.window.close();
});

test('monitor reuses the session token for list fetches without fragment or localStorage persistence', async () => {
  const token = 'stored-session-token';
  const calls: Array<{ url: string; init?: FetchInit }> = [];
  const { dom } = openMonitor(async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ runs: [] });
  }, '', '', token);

  await flushBrowserTasks();

  assert.deepEqual(calls.map((call) => call.url), ['/v1/research']);
  assert.equal(calls[0]?.init?.headers?.Authorization, `Bearer ${token}`);
  assert.equal(dom.window.sessionStorage.getItem('researchHttpAuthToken'), token);
  assert.equal(dom.window.localStorage.length, 0);
  dom.window.close();
});

test('monitor script avoids CSP-hostile dynamic execution and inline event handlers', () => {
  assert.doesNotMatch(monitorPage, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(monitorPage, /\beval\s*\(|new\s+Function\b|document\.write\s*\(/);
  assert.doesNotMatch(monitorPage, /javascript\s*:/i);
});

test('run polling schedules its next request only after the current request settles', async () => {
  const runResponse = deferred<JsonResponse>();
  const eventResponse = deferred<JsonResponse>();
  const requestedUrls: string[] = [];
  const { dom, timers } = openMonitor(async (url) => {
    requestedUrls.push(url);
    return url.includes('/events') ? eventResponse.promise : runResponse.promise;
  });

  assert.equal(requestedUrls.length, 2);
  assert.equal([...timers.values()].filter((timer) => timer.delay === 1_500).length, 0);

  runResponse.resolve(jsonResponse(runSnapshot()));
  eventResponse.resolve(jsonResponse({ events: [] }));
  await flushBrowserTasks();

  assert.equal([...timers.values()].filter((timer) => timer.delay === 1_500).length, 1);
  dom.window.close();
});

test('run list polling is non-overlapping and renders list questions as text', async () => {
  const injection = '<svg id="list-xss" onload="window.__listXss=1"></svg>';
  const listResponse = deferred<JsonResponse>();
  const requestedUrls: string[] = [];
  const { dom, timers } = openMonitor(async (url) => {
    requestedUrls.push(url);
    return listResponse.promise;
  }, '');

  assert.deepEqual(requestedUrls, ['/v1/research']);
  assert.equal([...timers.values()].filter((timer) => timer.delay === 2_000).length, 0);

  listResponse.resolve(jsonResponse({
    runs: [{ runId: 'run_list', status: 'running', createdAt: new Date(0).toISOString(), task: { question: injection } }],
  }));
  await flushBrowserTasks();

  assert.equal([...timers.values()].filter((timer) => timer.delay === 2_000).length, 1);
  assert.match(dom.window.document.querySelector('#runList a')?.textContent ?? '', /<svg id="list-xss"/);
  assert.equal(dom.window.document.querySelectorAll('svg').length, 0);
  assert.equal((dom.window as any).__listXss, undefined);
  dom.window.close();
});

test('monitor requests events after the last sequence and deduplicates a legacy full response', async () => {
  const requestedUrls: string[] = [];
  let pollNumber = 0;
  const eventBatches = [
    [event(1), event(2)],
    [event(1), event(2), event(3)],
  ];
  const { dom, runNextTimer } = openMonitor(async (url) => {
    requestedUrls.push(url);
    if (url.includes('/events')) return jsonResponse({ events: eventBatches[pollNumber++] ?? [] });
    return jsonResponse(runSnapshot());
  });

  await flushBrowserTasks();
  assert.equal(requestedUrls.find((url) => url.includes('/events')), '/v1/research/run_test/events?afterSequence=0');
  assert.equal(dom.window.document.querySelectorAll('#eventList .event').length, 2);

  runNextTimer(1_500);
  await flushBrowserTasks();

  const eventUrls = requestedUrls.filter((url) => url.includes('/events'));
  assert.equal(eventUrls[1], '/v1/research/run_test/events?afterSequence=2');
  assert.deepEqual(
    [...dom.window.document.querySelectorAll('#eventList .event pre')].map((node) => JSON.parse(node.textContent ?? '{}').sequence),
    [1, 2, 3],
  );
  dom.window.close();
});

test('monitor uses top-level projection counts and fetches the full answer only when available', async () => {
  const requestedUrls: string[] = [];
  const responses = [
    jsonResponse({
      runId: 'run_test', question: 'top-level question', status: 'completed', reportStatus: 'completed', answerAvailable: true,
      counts: { searchResults: 8, fetchedPages: 3, events: 4, protocolErrors: 0, iterations: 2 },
      report: { jsonPath: 'artifacts/run/report.json', markdownPath: 'artifacts/run/report.md', htmlPath: 'artifacts/run/report.html' },
    }),
    jsonResponse({ events: [] }),
    jsonResponse({ result: { state: { finalAnswer: 'answer from full projection' } } }),
  ];
  const { dom } = openMonitor(async (url) => {
    requestedUrls.push(url);
    return responses.shift()!;
  });
  await flushBrowserTasks();
  assert.deepEqual(requestedUrls, [
    '/v1/research/run_test',
    '/v1/research/run_test/events?afterSequence=0',
    '/v1/research/run_test?include=full',
  ]);
  assert.equal(dom.window.document.querySelector('#question')?.textContent, 'top-level question');
  assert.equal(dom.window.document.querySelector('#searches')?.textContent, '8');
  assert.equal(dom.window.document.querySelector('#fetches')?.textContent, '3');
  assert.equal(dom.window.document.querySelector('#answer')?.textContent, 'answer from full projection');
  assert.equal(dom.window.document.querySelectorAll('#links a').length, 3);
  dom.window.close();
});

test('monitor stops polling after an unrecoverable detail request error and exposes retry', async () => {
  const { dom, timers } = openMonitor(async (url) => {
    if (url.includes('/events')) return jsonResponse({ error: 'events unavailable' }, false);
    return jsonResponse(runSnapshot());
  });
  await flushBrowserTasks();
  assert.equal([...timers.values()].filter((timer) => timer.delay === 1_500).length, 0);
  assert.equal((dom.window.document.querySelector('#retry') as HTMLButtonElement)?.hidden, false);
  assert.match(dom.window.document.querySelector('#eventStatus')?.textContent ?? '', /事件加载失败/);
  dom.window.close();
});

test('terminal run status keeps polling while report generation is pending', async () => {
  let pollNumber = 0;
  const runs = [
    runSnapshot({ status: 'completed', reportStatus: 'pending' }),
    runSnapshot({ status: 'completed', reportStatus: 'completed', report: { jsonPath: 'report.json', markdownPath: 'report.md', htmlPath: 'report.html' } }),
  ];
  const { dom, timers, runNextTimer } = openMonitor(async (url) => {
    if (url.includes('/events')) return jsonResponse({ events: [] });
    return jsonResponse(runs[pollNumber++]!);
  });

  await flushBrowserTasks();
  assert.equal([...timers.values()].filter((timer) => timer.delay === 1_500).length, 1);

  runNextTimer(1_500);
  await flushBrowserTasks();

  assert.equal([...timers.values()].filter((timer) => timer.delay === 1_500).length, 0);
  assert.equal(dom.window.document.querySelectorAll('#links a').length, 3);
  dom.window.close();
});

test('monitor retains only the newest 500 event nodes', async () => {
  const events = Array.from({ length: 650 }, (_, index) => event(index + 1));
  const { dom } = openMonitor(async (url) => {
    if (url.includes('/events')) return jsonResponse({ events });
    return jsonResponse(runSnapshot({ status: 'completed', reportStatus: 'completed' }));
  });

  await flushBrowserTasks();

  const rendered = [...dom.window.document.querySelectorAll('#eventList .event pre')];
  assert.equal(rendered.length, 500);
  assert.equal(JSON.parse(rendered[0]!.textContent ?? '{}').sequence, 151);
  assert.equal(JSON.parse(rendered.at(-1)!.textContent ?? '{}').sequence, 650);
  dom.window.close();
});
