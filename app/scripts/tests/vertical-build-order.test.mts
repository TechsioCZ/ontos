import { readFileSync, readdirSync } from 'node:fs';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

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
    for (const target of Object.values(vertical.exports ?? {})) {
      expect(`${vertical.name} ${target}`).toMatch(/ \.\/(?:shared|src|locales)\//u);
    }
  }
});
