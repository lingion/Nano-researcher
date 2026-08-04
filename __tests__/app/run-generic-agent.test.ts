import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGenericCliRun } from '../../src/app/run-generic-agent.ts';

test('generic CLI builds the same bounded evidence-aware task contract', () => {
  const parsed = parseGenericCliRun({
    RESEARCH_QUESTION: ' research ', RESEARCH_COMPLETION_MODE: 'target_results',
    RESEARCH_TARGET_RESULTS: '12', RESEARCH_MIN_FETCHED_PAGES: '12',
    RESEARCH_EVIDENCE_REQUIRED: 'true', RESEARCH_MAX_ITERATIONS: '80',
    RESEARCH_MAX_SEARCH_ACTIONS: '8', RESEARCH_MAX_FETCH_ACTIONS: '8',
    RESEARCH_LOCALE: 'zh-CN', RESEARCH_OUTPUT_FORMAT: 'markdown', RESEARCH_RUN_TIMEOUT_MS: '600000',
  });
  assert.equal(parsed.task.question, 'research');
  assert.deepEqual(parsed.task.options, {
    maxIterations: 80, completionMode: 'target_results', targetResultCount: 12,
    evidenceRequired: true, minFetchedPages: 12, maxSearchActionsPerTurn: 8,
    maxFetchActionsPerTurn: 8, locale: 'zh-CN', outputFormat: 'markdown',
  });
  assert.equal(parsed.timeoutMs, 600_000);
});

test('generic CLI rejects invalid and silently unexecutable configuration', () => {
  const base = { RESEARCH_QUESTION: 'x' };
  for (const env of [
    { ...base, RESEARCH_MAX_ITERATIONS: 'NaN' },
    { ...base, RESEARCH_MAX_ITERATIONS: '101' },
    { ...base, RESEARCH_MAX_SEARCH_ACTIONS: '9' },
    { ...base, RESEARCH_COMPLETION_MODE: 'natural' },
    { ...base, RESEARCH_EVIDENCE_REQUIRED: 'maybe' },
    { ...base, RESEARCH_RUN_TIMEOUT_MS: 'Infinity' },
  ]) assert.throws(() => parseGenericCliRun(env), /RESEARCH_/);
});
