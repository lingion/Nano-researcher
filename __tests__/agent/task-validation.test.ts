import test from 'node:test';
import assert from 'node:assert/strict';
import { validateResearchTask } from '../../src/agent/task-validation.ts';
import type { ResearchTask } from '../../src/agent/types.ts';

function task(overrides: Partial<ResearchTask> = {}): ResearchTask {
  return { question: 'q', ...overrides };
}

test('accepts a valid domain slug', () => {
  assert.doesNotThrow(() => validateResearchTask(task({ domain: 'medical' })));
  assert.doesNotThrow(() => validateResearchTask(task({ domain: 'china-policy' })));
  assert.doesNotThrow(() => validateResearchTask(task({ domain: 'a1' })));
});

test('accepts an absent domain (generic path stays domain-agnostic)', () => {
  assert.doesNotThrow(() => validateResearchTask(task()));
});

test('rejects malformed domain slugs', () => {
  for (const domain of ['', '  ', 'Not Allowed', 'under_score', 'with space', 'a'.repeat(101)]) {
    assert.throws(() => validateResearchTask(task({ domain })), /invalid_domain/, `domain=${JSON.stringify(domain)}`);
  }
});

test('accepts engineScope as engine names or capability tags', () => {
  assert.doesNotThrow(() => validateResearchTask(task({ options: { engineScope: ['baidu', 'chinese-web'] } })));
});

test('rejects an empty or non-array engineScope', () => {
  assert.throws(() => validateResearchTask(task({ options: { engineScope: [] } })), /invalid_option_engineScope/);
  // @ts-expect-error — exercising runtime rejection of a malformed value
  assert.throws(() => validateResearchTask(task({ options: { engineScope: 'baidu' } })), /invalid_option_engineScope/);
});

test('rejects malformed engineScope entries', () => {
  for (const scope of [[''], ['bad tag'], ['UPPER OK' as unknown as string]]) {
    assert.throws(() => validateResearchTask(task({ options: { engineScope: scope } })), /invalid_option_engineScope/);
  }
});
