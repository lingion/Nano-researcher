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

test('unknown destination bodies are not copied into scratchpad diagnostics', () => {
  const source = fs.readFileSync(new URL('../../src/nanoclaw-core/poll-loop.ts', import.meta.url), 'utf8');

  assert.match(source, /log\('Unknown destination in agent output, dropping block'\)/);
  assert.match(source, /scratchpadParts\.push\('\[dropped unknown destination\]'\)/);
  assert.doesNotMatch(source, /scratchpadParts\.push\(\`\[dropped unknown destination\] \$\{body\}\`\)/);
});

test('debug diagnostics use the shared safe serializer', () => {
  const bridge = fs.readFileSync(new URL('../../src/runtime/nanoclaw-bridge.ts', import.meta.url), 'utf8');
  const sessionLoop = fs.readFileSync(new URL('../../src/runtime/local-session-loop.ts', import.meta.url), 'utf8');

  assert.match(bridge, /safeSerializeDebugPayload\(/);
  assert.doesNotMatch(bridge, /console\.error\('\[SSE AGGREGATE METADATA\]', JSON\.stringify\(/);
  assert.match(sessionLoop, /safeSerializeDebugPayload\(/);
  assert.doesNotMatch(sessionLoop, /console\.error\('\[LIVE_AUDIT_DEBUG\]', JSON\.stringify\(/);
});

test('provider diagnostics do not expose archive filenames or dynamic SDK details', () => {
  const provider = fs.readFileSync(new URL('../../src/nanoclaw-core/claude-provider.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(provider, /log\(`Archived conversation to \$\{filename\}`\)/);
  assert.doesNotMatch(provider, /log\(`Query completed after \$\{messageCount\} SDK messages`\)/);
  assert.doesNotMatch(provider, /reason = `transcript \$\{/);
});

test('MCP tool diagnostics do not expose user-controlled routing or filenames', () => {
  const source = fs.readFileSync(new URL('../../src/nanoclaw-core/mcp-core-tools.ts', import.meta.url), 'utf8');

  assert.match(source, /log\('send_message completed'\)/);
  assert.match(source, /log\('send_file completed'\)/);
  assert.match(source, /log\('edit_message completed'\)/);
  assert.match(source, /log\('add_reaction completed'\)/);
  assert.doesNotMatch(source, /log\(`send_message:/);
  assert.doesNotMatch(source, /log\(`send_file:/);
  assert.doesNotMatch(source, /log\(`edit_message:/);
  assert.doesNotMatch(source, /log\(`add_reaction:/);
});

test('poll-loop diagnostics do not interpolate provider or message-controlled values', () => {
  const source = fs.readFileSync(new URL('../../src/nanoclaw-core/poll-loop.ts', import.meta.url), 'utf8');

  assert.match(source, /log\('Session rotation requested; starting fresh'\)/);
  assert.match(source, /log\('Message batch completed'\)/);
  assert.doesNotMatch(source, /log\(`Rotating session — \$\{rotateReason\}/);
  assert.doesNotMatch(source, /log\(`Pre-task script skipped .*\$\{skipped\.join/);
  assert.doesNotMatch(source, /log\(`Processing .*\$\{keep\.map/);
});

test('MCP server diagnostics do not expose tool names', () => {
  const source = fs.readFileSync(new URL('../../src/nanoclaw-core/mcp-server.ts', import.meta.url), 'utf8');

  assert.match(source, /log\('Duplicate MCP tool registration skipped'\)/);
  assert.match(source, /log\('MCP server started'\)/);
  assert.doesNotMatch(source, /log\(`Warning: tool/);
  assert.doesNotMatch(source, /log\(`MCP server started with/);
});
