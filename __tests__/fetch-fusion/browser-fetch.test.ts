import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchWithBrowserFallback } from '../../src/fetch-fusion/browser-fetch.ts';

test('browser fetch extracts rendered beta page metadata', async () => {
  const result = await fetchWithBrowserFallback('https://example.cn/beta', {
    staticFetch: async () => ({ title: 'App', content: 'enable javascript' }),
    browser: {
      render: async () => ({
        title: '灰度招募',
        text: '2026-07-20 限量邀请体验，加入候补名单',
        finalUrl: 'https://example.cn/beta',
      }),
    },
    now: '2026-07-24T00:00:00.000Z',
  });
  assert.equal(result.pageRenderMode, 'playwright');
  assert.equal(result.publishedAt, '2026-07-20');
  assert.deepEqual(result.accessSignals, ['gray_release', 'waitlist', 'invite_only']);
});

test('browser failure preserves static result and warning', async () => {
  const result = await fetchWithBrowserFallback('https://example.cn/beta', {
    staticFetch: async () => ({ title: '静态页', content: '正文内容' }),
    browser: { render: async () => { throw new Error('browser unavailable'); } },
    now: '2026-07-24T00:00:00.000Z',
  });
  assert.equal(result.pageRenderMode, 'static');
  assert.equal(result.content, '正文内容');
  assert.match(result.extractionWarnings?.[0] ?? '', /browser unavailable/);
});

test('adequate static content does not invoke browser', async () => {
  let rendered = false;
  const result = await fetchWithBrowserFallback('https://example.cn/page', {
    staticFetch: async () => ({ title: '标题', content: '这是足够长的正文。'.repeat(60) }),
    browser: { render: async () => { rendered = true; return { text: '不应调用' }; } },
    now: '2026-07-24T00:00:00.000Z',
  });
  assert.equal(result.pageRenderMode, 'static');
  assert.equal(rendered, false);
});
