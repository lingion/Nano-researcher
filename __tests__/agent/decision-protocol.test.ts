import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentDecision } from '../../src/agent/decision-protocol.ts';
import { researchDecisionTool } from '../../src/agent/decision-response-schema.ts';

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision: 'review',
    searchActions: [],
    fetchActions: [],
    uncertainties: [],
    finalAnswer: null,
    evidenceUrls: [],
    findings: [],
    ...overrides,
  };
}

test('parses the complete canonical search envelope', () => {
  const result = parseAgentDecision(JSON.stringify(envelope({ decision: 'search', searchActions: [{ query: 'compare databases', retry: false }] })));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.decision.searchActions, [{ query: 'compare databases' }]);
});

test('keeps the real research decision tool required fields in parity with the parser', () => {
  const parameters = researchDecisionTool.parameters as {
    required: string[];
    properties: Record<string, { items?: { required?: string[] } }>;
  };
  assert.deepEqual(parameters.required, [
    'decision',
    'searchActions',
    'fetchActions',
    'uncertainties',
    'finalAnswer',
    'evidenceUrls',
    'findings',
  ]);
  assert.deepEqual(parameters.properties.searchActions.items?.required, ['query', 'retry']);
  assert.deepEqual(parameters.properties.fetchActions.items?.required, ['url', 'retry']);

  const missingTopLevel = parseAgentDecision(JSON.stringify({
    decision: 'review', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: null,
  }));
  assert.equal(missingTopLevel.ok, false);
  if (!missingTopLevel.ok) assert.equal(missingTopLevel.error.code, 'MISSING_FIELD');

  const missingRetry = parseAgentDecision(JSON.stringify(envelope({
    decision: 'search', searchActions: [{ query: 'official source' }],
  })));
  assert.equal(missingRetry.ok, false);
  if (!missingRetry.ok) assert.equal(missingRetry.error.code, 'MISSING_FIELD');

  const canonical = parseAgentDecision(JSON.stringify(envelope({
    decision: 'search', searchActions: [{ query: 'official source', retry: false }],
  })));
  assert.equal(canonical.ok, true);

  const overlongFindingUrl = `https://example.com/${'x'.repeat(2_100)}`;
  const findingOutsideSchema = parseAgentDecision(JSON.stringify(envelope({
    decision: 'finish',
    finalAnswer: 'unsupported oversized evidence URL',
    evidenceUrls: [],
    findings: [{ id: 'oversized', claim: 'claim', disposition: 'confirmed', evidenceUrls: [overlongFindingUrl] }],
  })));
  assert.equal(findingOutsideSchema.ok, false);
  if (!findingOutsideSchema.ok) assert.equal(findingOutsideSchema.error.code, 'INVALID_EVIDENCE_URL');
});

test('rejects malformed JSON, prose wrappers, and envelopes without a decision', () => {
  assert.equal(parseAgentDecision('{').ok, false);
  assert.equal(parseAgentDecision(`I will search. ${JSON.stringify(envelope())}`).ok, false);
  const result = parseAgentDecision(JSON.stringify({ searchActions: [{ query: 'official beta' }], fetchActions: [], uncertainties: [], finalAnswer: null }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'MISSING_FIELD');
});

test('rejects fields that are outside the executor contract', () => {
  const extraTopLevel = parseAgentDecision(JSON.stringify(envelope({ decision: 'search', searchActions: [{ query: 'x' }], reason: 'this makes the answer too long' })));
  assert.equal(extraTopLevel.ok, false);
  if (!extraTopLevel.ok) assert.equal(extraTopLevel.error.code, 'UNEXPECTED_FIELD');

  const extraActionField = parseAgentDecision(JSON.stringify(envelope({ decision: 'fetch', fetchActions: [{ url: 'https://example.com', reason: 'unneeded' }] })));
  assert.equal(extraActionField.ok, false);
  if (!extraActionField.ok) assert.equal(extraActionField.error.code, 'UNEXPECTED_FIELD');
});

test('rejects missing fields and invalid decision/action coupling', () => {
  const missing = parseAgentDecision(JSON.stringify({ decision: 'review', searchActions: [], fetchActions: [] }));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, 'MISSING_FIELD');

  const unknown = parseAgentDecision(JSON.stringify(envelope({ decision: 'maybe' })));
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, 'UNKNOWN_DECISION');

  assert.equal(parseAgentDecision(JSON.stringify(envelope({ decision: 'search' }))).ok, false);
  assert.equal(parseAgentDecision(JSON.stringify(envelope({ decision: 'fetch', fetchActions: [{ url: 'file:///etc/passwd' }] }))).ok, false);
});

