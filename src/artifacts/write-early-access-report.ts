import type { FetchedPageRecord } from '../fetch-fusion/types.ts';
import { scoreEarlyAccessSignals } from '../search-fusion/early-access-signals.ts';

export interface EarlyAccessReportItem {
  product_name: string;
  product_type?: string;
  test_type?: string;
  release_or_update_date?: string;
  last_verified_at?: string;
  access_status?: string;
  access_or_application_url?: string;
  evidence_basis?: unknown;
  hotspot_tier?: string;
  freshness_status?: string;
  uncertainty_notes?: string;
}

export function writeEarlyAccessReport(input: { target: number; items: EarlyAccessReportItem[] }): { target: number; validCount: number; shortfall: number; markdown: string } {
  const validCount = input.items.length;
  const shortfall = Math.max(0, input.target - validCount);
  const lines = [`# 国内 AI 内测热点`, ``, `- valid_count: ${validCount}`, `- target_count: ${input.target}`, `- shortfall: ${shortfall}`, ``];
  input.items.forEach((item, index) => {
    lines.push(`## ${index + 1}. ${item.product_name}`);
    lines.push(`- 测试类型：${item.test_type ?? 'UNKNOWN'}`);
    lines.push(`- 时效：${item.release_or_update_date ?? 'UNKNOWN'} / ${item.freshness_status ?? 'date_unknown'}`);
    lines.push(`- 热点等级：${item.hotspot_tier ?? 'C'}`);
    lines.push(`- 入口：${item.access_or_application_url ?? 'UNKNOWN'}`);
    lines.push(`- 状态：${item.access_status ?? 'UNKNOWN'}`);
    lines.push(`- 不确定性：${item.uncertainty_notes ?? 'UNKNOWN'}`, ``);
  });
  return { target: input.target, validCount, shortfall, markdown: lines.join('\n') };
}

export function deriveEarlyAccessItems(pages: FetchedPageRecord[]): EarlyAccessReportItem[] {
  const seen = new Set<string>();
  return pages.flatMap((page) => {
    const key = page.finalUrl ?? page.requestedUrl;
    const scored = scoreEarlyAccessSignals(`${page.title ?? ''}\n${page.content ?? ''}`);
    if (seen.has(key) || page.freshnessStatus !== 'in_window' || (page.qualityCategory !== 'GOLD_STANDARD' && page.qualityCategory !== 'SILVER_STANDARD') || scored.positiveSignals.length === 0) return [];
    seen.add(key);
    return [{ product_name: page.title ?? key, release_or_update_date: page.updatedAt ?? page.publishedAt, last_verified_at: page.lastVerifiedAt, access_or_application_url: key, hotspot_tier: scored.tier, freshness_status: page.freshnessStatus, evidence_basis: key }];
  });
}
