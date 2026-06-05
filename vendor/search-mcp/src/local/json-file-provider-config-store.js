import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeProviderConfig, normalizeProviderName, cloneConfig, validateProviderConfigSnapshot } from './provider-config-store.js';

export function createJsonFileProviderConfigStore(filePath, initialConfig = {}) {
  const resolvedPath = resolveStorePath(filePath);
  let snapshot = loadSnapshot(resolvedPath, initialConfig);

  return {
    get(name) {
      return cloneConfig(snapshot[normalizeProviderName(name)] ?? null);
    },

    set(name, value) {
      const key = normalizeProviderName(name);
      const next = normalizeProviderConfig(value);
      snapshot = {
        ...snapshot,
        [key]: next
      };
      persistSnapshot(resolvedPath, snapshot);
      return cloneConfig(next);
    },

    list() {
      return Object.fromEntries(
        Object.entries(snapshot).map(([name, value]) => [name, cloneConfig(value)])
      );
    }
  };
}

function resolveStorePath(filePath) {
  if (filePath instanceof URL) {
    return fileURLToPath(filePath);
  }
  return path.resolve(String(filePath || 'provider-config.json'));
}

function loadSnapshot(filePath, initialConfig) {
  if (!fs.existsSync(filePath)) {
    return normalizeSnapshot(initialConfig);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  try {
    validateProviderConfigSnapshot(parsed);
  } catch (error) {
    throw new Error(`Invalid provider config store file at ${filePath}: ${error.message}`);
  }
  return normalizeSnapshot(parsed);
}

function normalizeSnapshot(input) {
  const source = input && typeof input === 'object' ? input : {};
  return Object.fromEntries(
    Object.entries(source).map(([name, value]) => [normalizeProviderName(name), normalizeProviderConfig(value)])
  );
}

function persistSnapshot(filePath, snapshot) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  const serialized = JSON.stringify(snapshot, null, 2);
  fs.writeFileSync(tempPath, serialized, 'utf8');
  fs.renameSync(tempPath, filePath);
}
