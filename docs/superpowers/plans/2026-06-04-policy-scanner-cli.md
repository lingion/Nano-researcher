# Policy Scanner CLI Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the current runtime prototype into a reusable `policy-scanner` CLI that accepts a topic from the command line, loads judgment/search/reporting rules from config files, runs the existing search/fetch/arbitration pipeline, and emits both raw JSON artifacts and a user-facing Markdown report.

**Architecture:** Keep the existing `search-mcp` fetch/search seam and workspace managers, but pull the ad-hoc runtime logic out of throwaway scripts into a small CLI application with three focused layers: config loading, scan engine orchestration, and report rendering. The CLI should remain thin; all hardcoded domain/rule logic moves into JSON config, and the engine returns a structured result object that both raw logging and Markdown reporting consume.

**Tech Stack:** TypeScript, Node.js ESM, `tsx`, existing MCP stdio adapter, existing `EvidenceManager` / `ReportManager`, plus `yargs` for CLI argument parsing.

---

## File Structure

### Create
- `/Users/lingion/repo-downloads/local-policy-agent/bin/policy-scanner.ts`
  - Executable CLI shim that invokes the packaged scanner.
- `/Users/lingion/repo-downloads/local-policy-agent/config/rules.json`
  - Rule configuration for trusted domains, derivative keywords, PDF elevation, search defaults, and arbitration thresholds.
- `/Users/lingion/repo-downloads/local-policy-agent/config/domains.json`
  - Domain hierarchy and tier hints used by source arbitration.
- `/Users/lingion/repo-downloads/local-policy-agent/src/policy-scanner/config-schema.ts`
  - Type definitions and parsers for external config.
- `/Users/lingion/repo-downloads/local-policy-agent/src/policy-scanner/load-config.ts`
  - Reads and validates config files.
- `/Users/lingion/repo-downloads/local-policy-agent/src/policy-scanner/types.ts`
  - Shared scan result, candidate verdict, and report data types.
- `/Users/lingion/repo-downloads/local-policy-agent/src/policy-scanner/engine/classify-tier.ts`
  - Maps URL + config hierarchy into source tier candidates.
- `/Users/lingion/repo-downloads/local-policy-agent/src/policy-scanner/engine/judge-candidate.ts`
  - Reusable verdict logic previously embedded in ad-hoc runtime scripts.
- `/Users/lingion/repo-downloads/local-policy-agent/src/policy-scanner/engine/scan-topic.ts`
  - Orchestrates queries, search, fetch, verdicts, arbitration, and persistence.
- `/Users/lingion/repo-downloads/local-policy-agent/src/policy-scanner/reporter/render-report-markdown.ts`
  - Converts scan results into human-readable Markdown.
- `/Users/lingion/repo-downloads/local-policy-agent/src/policy-scanner/write-scan-artifacts.ts`
  - Writes raw JSON/log output plus the rendered Markdown report.
- `/Users/lingion/repo-downloads/local-policy-agent/src/policy-scanner/index.ts`
  - Public entrypoint exporting the CLI-facing runner.
- `/Users/lingion/repo-downloads/local-policy-agent/__tests__/policy-scanner/load-config.test.ts`
  - Config loading/validation tests.
- `/Users/lingion/repo-downloads/local-policy-agent/__tests__/policy-scanner/judge-candidate.test.ts`
  - Verdict and PDF elevation tests.
- `/Users/lingion/repo-downloads/local-policy-agent/__tests__/policy-scanner/render-report-markdown.test.ts`
  - Markdown reporting tests.
- `/Users/lingion/repo-downloads/local-policy-agent/__tests__/policy-scanner/scan-topic.test.ts`
  - Engine orchestration tests with stubbed search/fetch tools.

### Modify
- `/Users/lingion/repo-downloads/local-policy-agent/package.json`
  - Add CLI-friendly scripts and dependencies.
- `/Users/lingion/repo-downloads/local-policy-agent/src/runtime/search-mcp-tool-adapter.ts`
  - Optionally export tiny helpers only if the scanner needs already-existing structured metadata access without duplication.
