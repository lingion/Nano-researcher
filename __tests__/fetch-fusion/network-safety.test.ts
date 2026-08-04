import assert from 'node:assert/strict';
import test from 'node:test';

import { assertSafeNetworkTarget, assertSafeResolvedNetworkTarget, safeFetchWithRedirects } from '../../src/fetch-fusion/network-safety.ts';

test('rejects reserved IPv4 and IPv6 targets', () => {
  for (const url of [
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://100.64.0.1/',
    'http://[::]/',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/',
  ]) {
    assert.throws(() => assertSafeNetworkTarget(url), /blocked unsafe network target/i, url);
  }
});

test('rejects public-looking hostnames when DNS resolves to a private address', async () => {
  await assert.rejects(
    () => assertSafeResolvedNetworkTarget('https://public-looking.example/path', async () => [{ address: '10.0.0.8', family: 4 }]),
    /blocked unsafe network target/i,
  );
  await assert.doesNotReject(
    () => assertSafeResolvedNetworkTarget('https://public.example/path', async () => [{ address: '93.184.216.34', family: 4 }]),
  );
});

test('validates every redirect before sending the next request', async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    requested.push(String(input));
    return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  };
  await assert.rejects(
    () => safeFetchWithRedirects('https://public.example/start', {}, {
      fetchImpl,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    }),
    /blocked unsafe network target/i,
  );
  assert.deepEqual(requested, ['https://public.example/start']);
});

test('follows a bounded public redirect chain manually', async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    requested.push(String(input));
    return requested.length === 1
      ? new Response('', { status: 302, headers: { location: '/final' } })
      : new Response('ok', { status: 200 });
  };
  const response = await safeFetchWithRedirects('https://public.example/start', {}, {
    fetchImpl,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  assert.equal(await response.text(), 'ok');
  assert.deepEqual(requested, ['https://public.example/start', 'https://public.example/final']);
});

test('accepts ordinary public URL targets', () => {
  assert.equal(assertSafeNetworkTarget('https://example.com/path').hostname, 'example.com');
});
