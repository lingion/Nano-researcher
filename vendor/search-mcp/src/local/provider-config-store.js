export function createProviderConfigStore(initialConfig = {}) {
  const configs = new Map();

  for (const [name, value] of Object.entries(initialConfig)) {
    configs.set(normalizeProviderName(name), normalizeProviderConfig(value));
  }

  return {
    get(name) {
      return cloneConfig(configs.get(normalizeProviderName(name)) ?? null);
    },

    set(name, value) {
      const key = normalizeProviderName(name);
      const next = normalizeProviderConfig(value);
      configs.set(key, next);
      return cloneConfig(next);
    },

    list() {
      return Object.fromEntries(
        Array.from(configs.entries()).map(([name, value]) => [name, cloneConfig(value)])
      );
    }
  };
}

export function normalizeProviderName(name) {
  return String(name || '').trim().toLowerCase();
}

export function normalizeProviderConfig(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    apiKey: String(input.apiKey ?? input.api_key ?? ''),
    enabled: input.enabled !== false,
    baseUrl: String(input.baseUrl ?? input.base_url ?? '')
  };
}

export function validateProviderConfigSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('snapshot must be an object');
  }

  for (const config of Object.values(value)) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('each provider config must be an object');
    }
  }
}

export function cloneConfig(value) {
  if (value === null) {
    return null;
  }

  return { ...value };
}
