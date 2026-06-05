import type { SearchDiscoveryRecord } from '../search-fusion/types.js';
import type { FetchedPageRecord } from '../fetch-fusion/types.js';

export interface SearchTool {
  search(query: string): Promise<SearchDiscoveryRecord[]>;
}

export interface FetchTool {
  fetch(url: string): Promise<FetchedPageRecord>;
}
