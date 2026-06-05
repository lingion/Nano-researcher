import {
  assessSearchResponseQuality,
  buildPolicySearchRoutingContext,
} from './auto-router.ts';
import type {
  KerryQualityStatus,
  SearchDiscoveryRecord,
} from './types.ts';

export interface AlignedSearchInput {
  query: string;
  currentRound: number;
  rawFoundCount: number;
  rawResults: SearchDiscoveryRecord[];
  metricsOverrides?: {
    fallback_used?: boolean;
    filtered_count?: number;
    merged_count?: number;
    deduped_count?: number;
  };
}

export interface CloudflareAlignedSearchResponse {
  task_context: {
    target_query: string;
    current_attempt_round: number;
    category_bundle_routed: 'policy' | 'general';
    targeted_official_domains: string[];
  };
  metrics: {
    total_raw_found: number;
    fallback_used: boolean;
    filtered_count: number;
    merged_count: number;
    deduped_count: number;
  };
  quality_state: {
    status: 'green' | 'yellow' | 'blocked' | 'empty' | 'red' | 'junk' | 'intent_mismatch';
    reason: string;
  };
  results: SearchDiscoveryRecord[];
}

export function mapCloudflareStatusToKerryStatus(cfStatus: CloudflareAlignedSearchResponse['quality_state']['status']): {
  status: KerryQualityStatus;
  reason: string;
} {
  switch (cfStatus) {
    case 'green':
    case 'yellow':
      return {
        status: 'usable_results',
        reason: 'Search result quality verified.',
      };
    case 'blocked':
      return {
        status: 'blocked_by_waf',
        reason: 'WAF administrative barrier detected.',
      };
    case 'empty':
    case 'red':
      return {
        status: 'empty',
        reason: 'Zero results returned from radar search.',
      };
    case 'intent_mismatch':
      return {
        status: 'intent_mismatch',
        reason: 'Commercial noise or intent mismatch detected.',
      };
    case 'junk':
      return {
        status: 'junk_heavy',
        reason: 'Commercial noise or intent mismatch detected.',
      };
  }
}

export function buildCloudflareAlignedSearchResponse(input: AlignedSearchInput): CloudflareAlignedSearchResponse {
  const routing = buildPolicySearchRoutingContext(input.query);
  const quality = assessSearchResponseQuality(input.query, input.rawResults);
  const mappedKerryState = mapCloudflareStatusToKerryStatus(quality.status);

  return {
    task_context: {
      target_query: input.query,
      current_attempt_round: input.currentRound,
      category_bundle_routed: routing.category_bundle_routed,
      targeted_official_domains: routing.targeted_official_domains,
    },
    metrics: {
      total_raw_found: input.rawFoundCount,
      fallback_used: input.metricsOverrides?.fallback_used ?? false,
      filtered_count: input.metricsOverrides?.filtered_count ?? 0,
      merged_count: input.metricsOverrides?.merged_count ?? input.rawResults.length,
      deduped_count: input.metricsOverrides?.deduped_count ?? 0,
    },
    quality_state: {
      status: quality.status,
      reason: quality.reason,
    },
    results: input.rawResults.map((result) => ({
      ...result,
      kerry_quality_status: mappedKerryState.status,
      kerry_quality_reason: mappedKerryState.reason,
    })),
  };
}
