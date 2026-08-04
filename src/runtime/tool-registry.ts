import type { SearchDiscoveryRecord } from '../search-fusion/types.js';
import type { FetchedPageRecord } from '../fetch-fusion/types.js';

export interface SearchTool {
  search(query: string, signal?: AbortSignal): Promise<SearchDiscoveryRecord[]>;
}

export interface FetchTool {
  fetch(url: string, signal?: AbortSignal): Promise<FetchedPageRecord>;
}
