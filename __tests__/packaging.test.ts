import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const projectRoot = new URL('..', import.meta.url);

test('package delivery includes pnpm-lock.yaml at the project root', () => {
  assert.equal(existsSync(new URL('../pnpm-lock.yaml', import.meta.url)), true);
});

test('package dependencies use explicit semver ranges', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  for (const [sectionName, dependencies] of Object.entries({
    dependencies: packageJson.dependencies ?? {},
    devDependencies: packageJson.devDependencies ?? {},
  })) {
    for (const [name, version] of Object.entries(dependencies)) {
      assert.match(
        version,
        /^[~^]\d+\.\d+\.\d+/,
        `${sectionName}.${name} should use a ^ or ~ semver range`,
      );
    }
  }
});
