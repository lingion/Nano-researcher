import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

const UNSAFE_NETWORK_TARGET = 'blocked unsafe network target';

function ipv4Parts(hostname: string): number[] | undefined {
  if (isIP(hostname) !== 4) return undefined;
  const parts = hostname.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : undefined;
}

function isUnsafeIpv4(hostname: string): boolean {
  const parts = ipv4Parts(hostname);
  if (!parts) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51)
    || (a === 203 && b === 0);
}

function isUnsafeIpv6(hostname: string): boolean {
  if (isIP(hostname) !== 6) return false;
  const normalized = hostname.toLowerCase();
  const dottedMappedIpv4 = normalized.match(/^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dottedMappedIpv4 && isUnsafeIpv4(dottedMappedIpv4)) return true;
  const hexadecimalMappedIpv4 = normalized.match(/^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexadecimalMappedIpv4) {
    const high = Number.parseInt(hexadecimalMappedIpv4[1], 16);
    const low = Number.parseInt(hexadecimalMappedIpv4[2], 16);
    if (isUnsafeIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)) return true;
  }
  return normalized === '::1'
    || normalized === '::'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
    || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8:');
}

function assertSafeHostname(hostname: string): void {
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || hostname.endsWith('.internal') || hostname.endsWith('.home.arpa')
    || isUnsafeIpv4(hostname) || isUnsafeIpv6(hostname)) {
    throw new Error(`${UNSAFE_NETWORK_TARGET}: ${hostname}`);
  }
}

export function assertSafeNetworkTarget(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${UNSAFE_NETWORK_TARGET}: invalid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${UNSAFE_NETWORK_TARGET}: only http(s) URLs are allowed`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  assertSafeHostname(hostname);
  return parsed;
}

export type NetworkLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: NetworkLookup = async (hostname) => await dnsLookup(hostname, { all: true, verbatim: true });

export async function assertSafeResolvedNetworkTarget(rawUrl: string, lookup: NetworkLookup = defaultLookup): Promise<URL> {
  const parsed = assertSafeNetworkTarget(rawUrl);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(hostname)) return parsed;
  const addresses = await lookup(hostname);
  if (addresses.length === 0) throw new Error(`${UNSAFE_NETWORK_TARGET}: ${hostname} did not resolve`);
  for (const { address } of addresses) assertSafeHostname(address.replace(/^\[|\]$/g, '').toLowerCase());
  return parsed;
}

export async function safeFetchWithRedirects(
  rawUrl: string,
  init: RequestInit = {},
  options: { fetchImpl?: typeof fetch; lookup?: NetworkLookup; maxRedirects?: number } = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = Math.max(0, Math.min(10, Math.floor(options.maxRedirects ?? 5)));
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertSafeResolvedNetworkTarget(current, options.lookup ?? defaultLookup);
    const response = await fetchImpl(current, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    if (hop === maxRedirects) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('too many redirects');
    }
    current = new URL(location, current).toString();
    await response.body?.cancel().catch(() => undefined);
  }
  throw new Error('too many redirects');
}

export { UNSAFE_NETWORK_TARGET };
