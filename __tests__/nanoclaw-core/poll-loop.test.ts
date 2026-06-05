import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('nanoclaw core files exist in the new project', () => {
  const files = [
    'src/nanoclaw-core/poll-loop.ts',
    'src/nanoclaw-core/provider-types.ts',
    'src/nanoclaw-core/claude-provider.ts',
    'src/nanoclaw-core/formatter.ts',
    'src/nanoclaw-core/mcp-server.ts',
    'src/nanoclaw-core/mcp-core-tools.ts',
    'src/nanoclaw-core/session-state.ts',
  ];

  for (const file of files) {
    assert.equal(fs.existsSync(new URL(`../../${file}`, import.meta.url)), true, `${file} should exist`);
  }
});
