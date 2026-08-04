import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';

import { writeRunTranscript } from '../../src/artifacts/write-run-transcript.ts';

test('writeRunTranscript syncs the temp file before rename and fsyncs the directory after rename', async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-write-transcript-async-'));
  const outputPath = path.join(outputDir, 'run-transcript.json');
  const events: string[] = [];

  const originalOpen = fs.promises.open.bind(fs.promises);
  const originalRename = fs.promises.rename.bind(fs.promises);

  t.mock.method(fs.promises, 'open', async (targetPath: fs.PathLike, flags?: string | number) => {
    const resolvedPath = String(targetPath);
    const handle = await originalOpen(targetPath, flags);
    const wrappedHandle = Object.create(handle) as fs.promises.FileHandle;

    if (resolvedPath === outputDir) {
      wrappedHandle.sync = async () => {
        events.push(`dir-sync:${resolvedPath}`);
        return await handle.sync();
      };
      wrappedHandle.close = async () => {
        events.push(`dir-close:${resolvedPath}`);
        return await handle.close();
      };
      return wrappedHandle;
    }

    wrappedHandle.sync = async () => {
      events.push(`temp-sync:${resolvedPath}`);
      return await handle.sync();
    };
    wrappedHandle.close = async () => {
      events.push(`temp-close:${resolvedPath}`);
      return await handle.close();
    };
    return wrappedHandle;
  });

  t.mock.method(fs.promises, 'rename', async (from: fs.PathLike, to: fs.PathLike) => {
    events.push(`rename:${String(from)}->${String(to)}`);
    return await originalRename(from, to);
  });

  await writeRunTranscript(outputPath, {
    task: { topic: '科技招商政策' },
    turns: [],
  });

  const renameEvent = events.find((entry) => entry.startsWith('rename:'));
  assert.ok(renameEvent, 'rename should be recorded');

  const tempPath = renameEvent.slice('rename:'.length, renameEvent.indexOf('->'));
  assert.equal(events.includes(`temp-sync:${tempPath}`), true);
  assert.equal(events.includes(`dir-sync:${outputDir}`), true);
  assert.ok(events.indexOf(`temp-sync:${tempPath}`) < events.indexOf(renameEvent));
  assert.ok(events.indexOf(renameEvent) < events.indexOf(`dir-sync:${outputDir}`));

  const persisted = JSON.parse(await readFile(outputPath, 'utf8')) as {
    task?: { topic?: string };
  };
  assert.equal(persisted.task?.topic, '科技招商政策');
});

test('writeRunTranscript.sync syncs the temp file before rename and fsyncs the directory after rename', async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-write-transcript-sync-'));
  const outputPath = path.join(outputDir, 'debug-trace.json');
  const events: string[] = [];

  const originalOpenSync = fs.openSync.bind(fs);
  const originalFsyncSync = fs.fsyncSync.bind(fs);
  const originalCloseSync = fs.closeSync.bind(fs);
  const originalRenameSync = fs.renameSync.bind(fs);

  const fdToPath = new Map<number, string>();

  t.mock.method(fs, 'openSync', (targetPath: fs.PathLike, flags?: string | number) => {
    const fd = originalOpenSync(targetPath, flags);
    fdToPath.set(fd, String(targetPath));
    events.push(`open:${String(targetPath)}`);
    return fd;
  });

  t.mock.method(fs, 'fsyncSync', (fd: number) => {
    events.push(`fsync:${fdToPath.get(fd) ?? `fd:${fd}`}`);
    return originalFsyncSync(fd);
  });

  t.mock.method(fs, 'closeSync', (fd: number) => {
    events.push(`close:${fdToPath.get(fd) ?? `fd:${fd}`}`);
    fdToPath.delete(fd);
    return originalCloseSync(fd);
  });

  t.mock.method(fs, 'renameSync', (oldPath: fs.PathLike, newPath: fs.PathLike) => {
    events.push(`rename:${String(oldPath)}->${String(newPath)}`);
    return originalRenameSync(oldPath, newPath);
  });

  writeRunTranscript.sync(outputPath, {
    task: { topic: '黑龙江高企租金减免' },
    events: [],
  });

  const renameEvent = events.find((entry) => entry.startsWith('rename:'));
  assert.ok(renameEvent, 'rename should be recorded');

  const tempPath = renameEvent.slice('rename:'.length, renameEvent.indexOf('->'));
  assert.equal(events.includes(`open:${tempPath}`), true);
  assert.equal(events.includes(`fsync:${tempPath}`), true);
  assert.equal(events.includes(`open:${outputDir}`), true);
  assert.equal(events.includes(`fsync:${outputDir}`), true);
  assert.ok(events.indexOf(`fsync:${tempPath}`) < events.indexOf(renameEvent));
  assert.ok(events.indexOf(renameEvent) < events.indexOf(`fsync:${outputDir}`));

  const persisted = JSON.parse(await readFile(outputPath, 'utf8')) as {
    task?: { topic?: string };
  };
  assert.equal(persisted.task?.topic, '黑龙江高企租金减免');
});

test('writeRunTranscript debug mode redacts sensitive projection while business mode preserves evidence', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-write-transcript-redaction-'));
  const debugPath = path.join(outputDir, 'debug.json');
  const businessPath = path.join(outputDir, 'business.json');
  const payload = {
    message: 'SYNTHETIC_UPSTREAM_MESSAGE',
    headers: { authorization: 'SYNTHETIC_HEADER_SECRET' },
    content: 'SYNTHETIC_PAGE_CONTENT',
    prompt: 'SYNTHETIC_MODEL_OUTPUT',
    evidence: '完整业务正文',
  };

  await writeRunTranscript(debugPath, payload, { mode: 'debug' });
  await writeRunTranscript(businessPath, payload);

  const debugText = await readFile(debugPath, 'utf8');
  const businessText = await readFile(businessPath, 'utf8');
  assert.doesNotMatch(debugText, /SYNTHETIC_UPSTREAM_MESSAGE|SYNTHETIC_HEADER_SECRET|SYNTHETIC_PAGE_CONTENT|SYNTHETIC_MODEL_OUTPUT/);
  assert.match(debugText, /evidence/);
  assert.match(businessText, /SYNTHETIC_UPSTREAM_MESSAGE|SYNTHETIC_HEADER_SECRET|SYNTHETIC_PAGE_CONTENT|SYNTHETIC_MODEL_OUTPUT/);
  assert.match(businessText, /完整业务正文/);
});

test('writeRunTranscript.sync debug mode redacts sensitive projection', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'local-policy-agent-write-transcript-sync-redaction-'));
  const outputPath = path.join(outputDir, 'debug.json');

  writeRunTranscript.sync(outputPath, {
    stack: 'SYNTHETIC_STACK',
    body: 'SYNTHETIC_PAGE_CONTENT',
    status: 'degraded',
  }, { mode: 'debug' });

  const text = await readFile(outputPath, 'utf8');
  assert.doesNotMatch(text, /SYNTHETIC_STACK|SYNTHETIC_PAGE_CONTENT/);
  assert.match(text, /degraded/);
});
