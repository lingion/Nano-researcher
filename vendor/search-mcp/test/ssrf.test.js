import assert from 'node:assert/strict';
import test from 'node:test';

import { callTool } from '../src/index.js';
import { handleJsonRpc } from '../src/mcp/protocol.js';

test('JSON-RPC internal errors do not return credential-bearing error details', async () => {
  const marker = 'SYNTHETIC_BEARER_TOKEN';
  const response = await handleJsonRpc(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} },
    {},
    { callTool: async () => { throw new Error(`upstream authorization=${marker}`); } },
  );

  assert.equal(response.error.message, 'internal error');
  assert.doesNotMatch(JSON.stringify(response), new RegExp(marker));
});
test('provider failure results do not expose credential-bearing error details', async () => {
  const originalFetch = globalThis.fetch;
  const marker = 'SYNTHETIC_HEADER_SECRET';
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error(`request failed authorization=${marker}`);
  };
  try {
    const result = await callTool({ name: 'search_bing', arguments: { query: 'synthetic query' } });
    assert.ok(calls > 0);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(marker));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test('fetch attempt failures do not expose credential-bearing error details', async () => {
  const originalFetch = globalThis.fetch;
  const marker = 'SYNTHETIC_FETCH_SECRET';
  globalThis.fetch = async () => {
    throw new Error(`request failed authorization=${marker}`);
  };
  try {
    const result = await callTool({ name: 'search_duckduckgo', arguments: { query: 'synthetic query' } });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(marker));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetch_url errors do not expose credential-bearing error details', async () => {
  const originalFetch = globalThis.fetch;
  const marker = 'SYNTHETIC_PAGE_FETCH_SECRET';
  globalThis.fetch = async () => {
    throw new Error(`request failed authorization=${marker}`);
  };
  try {
    const result = await callTool({ name: 'fetch_url', arguments: { url: 'https://public.example/page' } });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(marker));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetch_url rejects a public-to-private redirect before returning content', async () => {
  const originalFetch = globalThis.fetch;
  const response = new Response('<html><body>internal</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
  Object.defineProperty(response, 'url', { value: 'http://127.0.0.1:8080/internal' });
  globalThis.fetch = async () => response;
  try {
    await assert.rejects(
      () => callTool({ name: 'fetch_url', arguments: { url: 'https://public.example/start' } }),
      /blocked unsafe network target/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetch_url rejects unsafe initial targets without making a request', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('unexpected');
  };
  try {
    await assert.rejects(
      () => callTool({ name: 'fetch_url', arguments: { url: 'http://169.254.169.254/latest/meta-data' } }),
      /blocked unsafe network target/i,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('vertical provider failures do not expose raw error details', async () => {
  const originalFetch = globalThis.fetch;
  const marker = 'SYNTHETIC_VERTICAL_SECRET';
  globalThis.fetch = async () => {
    throw new Error(`request failed authorization=${marker}`);
  };
  try {
    for (const name of ['search_arxiv', 'search_pubmed', 'search_npm', 'search_bbc']) {
      const result = await callTool({ name, arguments: { query: 'synthetic query' } });
      assert.doesNotMatch(JSON.stringify(result), new RegExp(marker), name);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('provider config output does not expose URL credentials or query secrets', async () => {
  const marker = 'SYNTHETIC_BASE_URL_SECRET';
  const result = await callTool({
    name: 'provider_set_config',
    arguments: {
      provider: 'brave',
      base_url: `https://user:password@example.test/search?api_key=${marker}#fragment`,
    },
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(marker));
  assert.doesNotMatch(JSON.stringify(result), /user:password/);
  assert.equal(result.structuredContent?.config?.baseUrl, 'https://example.test/search');
});


test('additional provider failures do not expose raw error details', async () => {
  const originalFetch = globalThis.fetch;
  const marker = 'SYNTHETIC_ADDITIONAL_SECRET';
  globalThis.fetch = async () => {
    throw new Error(`request failed authorization=${marker}`);
  };
  try {
    for (const name of ['search_hackernews', 'search_stackoverflow', 'search_mastodon', 'search_peertube', 'search_bing_news', 'search_sec_edgar', 'search_lemmy', 'search_crates']) {
      const result = await callTool({ name, arguments: { query: 'synthetic query' } });
      assert.doesNotMatch(JSON.stringify(result), new RegExp(marker), name);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
