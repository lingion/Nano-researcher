import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';

import { writeReportHtml } from '../../src/artifacts/write-report-html.ts';

test('writeReportHtml escapes title text in title and heading', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'write-report-html-'));
  const file = path.join(dir, 'report.html');
  await writeReportHtml(file, '<img src=x onerror=alert(1)>&"');
  const html = await readFile(file, 'utf8');
  assert.match(html, /<title>&lt;img src=x onerror=alert\(1\)&gt;&amp;&quot;<\/title>/);
  assert.match(html, /<h1>&lt;img src=x onerror=alert\(1\)&gt;&amp;&quot;<\/h1>/);
  assert.doesNotMatch(html, /<img/);
});

test('writeReportHtml creates parent directories before publishing the report', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'write-report-html-parent-'));
  const file = path.join(dir, 'nested', 'report.html');

  await writeReportHtml(file, 'Nested report');

  assert.match(await readFile(file, 'utf8'), /<title>Nested report<\/title>/);
});
