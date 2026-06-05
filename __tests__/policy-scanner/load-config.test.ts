import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadScannerConfig } from '../../src/policy-scanner/load-config.ts';

test('loadScannerConfig reads rules and domains config', async () => {
  const config = await loadScannerConfig({
    rulesPath: new URL('../../config/rules.json', import.meta.url),
    domainsPath: new URL('../../config/domains.json', import.meta.url),
  });

  assert.equal(config.rules.pdf_elevation, true);
  assert.ok(config.rules.derivative_keywords.includes('解读'));
  assert.equal(config.domains.primary_source_domains[0], 'shrd.gov.cn');
});

test('loadScannerConfig warns and falls back when rules config is missing', async () => {
  const warnings: string[] = [];
  const config = await loadScannerConfig({
    rulesPath: new URL('../../config/missing-rules.json', import.meta.url),
    domainsPath: new URL('../../config/domains.json', import.meta.url),
    warn: (message) => warnings.push(message),
  });

  assert.match(warnings.join('\n'), /配置文件缺失/);
  assert.equal(config.rules.pdf_elevation, true);
  assert.ok(config.rules.derivative_keywords.includes('解读'));
});

test('loadScannerConfig warns and falls back when rules config is invalid JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'policy-scanner-config-'));
  const invalidRulesPath = join(dir, 'rules.json');
  await writeFile(invalidRulesPath, '{ invalid json', 'utf8');

  const warnings: string[] = [];
  const config = await loadScannerConfig({
    rulesPath: new URL(`file://${invalidRulesPath}`),
    domainsPath: new URL('../../config/domains.json', import.meta.url),
    warn: (message) => warnings.push(message),
  });

  assert.match(warnings.join('\n'), /配置文件格式错误/);
  assert.equal(config.rules.default_search_limit, 10);
});
