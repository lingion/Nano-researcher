import test from 'node:test';
import assert from 'node:assert/strict';

import { assessLoopTermination } from '../../src/runtime/termination-policy.ts';

test('termination policy stops immediately when the agent explicitly finalizes', () => {
  const result = assessLoopTermination({
    currentIteration: 2,
    maxIterations: 4,
    agentDecisionType: 'finalize',
  });

  assert.equal(result.shouldBreak, true);
  assert.equal(result.interruptedByGate, false);
});

test('termination policy returns gate interruption details when max iterations are reached', () => {
  const result = assessLoopTermination({
    currentIteration: 3,
    maxIterations: 3,
    lastCandidateQualityState: {
      status: 'blocked_by_waf',
      reason: 'WAF administrative wall',
    },
    agentDecisionType: 'continue_search',
  });

  assert.equal(result.shouldBreak, true);
  assert.equal(result.interruptedByGate, true);
  assert.equal(result.finalQualityStatus, 'blocked_by_waf');
  assert.equal(result.finalQualityReason, 'WAF administrative wall');
});

test('termination policy keeps the loop running when no stop condition has been met', () => {
  const result = assessLoopTermination({
    currentIteration: 2,
    maxIterations: 4,
    agentDecisionType: 'continue_search',
  });

  assert.equal(result.shouldBreak, false);
  assert.equal(result.interruptedByGate, false);
  assert.equal(result.finalQualityStatus, undefined);
  assert.equal(result.finalQualityReason, undefined);
});
