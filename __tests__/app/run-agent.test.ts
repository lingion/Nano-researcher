import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../../src/app/run-agent.ts';

test('application service is the single generic agent entrypoint', async () => {
  let persisted = 0;
  const result = await runAgent({ question: 'x' }, {
    llm: { complete: async () => ({ text: JSON.stringify({ decision: 'finish', searchActions: [], fetchActions: [], uncertainties: [], finalAnswer: 'done', evidenceUrls: [], findings: [] }) }) },
    search: { name: 'search', search: async () => ({ outcome: 'success_empty', results: [], provider: 'search', durationMs: 1, retryCount: 0 }) },
    fetch: { name: 'fetch', fetch: async () => { throw new Error('must not fetch'); } },
  }, { evidenceStore: { saveAgentResult: async () => { persisted += 1; } } });

  assert.equal(result.status, 'completed');
  assert.equal(result.state.finalAnswer, 'done');
  assert.equal(persisted, 1);
});
