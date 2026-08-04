import type { SearchProvider, SearchProviderDescriptor } from './provider.ts';
import { describeSearchProvider } from './provider.ts';

/** Runtime registry for sources; the Agent does not need to know domain names. */
export class SearchProviderRegistry {
  private readonly providers = new Map<string, SearchProvider>();

  register(provider: SearchProvider): this {
    if (this.providers.has(provider.name)) throw new Error(`Search provider already registered: ${provider.name}`);
    this.providers.set(provider.name, provider);
    return this;
  }

  list(): SearchProvider[] {
    return [...this.providers.values()];
  }

  describe(): SearchProviderDescriptor[] {
    return this.list().map(describeSearchProvider);
  }
}