test('requires a string final answer only for finish and null finalAnswer otherwise', () => {
  const missingFinishAnswer = parseAgentDecision(JSON.stringify(envelope({ decision: 'finish' })));
  assert.equal(missingFinishAnswer.ok, false);
  if (!missingFinishAnswer.ok) assert.equal(missingFinishAnswer.error.code, 'MISSING_FINAL_ANSWER');

  const unexpectedAnswer = parseAgentDecision(JSON.stringify(envelope({ decision: 'review', finalAnswer: 'premature' })));
  assert.equal(unexpectedAnswer.ok, false);
  if (!unexpectedAnswer.ok) assert.equal(unexpectedAnswer.error.code, 'INVALID_FINAL_ANSWER');

  const finish = parseAgentDecision(JSON.stringify(envelope({ decision: 'finish', finalAnswer: 'verified answer' })));
  assert.equal(finish.ok, true);
});

test('normalizes double-escaped line breaks in the final answer without changing action fields', () => {
  const result = parseAgentDecision(JSON.stringify(envelope({
    decision: 'finish',
    finalAnswer: 'line one\\n\\nline two',
  })));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.decision.finalAnswer, 'line one\n\nline two');
});

test('accepts evidence URLs only on finish and normalizes valid HTTP sources', () => {
  const finish = parseAgentDecision(JSON.stringify(envelope({
    decision: 'finish',
    finalAnswer: 'verified answer',
    evidenceUrls: ['https://example.com/source#section', 'https://example.com/source#section'],
    findings: [{ id: 'source', claim: 'verified claim', disposition: 'confirmed', evidenceUrls: ['https://example.com/source#section'] }],
  })));
  assert.equal(finish.ok, true);
  if (finish.ok) assert.deepEqual(finish.decision.evidenceUrls, ['https://example.com/source#section']);

  const premature = parseAgentDecision(JSON.stringify(envelope({ evidenceUrls: ['https://example.com/source'] })));
  assert.equal(premature.ok, false);
  if (!premature.ok) assert.equal(premature.error.code, 'INVALID_EVIDENCE_URLS');

  const unsafe = parseAgentDecision(JSON.stringify(envelope({ decision: 'finish', finalAnswer: 'x', evidenceUrls: ['file:///etc/passwd'] })));
  assert.equal(unsafe.ok, false);
  if (!unsafe.ok) assert.equal(unsafe.error.code, 'INVALID_EVIDENCE_URL');
});

test('rejects action counts above the executor contract instead of silently dropping work', () => {
  const tooManySearches = parseAgentDecision(JSON.stringify(envelope({ decision: 'search', searchActions: Array.from({ length: 9 }, (_, index) => ({ query: `q${index}` })) })));
  assert.equal(tooManySearches.ok, false);
  if (!tooManySearches.ok) assert.equal(tooManySearches.error.code, 'ACTION_LIMIT_EXCEEDED');
});

test('rejects duplicate actions within one decision instead of executing them twice', () => {
  const duplicateSearch = parseAgentDecision(JSON.stringify(envelope({ decision: 'search', searchActions: [{ query: 'same', retry: false }, { query: 'same', retry: false }] })));
  assert.equal(duplicateSearch.ok, false);
  if (!duplicateSearch.ok) assert.equal(duplicateSearch.error.code, 'DUPLICATE_ACTION');

  const duplicateFetch = parseAgentDecision(JSON.stringify(envelope({ decision: 'fetch', fetchActions: [{ url: 'https://example.com/a', retry: false }, { url: 'https://example.com/a', retry: false }] })));
  assert.equal(duplicateFetch.ok, false);
  if (!duplicateFetch.ok) assert.equal(duplicateFetch.error.code, 'DUPLICATE_ACTION');
});

