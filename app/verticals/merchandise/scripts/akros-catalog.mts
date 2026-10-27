import { fileURLToPath } from 'node:url';
import { NodeFileSystem } from '@effect/platform-node';
import { Effect, FileSystem, Schema } from 'effect';
import { demoId } from '../../../scripts/demo/fixture-ids.mts';
import { AkrosCatalogSchema, CategorySchema, buildAkrosEncodedFrom } from './akros-baseline.ts';
import type { AkrosSource } from './akros-baseline.ts';

const readSource = Effect.gen(function* readSource() {
  const fs = yield* FileSystem.FileSystem;
  const catalogJson = yield* fs.readFileString(
    fileURLToPath(
      new URL('../../../akros-storefront/src/catalog-import/generated/catalog.generated.json', import.meta.url),
    ),
    'utf-8',
  );
  const categoriesJson = yield* fs.readFileString(
    fileURLToPath(
      new URL('../../../akros-storefront/src/catalog-import/generated/categories.generated.json', import.meta.url),
    ),
    'utf-8',
  );
  const catalog = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AkrosCatalogSchema))(catalogJson);
  const { categories } = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ categories: Schema.Array(CategorySchema) })),
  )(categoriesJson);
  return { catalog, categories } satisfies AkrosSource;
});
const source = await Effect.runPromise(readSource.pipe(Effect.provide(NodeFileSystem.layer)));
// Import every source group; never silently curate the live owner catalog.
export const akrosSourceProducts = source.catalog.products;
export const buildAkrosEncoded = () => buildAkrosEncodedFrom(source, demoId);
