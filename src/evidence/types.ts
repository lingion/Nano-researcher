import type { FetchResponse, SearchResult } from '../agent/types.ts';
import type { RunEvent } from '../app/run-manager.ts';

export interface Citation {
  url: string;
  title: string;
  sourceType: 'search' | 'fetch';
  searchResult?: SearchResult;
  fetchedPage?: Pick<FetchResponse, 'requestedUrl' | 'finalUrl' | 'title' | 'content'>;
}

export interface EvidenceStore {
  flush?(): Promise<void>;
  saveRunEvent?(event: RunEvent): Promise<void>;
  saveSearchResults?(results: SearchResult[]): Promise<void>;
  saveFetchedPage?(page: FetchResponse): Promise<void>;
  saveAgentResult?(result: unknown): Promise<void>;
}
