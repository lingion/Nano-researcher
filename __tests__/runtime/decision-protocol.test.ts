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
  assert.deepEqual((result as { envelope?: Record<string, unknown> }).envelope?.extraModelField, { keep: true });
  assert.equal(result.decision?.finalPackage, null);
});

test('returns a protocol error instead of converting an unknown decision to stop', () => {
  const result = parseDecisionEnvelope(JSON.stringify({ decision: 'maybe', searchActions: [], fetchActions: [] }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.scope, 'decision');
  assert.equal(result.error?.code, 'UNKNOWN_DECISION');
});

test('rejects mixed valid and invalid actions instead of executing valid siblings', () => {
  const result = parseDecisionEnvelope(JSON.stringify({
    decision: 'continue_fetch',
    searchActions: [],
    fetchActions: [{ why: 'missing url' }, { url: 'https://example.com', why: 'valid' }],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'INVALID_ACTION');
});

test('accepts a valid action set without why when fields are syntactically valid', () => {
  const result = parseDecisionEnvelope(JSON.stringify({
    decision: 'continue_search',
    searchActions: [{ query: '国内工具' }],
    fetchActions: [],
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.decision?.searchActions, [{ query: '国内工具' }]);
});

test('returns a top-level protocol error for non-array action containers', () => {
  const result = parseDecisionEnvelope(JSON.stringify({
    decision: 'continue_search',
    searchActions: {},
    fetchActions: [],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.scope, 'envelope');
  assert.equal(result.error?.code, 'INVALID_ACTIONS');
});

test('rejects fetch actions whose URL cannot be parsed', () => {
  const result = parseDecisionEnvelope(JSON.stringify({
    decision: 'continue_fetch',
    searchActions: [],
    fetchActions: [{ url: 'not a URL' }, { url: 'https://example.com' }],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'INVALID_ACTION');
});

test('rejects terminal decisions carrying actions', () => {
  const result = parseDecisionEnvelope(JSON.stringify({
    decision: 'finalize',
    searchActions: [],
    fetchActions: [{ url: 'https://example.com' }],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'INVALID_ACTIONS');
});
test('rejects a missing decision', () => {
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

test('accepts camelCase finalPackage as the canonical final package alias', () => {
  const finalPackage = { items: [{ product_name: 'Example' }] };
  const result = parseDecisionEnvelope(JSON.stringify({
    decision: 'stop',
    searchActions: [],
    fetchActions: [],
    finalPackage,
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.decision?.finalPackage, finalPackage);
});

test('rejects malformed evidence assessments instead of trusting a type assertion', () => {
  const result = parseDecisionEnvelope(JSON.stringify({
    decision: 'continue_fetch',
    searchActions: [],
    fetchActions: [{ url: 'https://example.com', why: 'inspect' }],
    evidenceAssessments: [{ url: 'https://example.com', qualityCategory: 'INVALID' }],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'INVALID_ACTION');
});

test('requires a final package on terminal decisions', () => {
  const result = parseDecisionEnvelope(JSON.stringify({
    decision: 'stop',
    searchActions: [],
    fetchActions: [],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'INVALID_ENVELOPE');
});
