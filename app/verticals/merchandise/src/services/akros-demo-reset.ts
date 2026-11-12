import { Base64 } from 'effect/encoding';
// In-app reset of the AKROS demo company to the same predictable baseline `demo:seed:akros --reset` writes. The
// baseline's generated TypeScript chunks ship inside the server bundle, so the reset needs no filesystem and runs
// the same on Node and Cloudflare Workers; parts are decoded and inserted one at a time to keep memory bounded. The
// parts are loaded only when a reset runs, so they cost nothing on a cold isolate's first request.
import { Effect, Option, Result, Schema } from 'effect';
import type { Types } from 'effect';
import { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { MerchandisePersistenceUnavailable } from '../../shared/errors/merchandise-persistence-unavailable.ts';
import { loadAkrosBaselineParts } from './akros-baseline.generated.ts';
import { isMediaImageReference, mediaAssetIdOf } from '../../shared/domain/product-images.ts';
import type { CatalogCategory, Product } from '../../shared/domain/merchandise-model.ts';
import { categories } from '../database/schema.ts';
import {
  decodeCategoryRow,
  deleteScope,
  insertSnapshotPart,
  pricedRatesOf,
  loadProducts,
  query,
  whereScope,
  writeSnapshotHead,
} from './merchandise-store.ts';
import type { MerchandiseDb, StoreScope } from './merchandise-store.ts';

const baselineUnavailable = (reason: string, cause?: unknown) =>
  Object.defineProperty(
    new MerchandisePersistenceUnavailable({ code: 'merchandise_persistence_unavailable', reason }),
    'cause',
    { enumerable: false, value: cause },
  );

const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(MerchandiseStateSchema));

/** One baseline part: base64 → gzip → JSON → decoded state (Web streams: Node and Workers alike). */
export const decodeAkrosBaselinePart = Effect.fn('Merchandise.decodeAkrosBaselinePart')(function* decodePart(
  part: string,
) {
  const bytes = yield* Result.match(Base64.decode(part), {
    onFailure: (cause) => Effect.fail(baselineUnavailable('AKROS baseline part is not base64', cause)),
    onSuccess: Effect.succeed,
  });
  const response = yield* Effect.try({
    catch: (cause) => baselineUnavailable('AKROS baseline part does not decompress', cause),
    try: () => new Response(new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'))),
  });
  const json = yield* Effect.tryPromise({
    catch: (cause) => baselineUnavailable('AKROS baseline part does not decompress', cause),
    try: response.text.bind(response),
  }).pipe(
    Effect.timeoutOrElse({
      duration: '30 seconds',
      orElse: () => Effect.fail(baselineUnavailable('AKROS baseline part decompression timed out')),
    }),
  );
  return yield* decodeState(json).pipe(
    Effect.mapError((cause) => baselineUnavailable('AKROS baseline does not match the model', cause)),
  );
}) satisfies (part: string) => Effect.Effect<MerchandiseState, MerchandisePersistenceUnavailable>;

/** The company's photos already stored in Core Media, by product and category, read before the row reset. */
export interface LinkedPhotos {
  readonly categories: ReadonlyMap<string, string>;
  readonly products: ReadonlyMap<string, Product>;
}

/**
 * Core Media links survive the row reset (it deletes merchandise rows only), so the baseline keeps the photos the
 * company already uploaded: a product keeps its uploaded gallery (main = first) and the variant photos among it, a
 * category keeps a storefront photo address of such a kept product photo. Everything else is the baseline's.
 */
export const linkedPhotosOf = (
  products: readonly Product[],
  storeCategories: readonly CatalogCategory[],
): LinkedPhotos => {
  const uploaded = products.filter(({ images }) => (images ?? []).some(isMediaImageReference));
  const paths = new Set(
    uploaded.flatMap(({ id, images }) =>
      (images ?? []).flatMap((image) =>
        Option.toArray(mediaAssetIdOf(image)).map((assetId) => `/obrazky/${encodeURIComponent(id)}/${assetId}`),
      ),
    ),
  );
  return {
    categories: new Map(
      storeCategories.flatMap(({ id, imageSrc }) => (paths.has(imageSrc) ? [[id, imageSrc] as const] : [])),
    ),
    products: new Map(uploaded.map((product) => [product.id, product] as const)),
  };
};
const withLinkedPhotos = (product: Product, previous: Product | undefined): Product => {
  if (previous === undefined) {
    return product;
  }
  const images = (previous.images ?? []).filter(isMediaImageReference);
  const variantPhotos = new Map((previous.variants ?? []).map((variant) => [variant.id, variant.imageSrc] as const));
  const kept: Types.Mutable<Product> = { ...product, images, imageSrc: images[0] ?? '' };
  if (product.variants !== undefined) {
    kept.variants = product.variants.map((variant) => {
      const imageSrc = variantPhotos.get(variant.id);
      return imageSrc !== undefined && images.includes(imageSrc) ? { ...variant, imageSrc } : variant;
    });
  }
  return kept;
};
export const keepLinkedPhotos = (part: MerchandiseState, linked: LinkedPhotos): MerchandiseState => {
  const kept: Types.Mutable<MerchandiseState> = {
    ...part,
    products: part.products.map((product) => withLinkedPhotos(product, linked.products.get(product.id))),
  };
  if (part.categories !== undefined) {
    kept.categories = part.categories.map((category) => {
      const imageSrc = linked.categories.get(category.id);
      return imageSrc === undefined ? category : { ...category, imageSrc };
    });
  }
  return kept;
};

/**
 * Replaces the company's merchandise with the demo baseline: full catalog, initial stock receipts and the six
 * sample orders, keeping the photos already uploaded to Core Media (see keepLinkedPhotos). Runs inside the
 * caller's transaction; returns the new revision.
 */
export const resetToAkrosBaseline = Effect.fn('Merchandise.resetToAkrosBaseline')(function* resetToAkrosBaseline(
  db: MerchandiseDb,
  scope: StoreScope,
) {
  const [first, ...rest] = loadAkrosBaselineParts();
  if (first === undefined) {
    return yield* baselineUnavailable('AKROS baseline is empty');
  }
  const [products, categoryRows] = yield* Effect.all(
    [loadProducts(db, scope), query(db.select().from(categories).where(whereScope(categories, scope)))],
    { concurrency: 1 },
  );
  const linked = linkedPhotosOf(
    products.map((entry) => entry.product),
    yield* Effect.forEach(categoryRows, decodeCategoryRow, { concurrency: 1 }),
  );
  const head = keepLinkedPhotos(yield* decodeAkrosBaselinePart(first), linked);
  // The company keeps its synced VAT rates; the baseline is priced at them.
  const rates = yield* pricedRatesOf(db, scope);
  yield* deleteScope(db, scope);
  yield* insertSnapshotPart(db, scope, head, rates);
  yield* Effect.forEach(
    rest,
    (part) =>
      decodeAkrosBaselinePart(part).pipe(
        Effect.flatMap((state) => insertSnapshotPart(db, scope, keepLinkedPhotos(state, linked), rates)),
      ),
    { concurrency: 1, discard: true },
  );
  return yield* writeSnapshotHead(db, scope, head);
});
