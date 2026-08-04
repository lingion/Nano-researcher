import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRanking } from './evaluation.ts';

test('ranking evaluation reports precision, recall, MRR, and NDCG at k', () => {
  const metrics = evaluateRanking([
    { id: 'reprint', relevance: 0 },
    { id: 'official', relevance: 3 },
    { id: 'related', relevance: 1 },
  ], ['official'], 2);
  assert.equal(metrics.precisionAtK, 0.5);
  assert.equal(metrics.recallAtK, 1);
  assert.equal(metrics.reciprocalRank, 0.5);
  assert.ok(metrics.ndcgAtK > 0 && metrics.ndcgAtK < 1);
});

test('ranking evaluation handles no relevant labels without fabricating quality', () => {
  const metrics = evaluateRanking([{ id: 'a', relevance: 0 }], [], 3);
  assert.equal(metrics.precisionAtK, 0);
  assert.equal(metrics.recallAtK, 0);
  assert.equal(metrics.reciprocalRank, 0);
  assert.equal(metrics.ndcgAtK, 0);
});
