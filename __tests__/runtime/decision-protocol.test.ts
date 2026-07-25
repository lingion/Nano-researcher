import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDecisionEnvelope } from '../../src/runtime/decision-protocol.ts';

test('keeps a valid model decision and final_package without business rewriting', () => {
  const result = parseDecisionEnvelope(JSON.stringify({
    decision: 'continue_search',
    searchActions: [{ query: '国内工具', why: 'model choice' }],
    fetchActions: [],
    final_package: null,
    extraModelField: { keep: true },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.decision?.decision, 'continue_search');
  assert.deepEqual(result.decision?.searchActions, [{ query: '国内工具', why: 'model choice' }]);
  assert.equal((result.decision as Record<string, unknown>).extraModelField, undefined);
  assert.equal(result.decision?.finalPackage, null);
});

test('returns a protocol error instead of converting an unknown decision to stop', () => {
  const result = parseDecisionEnvelope(JSON.stringify({ decision: 'maybe', searchActions: [], fetchActions: [] }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.scope, 'decision');
  assert.equal(result.error?.code, 'UNKNOWN_DECISION');
});

test('rejects only malformed actions and accepts valid sibling actions', () => {
  const result = parseDecisionEnvelope(JSON.stringify({
    decision: 'continue_fetch',
    searchActions: [],
    fetchActions: [{ why: 'missing url' }, { url: 'https://example.com', why: 'valid' }],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.actionErrors?.length, 1);
  assert.deepEqual(result.decision?.fetchActions, [{ url: 'https://example.com', why: 'valid' }]);
});

test('returns a protocol error for missing decisions', () => {
  const result = parseDecisionEnvelope(JSON.stringify({ searchActions: [], fetchActions: [] }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.scope, 'decision');
  assert.equal(result.error?.code, 'MISSING_DECISION');
});

test('returns a protocol error for malformed top-level JSON', () => {
  const result = parseDecisionEnvelope('{');
  assert.equal(result.ok, false);
  assert.equal(result.error?.scope, 'envelope');
  assert.equal(result.error?.code, 'INVALID_JSON');
});
