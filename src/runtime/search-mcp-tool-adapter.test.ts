import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSearchMcpWorkerPath } from './search-mcp-tool-adapter.js';
import type { SearchDiscoveryRecord } from '../search-fusion/types.js';
test('search MCP worker path defaults to a repository-relative vendored stdio server', () => {
  const workerPath = resolveSearchMcpWorkerPath({});

  assert.match(workerPath, /vendor\/search-mcp\/src\/stdio-server\.js$/);
  assert.doesNotMatch(workerPath, /search-mcp-worker-kerry/);
});

test('search MCP adapter contract maps Kerry-style search and fetch records', () => {
  const candidate: SearchDiscoveryRecord = {
    query: '黑龙江省 2026 大规模设备更新 政策',
    title: '关于印发《黑龙江省2026年大规模设备更新和消费品以旧换新实施方案》的通知',
    url: 'https://drc.hlj.gov.cn/drc/c111444/202602/c00_31915357.shtml',
    snippet: '实施方案已经省政府同意，现印发给你们。',
    source: 'baidu',
    sources: ['baidu'],
    quality_status: 'green',
    quality_reason: 'usable_results',
    kerry_quality_status: 'usable_results',
    kerry_quality_reason: 'usable_results',
  };

  const page: FetchedPageRecord = {
    requestedUrl: candidate.url,
    finalUrl: candidate.url,
    title: candidate.title,
    content: '《黑龙江省2026年大规模设备更新和消费品以旧换新实施方案》已经省政府同意正式印发实施。',
    backend: 'search-mcp:fetch_url',
    evidence_clues: {
      is_suspected_reprint: false,
      extracted_doc_no: '黑发改环资规〔2026〕1号',
      potential_official_urls: [],
    },
    kerry_cleaning: {
      raw_text: '首页 登录 《黑龙江省2026年大规模设备更新和消费品以旧换新实施方案》已经省政府同意正式印发实施。',
      cleaned_text: '《黑龙江省2026年大规模设备更新和消费品以旧换新实施方案》已经省政府同意正式印发实施。',
      metadata: {
        document_number: '黑发改环资规〔2026〕1号',
        issuing_body: '黑龙江省发展和改革委员会',
      },
      removed_fragments: [{ reason: 'chrome_block', text: '首页 登录' }],
      cleaning_alerts: [],
      cleaning_stats: { raw_length: 60, cleaned_length: 40 },
    },
  };

  assert.equal(candidate.kerry_quality_status, 'usable_results');
  assert.equal(page.backend, 'search-mcp:fetch_url');
  assert.equal(page.content, page.kerry_cleaning?.cleaned_text);
  assert.equal(page.kerry_cleaning?.metadata?.document_number, '黑发改环资规〔2026〕1号');
  assert.deepEqual(page.kerry_cleaning?.cleaning_alerts, []);
});