test('accepts only an explicit boolean retry marker on actions', () => {
  const explicitRetry = parseAgentDecision(JSON.stringify(envelope({
    decision: 'fetch',
    fetchActions: [{ url: 'https://example.com/a', retry: true }],
  })));
  assert.equal(explicitRetry.ok, true);
  if (explicitRetry.ok) assert.deepEqual(explicitRetry.decision.fetchActions, [{ url: 'https://example.com/a', retry: true }]);

  const invalidRetry = parseAgentDecision(JSON.stringify(envelope({
    decision: 'search',
    searchActions: [{ query: 'same query', retry: 'yes' }],
  })));
  assert.equal(invalidRetry.ok, false);
  if (!invalidRetry.ok) assert.equal(invalidRetry.error.code, 'INVALID_RETRY');
});

test('requires every final finding to bind evidence and derives the top-level evidence set', () => {
  const valid = parseAgentDecision(JSON.stringify(envelope({
    decision: 'finish',
    finalAnswer: 'two supported facts',
    evidenceUrls: ['https://example.com/a', 'https://example.com/b'],
    findings: [
      { id: 'a', claim: 'fact a', disposition: 'confirmed', evidenceUrls: ['https://example.com/a'] },
      { id: 'b', claim: 'fact b', disposition: 'confirmed', evidenceUrls: ['https://example.com/b'] },
    ],
  })));
  assert.equal(valid.ok, true);

  const copiedUrlDrift = parseAgentDecision(JSON.stringify(envelope({
    decision: 'finish',
    finalAnswer: 'unsupported mapping',
    evidenceUrls: ['https://example.com/a?long=top-level-copy'],
    findings: [{ id: 'a', claim: 'fact a', disposition: 'confirmed', evidenceUrls: ['https://example.com/a?long=finding-copy'] }],
  })));
  assert.equal(copiedUrlDrift.ok, true);
  if (copiedUrlDrift.ok) assert.deepEqual(copiedUrlDrift.decision.evidenceUrls, ['https://example.com/a?long=finding-copy']);
});

test('requires the agent to classify every finding with a generic disposition', () => {
  const missingDisposition = parseAgentDecision(JSON.stringify(envelope({
    decision: 'finish', finalAnswer: 'missing classification', evidenceUrls: [],
    findings: [{ id: 'a', claim: 'fact a', evidenceUrls: [] }],
  })));
  assert.equal(missingDisposition.ok, false);

  const classified = parseAgentDecision(JSON.stringify(envelope({
    decision: 'finish', finalAnswer: 'classified results', evidenceUrls: [],
    findings: [
      { id: 'confirmed', claim: 'verified fact', disposition: 'confirmed', evidenceUrls: [] },
      { id: 'uncertain', claim: 'unverified lead', disposition: 'uncertain', evidenceUrls: [] },
      { id: 'excluded', claim: 'out-of-scope item', disposition: 'excluded', evidenceUrls: [] },
    ],
  })));
  assert.equal(classified.ok, true);
});

test('enforces review coupling and the same bounded field lengths as the tool schema', () => {
  const reviewWithActions = parseAgentDecision(JSON.stringify(envelope({
    decision: 'review',
    searchActions: [{ query: 'must not run', retry: false }],
  })));
  assert.equal(reviewWithActions.ok, false);
  if (!reviewWithActions.ok) assert.equal(reviewWithActions.error.code, 'INVALID_ACTIONS');

  const longQuery = parseAgentDecision(JSON.stringify(envelope({
    decision: 'search',
    searchActions: [{ query: 'x'.repeat(501) }],
  })));
  assert.equal(longQuery.ok, false);
  if (!longQuery.ok) assert.equal(longQuery.error.code, 'INVALID_SEARCH_ACTION');

  const tooManyUncertainties = parseAgentDecision(JSON.stringify(envelope({ uncertainties: Array.from({ length: 17 }, () => 'x') })));
  assert.equal(tooManyUncertainties.ok, false);
  if (!tooManyUncertainties.ok) assert.equal(tooManyUncertainties.error.code, 'INVALID_UNCERTAINTIES');

  const longAnswer = parseAgentDecision(JSON.stringify(envelope({ decision: 'finish', finalAnswer: 'x'.repeat(12_001) })));
  assert.equal(longAnswer.ok, false);
  if (!longAnswer.ok) assert.equal(longAnswer.error.code, 'INVALID_FINAL_ANSWER');
});
