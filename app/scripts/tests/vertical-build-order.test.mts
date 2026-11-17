import { readFileSync, readdirSync } from 'node:fs';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

const PRIVACY_PACKAGE = '@app/privacy';
const LEGACY_COMPLETION_EXPORT = './admin/legacy-completion';
const LEGACY_COMPLETION_SOURCE = './scripts/legacy-completion-publication.ts';

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

  expect(scripts.build).toContain('pnpm -r --no-sort --filter "./verticals/*" run build &&');
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
