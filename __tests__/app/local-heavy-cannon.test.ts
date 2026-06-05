import test from 'node:test';
import assert from 'node:assert/strict';

import * as liveAuditModule from '../../src/app/run-live-audit.ts';
import { runPolicyTaskLoop } from '../../src/app/run-policy-task.ts';

test('run-live-audit exports a local heavy-cannon initializer for CLI search injection', () => {
  assert.equal(typeof liveAuditModule.initializeLocalHeavyCannonWebSearch, 'function');
});

test('run-live-audit exports a local heavy-cannon initializer for CLI fetch injection', () => {
  assert.equal(typeof liveAuditModule.initializeLocalHeavyCannonWebFetch, 'function');
});

test('policy loop uses the runtime-owned MCP default path instead of the removed legacy backend', async () => {
  let decisionStep = 0;

  const result = await runPolicyTaskLoop(
    { topic: '常州市 医疗补贴' },
    {
      maxIterations: 2,
      askAgent: async (state) => {
        decisionStep += 1;
        if (decisionStep === 1) {
          return {
            decision: 'continue_search',
            reasoning: 'Use the runtime-owned MCP search path.',
            searchActions: [
              {
                query: '常州市 医疗补贴',
                why: 'Find official candidates through the default backend',
              },
            ],
            fetchActions: [],
            uncertainties: [],
            discardedLeads: [],
          };
        }

        return {
          decision: 'continue_fetch',
          reasoning: 'Fetch the discovered official candidate through the default backend.',
          searchActions: [],
          fetchActions: [
            {
              url: state.discoveredCandidates[0]?.url ?? 'https://www.changzhou.gov.cn/',
              why: 'Fetch the first discovered candidate',
            },
          ],
          uncertainties: [],
          discardedLeads: [],
        };
      },
    },
  );

  assert.equal(decisionStep, 2);
  assert.equal(result.discoveredCandidates.length > 0, true);
  assert.equal(result.fetchedEvidence.length, 1);
  assert.equal(result.fetchedEvidence[0]?.backend, 'search-mcp:fetch_url');
});


