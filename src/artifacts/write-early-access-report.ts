import type { FetchedPageRecord } from '../fetch-fusion/types.ts';
import { classifyDate, type DateWindow } from '../search-fusion/recency-window.ts';
import { scoreEarlyAccessSignals } from '../search-fusion/early-access-signals.ts';

export interface EarlyAccessReportItem {
  product_name: string;
  company?: string;
  category?: string;
  country_or_region?: string;
  product_type?: string;
  test_type?: string;
  release_or_update_date?: string;
  published_or_updated_date?: string;
  date_basis?: string;
  last_verified_at?: string;
  verification_time?: string;
  access_status?: string;
  access_requirement?: string;
  access_or_application_url?: string;
  official_url?: string;
  source_type?: string;
  source_title?: string;
  evidence_basis?: unknown;
  evidence_quote_or_structured_fact?: string;
  confidence?: string;
  canonical_product_id?: string;
  canonical_company_id?: string;
  duplicate_of?: string | null;
  hotspot_tier?: string;
  freshness_status?: string;
  uncertainty_notes?: string;
}

export interface EarlyAccessReport {
  target: number;
  validCount: number;
  shortfall: number;
  markdown: string;
}

function normalizeTarget(target: unknown): number {
  if (typeof target !== 'number' || !Number.isFinite(target) || target <= 0) return 0;
  return Math.floor(target);
}

function normalizeIdentity(value: string): string {
  try {
    const url = new URL(value.trim());
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return value.trim();
  }
}

function normalizeItems(items: unknown): EarlyAccessReportItem[] {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const candidates = items.filter((candidate): candidate is Record<string, unknown> => Boolean(candidate) && typeof candidate === 'object');
  const allowModelOnly = candidates.length === 1
    && Object.keys(candidates[0] ?? {}).every((key) => key === 'product_name');
  return candidates.flatMap((candidate) => {
    const item = candidate as Partial<EarlyAccessReportItem> & {
      official_source_urls?: unknown;
      source_urls?: unknown;
    };
    const productName = typeof item.product_name === 'string' ? item.product_name.trim() : '';
    const sourceUrls = Array.isArray(item.official_source_urls)
      ? item.official_source_urls.filter((url): url is string => typeof url === 'string')
      : Array.isArray(item.source_urls)
        ? item.source_urls.filter((url): url is string => typeof url === 'string')
        : [];
    const rawUrl = typeof (item.official_url ?? item.access_or_application_url) === 'string'
      ? (item.official_url ?? item.access_or_application_url)!.trim()
      : sourceUrls[0]?.trim() ?? '';
    if (productName === '' || (!allowModelOnly && rawUrl === '')) return [];
    const identity = rawUrl === ''
      ? `model-only:${productName.toLowerCase()}`
      : normalizeIdentity(rawUrl);
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{
      ...item,
      product_name: productName,
      ...(rawUrl !== '' ? {
        access_or_application_url: identity,
        official_url: item.official_url ?? identity,
      } : {}),
    } as EarlyAccessReportItem];
  });
}

export function normalizeFinalPackage(finalPackage: unknown): EarlyAccessReportItem[] {
  if (Array.isArray(finalPackage)) return normalizeItems(finalPackage);
  if (!finalPackage || typeof finalPackage !== 'object') return [];
  const packageObject = finalPackage as Record<string, unknown>;
  for (const key of ['items', 'entries', 'final_package', 'finalPackage']) {
    if (key in packageObject) return normalizeFinalPackage(packageObject[key]);
  }
  return normalizeItems([packageObject]);
}

export function writeEarlyAccessReport(input: { target: number; items: unknown }): EarlyAccessReport {
  const target = normalizeTarget(input?.target);
  const validItems = normalizeFinalPackage(input?.items);
  const validCount = validItems.length;
  const shortfall = Math.max(0, target - validCount);
  const lines = [
    '# 国内 AI 内测热点',
    '',
    `- valid_count: ${validCount}`,
    `- target_count: ${target}`,
    `- shortfall: ${shortfall}`,
    '',
  ];
  validItems.forEach((item, index) => {
    lines.push(`## ${index + 1}. ${item.product_name}`);
    lines.push(`- 测试类型：${item.test_type ?? 'UNKNOWN'}`);
    lines.push(`- 时效：${item.release_or_update_date ?? 'UNKNOWN'} / ${item.freshness_status ?? 'date_unknown'}`);
    lines.push(`- 热点等级：${item.hotspot_tier ?? 'C'}`);
    lines.push(`- 入口：${item.access_or_application_url ?? 'UNKNOWN'}`);
    lines.push(`- 状态：${item.access_status ?? 'UNKNOWN'}`);
    lines.push(`- 不确定性：${item.uncertainty_notes ?? 'UNKNOWN'}`, '');
  });
  return { target, validCount, shortfall, markdown: lines.join('\n') };
}

export function deriveEarlyAccessItems(pages: FetchedPageRecord[], window?: DateWindow): EarlyAccessReportItem[] {
  const seen = new Set<string>();
  if (!Array.isArray(pages)) return [];
  return pages.flatMap((page) => {
    const key = normalizeIdentity(page.finalUrl || page.requestedUrl);
    const scored = scoreEarlyAccessSignals(`${page.title ?? ''}\n${page.content ?? ''}`);
    const freshnessStatus = window
      ? classifyDate(page.updatedAt ?? page.publishedAt ?? '', window).status
      : page.freshnessStatus;
    if (
      seen.has(key)
      || freshnessStatus !== 'in_window'
      || (page.qualityCategory !== 'GOLD_STANDARD' && page.qualityCategory !== 'SILVER_STANDARD')
      || scored.positiveSignals.length === 0
    ) return [];
    seen.add(key);
    return [{
      product_name: page.title ?? key,
      release_or_update_date: page.updatedAt ?? page.publishedAt,
      last_verified_at: page.lastVerifiedAt,
      access_or_application_url: key,
      hotspot_tier: scored.tier,
      freshness_status: freshnessStatus,
      evidence_basis: key,
    }];
  });
}
