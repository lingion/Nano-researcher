import type { FetchResponse } from '../agent/types.ts';

export interface FetchProvider {
  readonly name: string;
  fetch(url: string, options?: { signal?: AbortSignal }): Promise<FetchResponse>;
  close?(): Promise<void>;
}
