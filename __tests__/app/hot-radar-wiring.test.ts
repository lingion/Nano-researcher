import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenericSearchProvider } from '../../src/app/create-generic-dependencies.ts';

test('generic search provider is hot-radar with no search engines', () => {
  const provider = createGenericSearchProvider();
  assert.equal(provider.name, 'hot-radar');
  assert.ok(provider.capabilities.includes('hot-board'));
});
