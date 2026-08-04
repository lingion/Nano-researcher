import test from 'node:test';
import assert from 'node:assert/strict';

import type { AgentDecision, ResearchTask, ToolOutcome } from '../../src/agent/types.ts';

test('generic task and decision contain no domain-specific fields', () => {
  const task: ResearchTask = { question: 'Compare two database engines' };
  const decision: AgentDecision = {
    decision: 'search',
    searchActions: [{ query: task.question }],
    fetchActions: [],
    uncertainties: [],
  };

  assert.equal(task.question, 'Compare two database engines');
  assert.equal(decision.decision, 'search');
  assert.deepEqual(Object.keys(task), ['question']);
  assert.deepEqual(Object.keys(decision), [
    'decision',
    'searchActions',
    'fetchActions',
    'uncertainties',
  ]);
});

test('tool outcome is transport-level and domain-neutral', () => {
  const outcomes: ToolOutcome[] = [
    'success_with_content',
    'success_empty',
    'http_error',
    'transport_error',
    'timeout',
    'protocol_error',
    'cancelled',
  ];

  assert.equal(outcomes.includes('success_empty'), true);
  assert.equal(outcomes.includes('http_error'), true);
});
