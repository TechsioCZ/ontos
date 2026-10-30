import { readFileSync, readdirSync } from 'node:fs';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

const PRIVACY_PACKAGE = '@app/privacy';
const LEGACY_COMPLETION_EXPORT = './admin/legacy-completion';
const LEGACY_COMPLETION_SOURCE = './scripts/legacy-completion-publication.ts';
const TESTING_FIXTURE_EXPORT = './testing/fixture';
const TESTING_FIXTURE_SOURCE = './tests/support/fixture.ts';

const appRoot = new URL('../../', import.meta.url);
const ManifestSchema = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  exports: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  name: Schema.String,
  scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const readManifest = (directory: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(ManifestSchema))(
    readFileSync(new URL(`${directory}/package.json`, appRoot), 'utf-8'),
  );

const isSourceExport = (key: string, target: string, owner?: string) => {
  const sourcePath = /^\.\/[\w.*-]+(?:\/[\w.*-]+)*$/u;
  for (const path of [key, target]) {
    if (
      !sourcePath.test(path) ||
      path
        .slice(2)
        .split('/')
        .some((part) => part === '.' || part === '..')
    ) {
      return false;
    }
  }
  if (
    /(?:^|\/)(?:dist|build|\.output|private|implementations?)(?:\/|$)/u.test(target) ||
    /(?:^|[/.])(?:registration|implementation)(?:[./-]|$)/u.test(target)
  ) {
    return false;
  }
  return (
    /^\.\/(?:shared|src|locales)\//u.test(target) ||
    (key.startsWith('./testing/') && /^\.\/tests\/(?:support|fixtures)\/.+\.(?:[cm]?ts|tsx)$/u.test(target)) ||
    (owner === PRIVACY_PACKAGE && key === LEGACY_COMPLETION_EXPORT && target === LEGACY_COMPLETION_SOURCE)
  );
};

const verticals = readdirSync(new URL('verticals/', appRoot), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => readManifest(`verticals/${entry.name}`));

it('builds verticals unsorted, so no vertical waits for another vertical build', () => {
  const { scripts = {} } = readManifest('.');

  for (const script of ['build', 'cloudflare:build']) {
    expect(scripts[script]).toContain(`pnpm -r --no-sort --filter "./verticals/*" run ${script} &&`);
  }
});

it('lets a vertical import another vertical only through source exports, never through build output', () => {
  const importedVerticals = verticals.filter((vertical) =>
    verticals.some((consumer) => Object.keys(consumer.dependencies ?? {}).includes(vertical.name)),
  );

  expect(importedVerticals.length).toBeGreaterThan(0);
  for (const vertical of importedVerticals) {
    expect(Object.values(vertical.exports ?? {}).length).toBeGreaterThan(0);
    for (const [key, target] of Object.entries(vertical.exports ?? {})) {
      expect(isSourceExport(key, target, vertical.name), `${vertical.name} ${key} -> ${target}`).toBe(true);
    }
  }
});

it('allows only published testing source support alongside ordinary source exports', () => {
  for (const [key, target] of [
    ['./api', './shared/api.ts'],
    ['./api/client', './src/api/client.ts'],
    ['./locales/cs', './locales/cs/messages.json'],
    [TESTING_FIXTURE_EXPORT, TESTING_FIXTURE_SOURCE],
    ['./testing/nested/fixture', './tests/support/nested/fixture.mts'],
    [TESTING_FIXTURE_EXPORT, './tests/fixtures/fixture.ts'],
    ['./testing/*', './tests/support/*.ts'],
  ] as const) {
    expect(isSourceExport(key, target), `${key} -> ${target}`).toBe(true);
  }
  for (const [key, target] of [
    ['./api', './dist/api.js'],
    ['./api', './src/dist/api.ts'],
    ['./api', './build/api.js'],
    ['./api', './.output/api.js'],
    ['./api', './vertical.registration.ts'],
    ['./api', './src/vertical.registration.ts'],
    ['./api', './src/registration/action.ts'],
    ['./api', './src/implementation/action.ts'],
    ['./api', './src/private/action.ts'],
    [TESTING_FIXTURE_EXPORT, './tests/support/implementation/action.ts'],
    [TESTING_FIXTURE_EXPORT, './tests/support/dist/fixture.ts'],
    [TESTING_FIXTURE_EXPORT, './tests/support/fixture.js'],
    [TESTING_FIXTURE_EXPORT, './tests/support/../private/fixture.ts'],
    ['./testing/../fixture', TESTING_FIXTURE_SOURCE],
    [TESTING_FIXTURE_EXPORT, './tests/support/./fixture.ts'],
    [TESTING_FIXTURE_EXPORT, './tests/support/fixture.ts/../../private.ts'],
    [TESTING_FIXTURE_EXPORT, './tests/support/%2e%2e/private.ts'],
    ['./api', './shared/../vertical.registration.ts'],
    ['./api', './shared/../../other/shared/api.ts'],
    ['./api', TESTING_FIXTURE_SOURCE],
    ['./testing', TESTING_FIXTURE_SOURCE],
    ['./testing-tools/fixture', TESTING_FIXTURE_SOURCE],
  ] as const) {
    expect(isSourceExport(key, target), `${key} -> ${target}`).toBe(false);
  }
});

it('permits only the published Privacy administrative completion source', () => {
  expect(isSourceExport(LEGACY_COMPLETION_EXPORT, LEGACY_COMPLETION_SOURCE, PRIVACY_PACKAGE)).toBe(true);
  expect(isSourceExport(LEGACY_COMPLETION_EXPORT, LEGACY_COMPLETION_SOURCE, '@app/catalog')).toBe(false);
  expect(isSourceExport('./admin/other', LEGACY_COMPLETION_SOURCE, PRIVACY_PACKAGE)).toBe(false);
  expect(isSourceExport(LEGACY_COMPLETION_EXPORT, './scripts/other.ts', PRIVACY_PACKAGE)).toBe(false);
});
