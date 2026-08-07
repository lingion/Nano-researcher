import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyDomainDefaults,
  createFileDomainResolver,
  parseDomainDocument,
} from '../../src/domain/resolver.ts';

async function withDomainDir(files: Record<string, string>, run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'domain-resolver-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(root, name), content);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('parseDomainDocument treats a body-only document as the prompt with no frontmatter', () => {
  const { frontmatter, body } = parseDomainDocument('# Plain\n\nYou are a medical agent.');
  assert.deepEqual(frontmatter, {});
  assert.equal(body, '# Plain\n\nYou are a medical agent.');
});

test('parseDomainDocument splits frontmatter from the prompt body', () => {
  const { frontmatter, body } = parseDomainDocument('---\nengineScope: [baidu, sogou]\ntargetResultCount: 10\nevidenceRequired: true\n---\n\nYou are the policy agent.');
  assert.deepEqual(frontmatter.engineScope, ['baidu', 'sogou']);
  assert.equal(frontmatter.targetResultCount, 10);
  assert.equal(frontmatter.evidenceRequired, true);
  assert.equal(body, 'You are the policy agent.');
});

test('parseDomainDocument ignores unknown frontmatter keys without failing', () => {
  const { frontmatter, body } = parseDomainDocument('---\nfutureField: maybe\nlocale: en\n---\nbody text');
  assert.equal(frontmatter.engineScope, undefined);
  assert.equal(frontmatter.completionMode, undefined);
  assert.equal(body, 'body text');
});

test('file resolver returns the generic fallback prompt when general.md is absent', async () => {
  await withDomainDir({}, async (root) => {
    const resolver = createFileDomainResolver(root, 'fallback prompt');
    const absent = await resolver.resolve(undefined);
    assert.equal(absent.domain, 'general');
    assert.equal(absent.systemPrompt, 'fallback prompt');
    const general = await resolver.resolve('general');
    assert.equal(general.systemPrompt, 'fallback prompt');
    assert.equal(general.engineScope, undefined);
    assert.equal(general.defaults, undefined);
  });
});

test('file resolver loads domains/general.md as the default when it exists', async () => {
  await withDomainDir({
    'general.md': '---\ntargetResultCount: 3\n---\nYou are the customized default agent.',
    'law.md': 'You are a legal agent.',
  }, async (root) => {
    const resolver = createFileDomainResolver(root, 'fallback');
    const absent = await resolver.resolve(undefined);
    assert.equal(absent.domain, 'general');
    assert.equal(absent.systemPrompt, 'You are the customized default agent.');
    assert.equal(absent.defaults?.targetResultCount, 3);
    const explicit = await resolver.resolve('general');
    assert.equal(explicit.systemPrompt, 'You are the customized default agent.');
  });
});

test('file resolver loads a named domain with prompt, engine scope, and defaults', async () => {
  await withDomainDir({
    'medical.md': '---\nengineScope: [bing, general-web]\ncompletionMode: target_results\ntargetResultCount: 5\nevidenceRequired: true\n---\nYou are a medical research agent.',
  }, async (root) => {
    const resolver = createFileDomainResolver(root);
    const resolved = await resolver.resolve('medical');
    assert.equal(resolved.domain, 'medical');
    assert.equal(resolved.systemPrompt, 'You are a medical research agent.');
    assert.deepEqual(resolved.engineScope, ['bing', 'general-web']);
    assert.deepEqual(resolved.defaults, { completionMode: 'target_results', targetResultCount: 5, evidenceRequired: true });
  });
});

test('file resolver rejects an invalid domain slug', async () => {
  await withDomainDir({}, async (root) => {
    const resolver = createFileDomainResolver(root);
    await assert.rejects(() => resolver.resolve('not a slug'), /invalid_domain/);
  });
});

test('file resolver throws unknown_domain for a missing document', async () => {
  await withDomainDir({}, async (root) => {
    const resolver = createFileDomainResolver(root);
    await assert.rejects(() => resolver.resolve('missing'), /unknown_domain/);
  });
});

test('list enumerates domain slugs without the general fallback', async () => {
  await withDomainDir({ 'general.md': 'x', 'policy.md': 'y', 'medical.md': 'z', 'readme.txt': 'ignore' }, async (root) => {
    const resolver = createFileDomainResolver(root);
    assert.deepEqual(await resolver.list(), ['general', 'medical', 'policy']);
  });
});

test('list returns an empty array when the directory does not exist', async () => {
  const resolver = createFileDomainResolver(path.join(tmpdir(), 'does-not-exist-' + Date.now()));
  assert.deepEqual(await resolver.list(), []);
});

test('applyDomainDefaults fills only gaps, never overriding explicit caller values', () => {
  const task = { question: 'q', options: { completionMode: 'rounds' as const, maxIterations: 50 } };
  const result = applyDomainDefaults(task, {
    completionMode: 'target_results',
    targetResultCount: 8,
    evidenceRequired: true,
    minFetchedPages: 4,
  });
  assert.equal(result.options!.completionMode, 'rounds');
  assert.equal(result.options!.maxIterations, 50);
  assert.equal(result.options!.targetResultCount, 8);
  assert.equal(result.options!.evidenceRequired, true);
  assert.equal(result.options!.minFetchedPages, 4);
});

test('applyDomainDefaults leaves a task without options untouched in shape', () => {
  const task = { question: 'q' };
  const result = applyDomainDefaults(task, { evidenceRequired: false });
  assert.equal(result.options!.evidenceRequired, false);
  assert.deepEqual(result.options!.maxIterations, undefined);
});

test('shipped domains parse and resolve against the repository domains directory', async () => {
  const root = path.resolve('domains');
  const resolver = createFileDomainResolver(root);
  const policy = await resolver.resolve('policy');
  assert.equal(policy.domain, 'policy');
  assert.ok(policy.systemPrompt.length > 100);
  assert.equal(policy.engineScope, undefined);
  assert.equal(policy.defaults!.completionMode, 'target_results');
  assert.equal(policy.defaults!.targetResultCount, 10);
  assert.equal(policy.defaults!.evidenceRequired, true);
  const slugs = await resolver.list();
  assert.ok(slugs.includes('policy'));
  assert.ok(slugs.includes('general'));
});