- `/Users/lingion/repo-downloads/local-policy-agent/src/workspace/report-manager.ts`
  - Only if needed to support stable external Markdown writing paths or titles from the CLI.
- `/Users/lingion/repo-downloads/local-policy-agent/README.md`
  - Document installation, config, and usage.

---

### Task 1: Add config loading and validation

**Files:**
- Create: `/Users/lingion/repo-downloads/local-policy-agent/config/rules.json`
- Create: `/Users/lingion/repo-downloads/local-policy-agent/config/domains.json`
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/policy-scanner/config-schema.ts`
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/policy-scanner/load-config.ts`
- Test: `/Users/lingion/repo-downloads/local-policy-agent/__tests__/policy-scanner/load-config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/lingion/repo-downloads/local-policy-agent && pnpm exec tsx --test __tests__/policy-scanner/load-config.test.ts
```

Expected: FAIL with module-not-found for `src/policy-scanner/load-config.ts`

- [ ] **Step 3: Write minimal implementation**

`config/rules.json`
```json
{
  "trusted_domains": [".gov.cn", ".npc.gov.cn", ".org.cn"],
  "derivative_keywords": ["解读", "一图读懂", "新闻通稿", "问答", "报道"],
  "pdf_elevation": true,
  "default_search_engines": ["bing_cn", "baidu", "sogou", "bing"],
  "default_search_limit": 10,
  "default_fetch_max_chars": 24000
}
```

`config/domains.json`
```json
{
  "primary_source_domains": ["shrd.gov.cn", "sh.npc.gov.cn", "www.gov.cn", "gov.cn"],
  "secondary_source_domains": ["shanghai.gov.cn"],
  "official_suffixes": [".gov.cn", ".org.cn"]
}
```

`src/policy-scanner/config-schema.ts`
```ts
export interface ScannerRulesConfig {
  trusted_domains: string[];
  derivative_keywords: string[];
  pdf_elevation: boolean;
  default_search_engines: string[];
  default_search_limit: number;
  default_fetch_max_chars: number;
}

export interface ScannerDomainsConfig {
  primary_source_domains: string[];
  secondary_source_domains: string[];
  official_suffixes: string[];
}

export interface ScannerConfig {
  rules: ScannerRulesConfig;
  domains: ScannerDomainsConfig;
}
```

`src/policy-scanner/load-config.ts`
```ts
import { readFile } from 'node:fs/promises';
import type { ScannerConfig, ScannerDomainsConfig, ScannerRulesConfig } from './config-schema.ts';

export async function loadScannerConfig(input: {
  rulesPath: URL;
  domainsPath: URL;
}): Promise<ScannerConfig> {
  const rules = JSON.parse(await readFile(input.rulesPath, 'utf8')) as ScannerRulesConfig;
  const domains = JSON.parse(await readFile(input.domainsPath, 'utf8')) as ScannerDomainsConfig;
  return { rules, domains };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd /Users/lingion/repo-downloads/local-policy-agent && pnpm exec tsx --test __tests__/policy-scanner/load-config.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add config/rules.json config/domains.json src/policy-scanner/config-schema.ts src/policy-scanner/load-config.ts __tests__/policy-scanner/load-config.test.ts
git commit -m "feat: add policy scanner config loader"
```

### Task 2: Extract candidate tiering and verdict logic

**Files:**
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/policy-scanner/types.ts`
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/policy-scanner/engine/classify-tier.ts`
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/policy-scanner/engine/judge-candidate.ts`
- Test: `/Users/lingion/repo-downloads/local-policy-agent/__tests__/policy-scanner/judge-candidate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { judgeCandidate } from '../../src/policy-scanner/engine/judge-candidate.ts';

