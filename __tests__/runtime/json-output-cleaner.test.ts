import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanJsonModelOutput } from '../../src/runtime/json-output-cleaner.ts';

test('rejects a truncated search envelope instead of manufacturing an executable decision', () => {
  const result = cleanJsonModelOutput('{"searchActions":[{"query":"one"},{"query":"two"}');
  assert.equal(result.candidateText, null);
  assert.equal(result.candidateCount, 0);
  assert.equal(result.reason, 'no_valid_json_candidate');
});

import { cleanJsonModelOutput } from '../../src/runtime/json-output-cleaner.js';

test('cleanJsonModelOutput preserves valid JSON fast path', () => {
  const raw = '{"decision":"finalize","actions":[]}';
  assert.deepEqual(cleanJsonModelOutput(raw), {
    candidateText: raw,
    steps: ['fast_path'],
    candidateCount: 1,
  });
});

test('cleanJsonModelOutput extracts JSON markdown fences', () => {
  const result = cleanJsonModelOutput('```json\n{"decision":"continue"}\n```');
  assert.equal(result.candidateText, '{"decision":"continue"}');
  assert.deepEqual(result.steps, ['markdown_fence']);
});

test('cleanJsonModelOutput extracts one balanced JSON value from explanation', () => {
  const result = cleanJsonModelOutput('Here is the result:\n{"text":"braces { stay in string }"}\nThanks.');
  assert.equal(result.candidateText, '{"text":"braces { stay in string }"}');
  assert.deepEqual(result.steps, ['extract_unique_balanced_json']);
});

test('cleanJsonModelOutput rejects multiple valid candidates', () => {
  const result = cleanJsonModelOutput('{"decision":"continue"}\n{"decision":"finalize"}');
  assert.equal(result.candidateText, null);
  assert.equal(result.candidateCount, 2);
  assert.equal(result.reason, 'multiple_valid_json_candidates');
});

test('cleanJsonModelOutput rejects truncated JSON', () => {
  const result = cleanJsonModelOutput('prefix {"decision":"continue"');
  assert.equal(result.candidateText, null);
  assert.equal(result.candidateCount, 0);
  assert.equal(result.reason, 'no_valid_json_candidate');
});

test('cleanJsonModelOutput supports a JSON array candidate', () => {
  const result = cleanJsonModelOutput('payload: [1, {"x": "y"}]');
  assert.equal(result.candidateText, '[1, {"x": "y"}]');
});
