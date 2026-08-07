import type { SearchResponse } from '../agent/types.ts';

export interface SearchProvider {
  readonly name: string;
  readonly capabilities?: readonly string[];
  readonly maxConcurrency?: number;
  search(query: string, options?: { signal?: AbortSignal; engineScope?: string[] }): Promise<SearchResponse>;
}

export interface SearchProviderDescriptor {
  name: string;
  capabilities: readonly string[];
  maxConcurrency?: number;
}

export function describeSearchProvider(provider: SearchProvider): SearchProviderDescriptor {
  return {
    name: provider.name,
    capabilities: provider.capabilities ?? ['general-web'],
    ...(provider.maxConcurrency ? { maxConcurrency: provider.maxConcurrency } : {}),
  };
}
