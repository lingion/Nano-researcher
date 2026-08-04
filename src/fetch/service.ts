import type { FetchResponse } from '../agent/types.ts';
import type { FetchProvider } from './provider.ts';

export class FetchService implements FetchProvider {
  readonly name = 'fetch-service';

  constructor(private readonly providers: FetchProvider[]) {}

  async fetch(url: string, options: { signal?: AbortSignal } = {}): Promise<FetchResponse> {
    let lastError: FetchResponse | undefined;
    for (const provider of this.providers) {
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
      const response = await provider.fetch(url, options);
      if (response.outcome === 'success_with_content' && response.content.trim()) return response;
      lastError = response;
    }
    if (lastError) return lastError;
    return {
      outcome: 'transport_error', requestedUrl: url, finalUrl: url, title: '', content: '',
      provider: this.name, extractionWarnings: ['no_fetch_provider'], durationMs: 0, retryCount: 0,
      error: { code: 'NO_PROVIDER', message: 'No fetch provider was configured.' },
    };
  }
}