test('judgeCandidate elevates official PDF on trusted domain', () => {
  const verdict = judgeCandidate({
    taskTopic: '上海市公共场所控制吸烟条例',
    page: {
      finalUrl: 'https://www.shanghai.gov.cn/example.pdf',
      title: '上海市公共场所控制吸烟条例',
      content: '%PDF-1.7 binary',
      kerry_cleaning: { metadata: {} },
    },
    config: {
      rules: {
        trusted_domains: ['.gov.cn', '.org.cn'],
        derivative_keywords: ['解读'],
        pdf_elevation: true,
        default_search_engines: [],
        default_search_limit: 10,
        default_fetch_max_chars: 24000,
      },
      domains: {
        primary_source_domains: ['shanghai.gov.cn'],
        secondary_source_domains: [],
        official_suffixes: ['.gov.cn', '.org.cn'],
      },
    },
  });

  assert.equal(verdict.ok, true);
  assert.ok(verdict.reasons.includes('official_pdf_detected_and_elevated'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/lingion/repo-downloads/local-policy-agent && pnpm exec tsx --test __tests__/policy-scanner/judge-candidate.test.ts
```

Expected: FAIL with module-not-found for `judge-candidate.ts`

- [ ] **Step 3: Write minimal implementation**

`src/policy-scanner/types.ts`
```ts
import type { FetchedPageRecord } from '../fetch-fusion/types.js';
import type { ScannerConfig } from './config-schema.ts';

export interface CandidateVerdict {
  ok: boolean;
  tier: string;
  reasons: string[];
  rejects: string[];
  exactTitle: boolean;
  derivative: boolean;
  isOfficialPdf: boolean;
}

export interface JudgeCandidateInput {
  taskTopic: string;
  page: Pick<FetchedPageRecord, 'finalUrl' | 'title' | 'content' | 'kerry_cleaning'>;
  config: ScannerConfig;
}
```

`src/policy-scanner/engine/classify-tier.ts`
```ts
import type { ScannerConfig } from '../config-schema.ts';

export function classifyTier(url: string, config: ScannerConfig): string {
  const hostname = new URL(url).hostname;
  if (config.domains.primary_source_domains.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`))) {
    return 'primary_source_candidate';
  }
  if (config.domains.secondary_source_domains.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`))) {
    return 'secondary_source_candidate';
  }
  if (config.domains.official_suffixes.some((suffix) => hostname.endsWith(suffix.replace(/^\./, '')))) {
    return 'official_repost_or_related';
  }
  return 'unknown';
}
```

`src/policy-scanner/engine/judge-candidate.ts`
```ts
import { classifyTier } from './classify-tier.ts';
import type { CandidateVerdict, JudgeCandidateInput } from '../types.ts';

export function judgeCandidate(input: JudgeCandidateInput): CandidateVerdict {
  const text = [
    input.page.title,
    input.page.content,
    JSON.stringify(input.page.kerry_cleaning?.metadata ?? {}),
    input.page.finalUrl,
  ].join('\n');

  const exactTitle = text.includes(input.taskTopic);
  const derivative = input.config.rules.derivative_keywords.some((word) => text.slice(0, 3000).includes(word));
  const formatBad = /%PDF-|�|We're sorry but .*JavaScript|Access Denied/i.test(String(input.page.content ?? '').slice(0, 500));
  const isPdf = /\.pdf(?:$|\?)/i.test(input.page.finalUrl);
  const isTrustedOfficialDomain = input.config.rules.trusted_domains.some((suffix) => new URL(input.page.finalUrl).hostname.endsWith(suffix.replace(/^\./, '')));
  const tier = classifyTier(input.page.finalUrl, input.config);
  const reasons: string[] = [];
  const rejects: string[] = [];

  if (isPdf && isTrustedOfficialDomain && input.config.rules.pdf_elevation) {
    return {
      ok: true,
      tier,
      reasons: ['official_pdf_detected_and_elevated', `tier:${tier}`],
      rejects: [],
      exactTitle,
      derivative,
      isOfficialPdf: true,
    };
  }

  if (exactTitle) reasons.push('exact_title_match');
  else rejects.push('missing_exact_title');

  if (formatBad) rejects.push('format_corrupt_or_js_shell');
  if (derivative) rejects.push('derivative_or_explanatory_page');
  if (tier !== 'primary_source_candidate') rejects.push('not_primary_source_candidate');

  reasons.push(`tier:${tier}`);

  return {
    ok: rejects.length === 0,
    tier,
    reasons,
    rejects,
    exactTitle,
    derivative,
    isOfficialPdf: false,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd /Users/lingion/repo-downloads/local-policy-agent && pnpm exec tsx --test __tests__/policy-scanner/judge-candidate.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/policy-scanner/types.ts src/policy-scanner/engine/classify-tier.ts src/policy-scanner/engine/judge-candidate.ts __tests__/policy-scanner/judge-candidate.test.ts
git commit -m "feat: extract policy scanner verdict engine"
```

### Task 3: Build the scan engine around existing search/fetch tools

**Files:**
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/policy-scanner/engine/scan-topic.ts`
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/src/runtime/search-mcp-tool-adapter.ts:119-183`
- Test: `/Users/lingion/repo-downloads/local-policy-agent/__tests__/policy-scanner/scan-topic.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanTopic } from '../../src/policy-scanner/engine/scan-topic.ts';

test('scanTopic keeps one canonical accepted candidate and demotes others', async () => {
  const result = await scanTopic({
    topic: '发改办投资〔2026〕88号',
    queries: ['q1'],
    config: {
      rules: {
        trusted_domains: ['.gov.cn'],
        derivative_keywords: ['解读'],
        pdf_elevation: true,
        default_search_engines: [],
        default_search_limit: 10,
        default_fetch_max_chars: 24000,
      },
      domains: {
        primary_source_domains: ['zfxxgk.ndrc.gov.cn'],
        secondary_source_domains: ['fgw.hunan.gov.cn'],
        official_suffixes: ['.gov.cn'],
      },
    },
    searchTool: {
      search: async () => [
        { query: 'q1', title: '主件', url: 'https://zfxxgk.ndrc.gov.cn/doc', snippet: '', source: 'test' },
        { query: 'q1', title: '转载', url: 'https://fgw.hunan.gov.cn/doc', snippet: '', source: 'test' },
      ],
    },
    fetchTool: {
      fetch: async (url) => ({
        requestedUrl: url,
        finalUrl: url,
        title: '发改办投资〔2026〕88号 主件',
        content: '发改办投资〔2026〕88号',
        backend: 'test',
      }),
    },
  });

  assert.equal(result.accepted.length, 1);
  assert.equal(result.canonical?.page.finalUrl, 'https://zfxxgk.ndrc.gov.cn/doc');
  assert.equal(result.rejected[0]?.verdict.rejects.includes('not_primary_source_candidate'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/lingion/repo-downloads/local-policy-agent && pnpm exec tsx --test __tests__/policy-scanner/scan-topic.test.ts
```

Expected: FAIL with module-not-found for `scan-topic.ts`

- [ ] **Step 3: Write minimal implementation**

`src/policy-scanner/engine/scan-topic.ts`
```ts
import { judgeCandidate } from './judge-candidate.ts';
import type { ScannerConfig } from '../config-schema.ts';
import type { CandidateVerdict } from '../types.ts';
import type { FetchTool, SearchTool } from '../../runtime/tool-registry.ts';
import type { FetchedPageRecord } from '../../fetch-fusion/types.js';
import type { SearchDiscoveryRecord } from '../../search-fusion/types.js';

export interface ScanTopicResult {
  accepted: Array<{ result: SearchDiscoveryRecord; page: FetchedPageRecord; verdict: CandidateVerdict }>;
  rejected: Array<{ result: SearchDiscoveryRecord; page: FetchedPageRecord; verdict: CandidateVerdict }>;
  canonical: { result: SearchDiscoveryRecord; page: FetchedPageRecord; verdict: CandidateVerdict } | null;
}

export async function scanTopic(input: {
  topic: string;
  queries: string[];
  config: ScannerConfig;
  searchTool: SearchTool;
  fetchTool: FetchTool;
}): Promise<ScanTopicResult> {
  const seen = new Set<string>();
  const accepted: ScanTopicResult['accepted'] = [];
  const rejected: ScanTopicResult['rejected'] = [];

  for (const query of input.queries) {
    const results = await input.searchTool.search(query);
    for (const result of results) {
      if (!result.url || seen.has(result.url)) continue;
      seen.add(result.url);
      const page = await input.fetchTool.fetch(result.url);
      const verdict = judgeCandidate({
        taskTopic: input.topic,
        page,
        config: input.config,
      });
      const item = { result, page, verdict };
      if (verdict.ok) accepted.push(item);
      else rejected.push(item);
    }
  }

  return {
    accepted: accepted.slice(0, 1),
    rejected,
    canonical: accepted[0] ?? null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd /Users/lingion/repo-downloads/local-policy-agent && pnpm exec tsx --test __tests__/policy-scanner/scan-topic.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/policy-scanner/engine/scan-topic.ts __tests__/policy-scanner/scan-topic.test.ts
git commit -m "feat: add policy scanner scan engine"
```

### Task 4: Render human-readable Markdown reports

**Files:**
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/policy-scanner/reporter/render-report-markdown.ts`
- Test: `/Users/lingion/repo-downloads/local-policy-agent/__tests__/policy-scanner/render-report-markdown.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderReportMarkdown } from '../../src/policy-scanner/reporter/render-report-markdown.ts';

test('renderReportMarkdown prints canonical section and demotions', () => {
  const markdown = renderReportMarkdown({
    topic: '发改办投资〔2026〕88号',
    canonical: {
      page: { finalUrl: 'https://zfxxgk.ndrc.gov.cn/doc', title: '主件' },
      verdict: { reasons: ['exact_docno'], rejects: [], tier: 'primary_source_candidate', ok: true, exactTitle: true, derivative: false, isOfficialPdf: false },
    },
    accepted: [],
    rejected: [
      {
        page: { finalUrl: 'https://fgw.hunan.gov.cn/doc', title: '转载' },
        verdict: { reasons: ['tier:secondary_source_candidate'], rejects: ['not_primary_source_candidate'], tier: 'secondary_source_candidate', ok: false, exactTitle: true, derivative: false, isOfficialPdf: false },
      },
    ],
  });

  assert.match(markdown, /# 发改办投资〔2026〕88号/);
  assert.match(markdown, /Canonical/);
  assert.match(markdown, /Demoted or Rejected/);
  assert.match(markdown, /https:\/\/zfxxgk\.ndrc\.gov\.cn\/doc/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/lingion/repo-downloads/local-policy-agent && pnpm exec tsx --test __tests__/policy-scanner/render-report-markdown.test.ts
```

Expected: FAIL with module-not-found for `render-report-markdown.ts`

- [ ] **Step 3: Write minimal implementation**

`src/policy-scanner/reporter/render-report-markdown.ts`
```ts
export function renderReportMarkdown(input: {
  topic: string;
  canonical: { page: { finalUrl: string; title: string }; verdict: { reasons: string[] } } | null;
  accepted: Array<{ page: { finalUrl: string; title: string } }>;
  rejected: Array<{ page: { finalUrl: string; title: string }; verdict: { rejects: string[]; reasons: string[] } }>;
}): string {
  const rejectedLines = input.rejected.map((item, index) => {
    return `${index + 1}. ${item.page.title}\n   - ${item.page.finalUrl}\n   - rejects: ${item.verdict.rejects.join(', ')}\n   - reasons: ${item.verdict.reasons.join(', ')}`;
  });

  return [
    `# ${input.topic}`,
    '',
    '## Canonical',
    input.canonical
      ? `- ${input.canonical.page.title}\n- ${input.canonical.page.finalUrl}\n- reasons: ${input.canonical.verdict.reasons.join(', ')}`
      : 'none',
    '',
    '## Demoted or Rejected',
    ...(rejectedLines.length ? rejectedLines : ['none']),
    '',
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd /Users/lingion/repo-downloads/local-policy-agent && pnpm exec tsx --test __tests__/policy-scanner/render-report-markdown.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/policy-scanner/reporter/render-report-markdown.ts __tests__/policy-scanner/render-report-markdown.test.ts
git commit -m "feat: add policy scanner markdown reporter"
```

### Task 5: Write scan artifacts and CLI runner

**Files:**
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/policy-scanner/write-scan-artifacts.ts`
- Create: `/Users/lingion/repo-downloads/local-policy-agent/src/policy-scanner/index.ts`
- Create: `/Users/lingion/repo-downloads/local-policy-agent/bin/policy-scanner.ts`
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/package.json`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runPolicyScanner } from '../../src/policy-scanner/index.ts';

test('runPolicyScanner returns report and raw artifact paths', async () => {
  const result = await runPolicyScanner({
    topic: '测试条例',
    outputDir: new URL('../tmp-output/', import.meta.url),
    config: {
      rules: {
        trusted_domains: ['.gov.cn'],
        derivative_keywords: ['解读'],
        pdf_elevation: true,
        default_search_engines: [],
        default_search_limit: 10,
        default_fetch_max_chars: 24000,
      },
      domains: {
        primary_source_domains: ['example.gov.cn'],
        secondary_source_domains: [],
        official_suffixes: ['.gov.cn'],
      },
    },
    searchTool: { search: async () => [] },
    fetchTool: { fetch: async () => { throw new Error('unused'); } },
  });

  assert.match(result.rawResultPath, /raw-result\.json$/);
  assert.match(result.reportPath, /report\.md$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/lingion/repo-downloads/local-policy-agent && pnpm exec tsx --test __tests__/policy-scanner/index.test.ts
```

Expected: FAIL because `src/policy-scanner/index.ts` does not exist

- [ ] **Step 3: Write minimal implementation**

`src/policy-scanner/write-scan-artifacts.ts`
```ts
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderReportMarkdown } from './reporter/render-report-markdown.ts';

export async function writeScanArtifacts(input: {
  outputDir: URL;
  topic: string;
  result: {
    canonical: any;
    accepted: any[];
    rejected: any[];
  };
}): Promise<{ rawResultPath: string; reportPath: string }> {
  const dirPath = input.outputDir.pathname;
  await mkdir(dirPath, { recursive: true });
  const rawResultPath = path.join(dirPath, 'raw-result.json');
  const reportPath = path.join(dirPath, 'report.md');
  await writeFile(rawResultPath, JSON.stringify(input.result, null, 2));
  await writeFile(reportPath, renderReportMarkdown({
    topic: input.topic,
    canonical: input.result.canonical,
    accepted: input.result.accepted,
    rejected: input.result.rejected,
  }));
  return { rawResultPath, reportPath };
}
```

`src/policy-scanner/index.ts`
```ts
import path from 'node:path';
import { loadScannerConfig } from './load-config.ts';
import { scanTopic } from './engine/scan-topic.ts';
import { writeScanArtifacts } from './write-scan-artifacts.ts';
import { createSearchMcpTools } from '../runtime/search-mcp-tool-adapter.ts';

export async function runPolicyScanner(input: {
  topic: string;
  outputDir?: URL;
  config?: Awaited<ReturnType<typeof loadScannerConfig>>;
  searchTool?: Awaited<ReturnType<typeof createSearchMcpTools>>['searchTool'];
  fetchTool?: Awaited<ReturnType<typeof createSearchMcpTools>>['fetchTool'];
}) {
  const config = input.config ?? await loadScannerConfig({
    rulesPath: new URL('../../config/rules.json', import.meta.url),
    domainsPath: new URL('../../config/domains.json', import.meta.url),
  });

  const ownedTools = input.searchTool && input.fetchTool
    ? null
    : await createSearchMcpTools({
        searchLimit: config.rules.default_search_limit,
        fetchMaxChars: config.rules.default_fetch_max_chars,
        engines: config.rules.default_search_engines,
      });

  try {
    const result = await scanTopic({
      topic: input.topic,
      queries: [input.topic, `${input.topic} 原文`, `${input.topic} 最新 修正 原文`],
      config,
      searchTool: input.searchTool ?? ownedTools!.searchTool,
      fetchTool: input.fetchTool ?? ownedTools!.fetchTool,
    });

    return await writeScanArtifacts({
      outputDir: input.outputDir ?? new URL(`../../results/${Date.now()}-${encodeURIComponent(input.topic)}/`, import.meta.url),
      topic: input.topic,
      result,
    });
  } finally {
    await ownedTools?.close();
  }
}
```

`bin/policy-scanner.ts`
```ts
#!/usr/bin/env node
import { hideBin } from 'yargs/helpers';
import yargs from 'yargs/yargs';
import { runPolicyScanner } from '../src/policy-scanner/index.ts';

const argv = await yargs(hideBin(process.argv))
  .scriptName('policy-scanner')
  .usage('$0 <topic>')
  .demandCommand(1)
  .parse();

const topic = String(argv._[0]);
const result = await runPolicyScanner({ topic });
console.log(JSON.stringify(result, null, 2));
```

`package.json`
```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "tsx --test",
    "start": "node ./dist/app/index.js",
    "live-audit": "tsx src/app/run-live-audit.ts",
    "scan": "tsx ./bin/policy-scanner.ts"
  },
  "bin": {
    "policy-scanner": "./bin/policy-scanner.ts"
  },
  "dependencies": {
    "yargs": "^17.7.2"
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd /Users/lingion/repo-downloads/local-policy-agent && pnpm exec tsx --test __tests__/policy-scanner/index.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/policy-scanner/write-scan-artifacts.ts src/policy-scanner/index.ts bin/policy-scanner.ts package.json __tests__/policy-scanner/index.test.ts
git commit -m "feat: add policy scanner cli runner"
```

### Task 6: Document usage and delivery workflow

**Files:**
- Modify: `/Users/lingion/repo-downloads/local-policy-agent/README.md`

- [ ] **Step 1: Write the failing doc expectation as a checklist**

```md
- install with `pnpm install`
- run with `pnpm run scan -- "上海市公共场所控制吸烟条例"`
- explain `config/rules.json` and `config/domains.json`
- show output files `raw-result.json` and `report.md`
```

- [ ] **Step 2: Run a usage smoke check to verify docs match reality**

Run:
```bash
cd /Users/lingion/repo-downloads/local-policy-agent && pnpm run scan -- "上海市公共场所控制吸烟条例"
```

Expected: command prints JSON with `rawResultPath` and `reportPath`

- [ ] **Step 3: Write minimal documentation**

Add this section to `README.md`:

```md
## policy-scanner CLI

Install dependencies:

```bash
pnpm install
```

Run a scan:

```bash
pnpm run scan -- "上海市公共场所控制吸烟条例"
```

Config files:
- `config/rules.json` — derivative keywords, trusted domain suffixes, PDF elevation, default search settings
- `config/domains.json` — primary and secondary source domain hierarchy

Outputs:
- `raw-result.json` — machine-readable arbitration output
- `report.md` — human-readable summary with canonical source and demotions
```
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document policy scanner cli"
```

---

## Self-Review

### Spec coverage
- CLI entrypoint: covered by Task 5.
- Config externalization: covered by Tasks 1 and 2.
- Markdown reporting: covered by Task 4 and Task 5.
- Package usability: covered by Task 5 and Task 6.
- Preserve search/fetch/arbitration behavior: covered by Task 3, which wraps existing MCP tools instead of replacing them.

### Placeholder scan
- No `TODO`, `TBD`, or “similar to Task N” placeholders remain.
- Every coding step includes exact file paths and starter code.
- Each test step includes a concrete command and expected failure/pass state.

### Type consistency
- Shared config types are defined once in `config-schema.ts` and reused across the engine and CLI.
- `CandidateVerdict` shape is defined centrally in `types.ts` and consumed by `scan-topic.ts` and `render-report-markdown.ts`.
- `runPolicyScanner()` is the single public CLI runner referenced by both tests and `bin/policy-scanner.ts`.
