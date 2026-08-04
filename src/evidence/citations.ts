import type { FetchResponse } from '../agent/types.ts';

export function canonicalEvidenceUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key);
    }
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return undefined;
  }
}

export function matchedFetchedEvidenceUrls(evidenceUrls: string[], pages: FetchResponse[]): string[] {
  const fetched = new Map<string, string>();
  for (const page of pages) {
    if (page.outcome !== 'success_with_content') continue;
    for (const raw of [page.requestedUrl, page.finalUrl]) {
      const canonical = canonicalEvidenceUrl(raw);
      if (canonical) fetched.set(canonical, page.finalUrl || page.requestedUrl);
    }
  }
  const matched = new Map<string, string>();
  for (const raw of evidenceUrls) {
    const canonical = canonicalEvidenceUrl(raw);
    const fetchedUrl = canonical ? fetched.get(canonical) : undefined;
    if (canonical && fetchedUrl) matched.set(canonical, fetchedUrl);
  }
  return [...matched.values()];
}
