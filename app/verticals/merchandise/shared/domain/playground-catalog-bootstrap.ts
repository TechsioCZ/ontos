import { Crypto, Effect, Order, Predicate, Result, Schema } from 'effect';
import {
  CatalogCategorySchema,
  ProductIdReferenceSchema,
  ProductSchema,
  VariantIdReferenceSchema,
} from './merchandise-model.ts';

/** Task fixture, not a general import API. Remove/generalize only after a separately reviewed main issue. */
export const PLAYGROUND_TENANT = 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9';
export const PLAYGROUND_COMPANY = 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7';
export const PLAYGROUND_SOURCE_FINGERPRINT = '11693967123223ac20a2f1a4cd2e2410cdd82516f62cec227849e919c4a7d8ac';
/** Binds the 110 batch digests, counts and homepage IDs, derived offline from the sealed source. */
export const PLAYGROUND_MANIFEST_DIGEST = '481ffcff756ee63ee60d645caa28357eee54e1b9395a0055d33504feaeb0b53c';
export const BOOTSTRAP_MAX_BYTES = 524_288;
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Count = Schema.Int.check(Schema.isBetween({ maximum: 100_000, minimum: 0 }));
export const BootstrapProductSchema = Schema.Struct({
  product: Schema.toEncoded(ProductSchema),
  stock: Schema.Array(
    Schema.Struct({
      quantity: Schema.Finite,
      variantId: Schema.optionalKey(Schema.toEncoded(VariantIdReferenceSchema)),
    }),
  ).check(Schema.isMaxLength(2000)),
});
export const BootstrapBatchSchema = Schema.Struct({
  categories: Schema.Array(Schema.toEncoded(CatalogCategorySchema)).check(Schema.isMaxLength(50)),
  products: Schema.Array(BootstrapProductSchema).check(Schema.isMaxLength(20)),
});
export type BootstrapBatch = typeof BootstrapBatchSchema.Type;
export const BootstrapManifestSchema = Schema.Struct({
  batchDigests: Schema.Array(Digest).check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  categories: Count,
  homepageFeaturedProductIds: Schema.Array(Schema.toEncoded(ProductIdReferenceSchema)).check(Schema.isMaxLength(20)),
  products: Count,
  sourceFingerprint: Schema.Literal(PLAYGROUND_SOURCE_FINGERPRINT),
  variants: Count,
});
export type BootstrapManifest = typeof BootstrapManifestSchema.Type;
export const BootstrapCheckpointSchema = Schema.Struct({
  manifest: BootstrapManifestSchema,
  nextBatch: Count,
  status: Schema.Literals(['IMPORTING', 'VERIFIED']),
});
export type BootstrapCheckpoint = typeof BootstrapCheckpointSchema.Type;

export class PlaygroundBootstrapRejected extends Schema.TaggedError<PlaygroundBootstrapRejected>()(
  'PlaygroundBootstrapRejected',
  { code: Schema.Literal('playground_bootstrap_rejected'), reason: Schema.String },
) {}
export const bootstrapRejected = <Cause = never>(reason: string, cause?: Cause) =>
  Object.defineProperty(new PlaygroundBootstrapRejected({ code: 'playground_bootstrap_rejected', reason }), 'cause', {
    enumerable: false,
    value: cause,
  });

const encodeJson = Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Any));
/** Same canonical JSON as the frozen copy plan: sorted object keys, significant array order. */
export const bootstrapCanonicalJson = <Value>(value: Value): string => {
  if (Array.isArray(value)) {
    return `[${value.map(bootstrapCanonicalJson).join(',')}]`;
  }
  if (Predicate.isObject(value)) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => Order.String(left, right))
      .map(([key, entry]) => `${Result.getOrThrow(encodeJson(key))}:${bootstrapCanonicalJson(entry)}`)
      .join(',')}}`;
  }
  return Result.getOrThrow(encodeJson(value)) ?? 'null';
};
export const bootstrapDigest = <Value>(value: Value) =>
  Crypto.Crypto.use((crypto) => crypto.digest('SHA-256', new TextEncoder().encode(bootstrapCanonicalJson(value)))).pipe(
    Effect.mapError((cause) => bootstrapRejected('Catalog fingerprint computation is unavailable', cause)),
    Effect.map((hash) => [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('')),
  );

/** True means append atomically; false means an already committed exact batch is a safe no-op. */
export const bootstrapBatchNeedsAppend = Effect.fn('Merchandise.bootstrapBatchNeedsAppend')(function* needsAppend(
  checkpoint: BootstrapCheckpoint,
  index: number,
  batch: BootstrapBatch,
) {
  if (
    new TextEncoder().encode(bootstrapCanonicalJson(batch)).byteLength > BOOTSTRAP_MAX_BYTES ||
    (yield* bootstrapDigest(batch)) !== checkpoint.manifest.batchDigests[index]
  ) {
    return yield* bootstrapRejected('Batch differs from the approved source or exceeds its byte limit');
  }
  if (index > checkpoint.nextBatch) {
    return yield* bootstrapRejected('An earlier batch must commit before this batch');
  }
  if (index === checkpoint.nextBatch && checkpoint.status !== 'IMPORTING') {
    return yield* bootstrapRejected('A verified catalog cannot be imported again');
  }
  return index === checkpoint.nextBatch;
});

/** Deterministic bounded partitions. The approved manifest binds every byte and its position. */
interface MutableBatch {
  categories: BootstrapBatch['categories'][number][];
  products: BootstrapBatch['products'][number][];
}
export const bootstrapBatches = (catalog: {
  readonly categories: BootstrapBatch['categories'];
  readonly products: BootstrapBatch['products'];
}): readonly BootstrapBatch[] => {
  const batches: BootstrapBatch[] = [];
  let batch: MutableBatch = {
    categories: [],
    products: [],
  };
  const flush = () => {
    if (batch.categories.length + batch.products.length > 0) {
      batches.push(batch);
      batch = { categories: [], products: [] };
    }
  };
  for (const category of catalog.categories) {
    const next = { ...batch, categories: [...batch.categories, category] };
    if (
      next.categories.length > 50 ||
      new TextEncoder().encode(bootstrapCanonicalJson(next)).byteLength > BOOTSTRAP_MAX_BYTES
    ) {
      flush();
    }
    batch.categories.push(category);
  }
  flush();
  for (const product of catalog.products) {
    const next = { ...batch, products: [...batch.products, product] };
    if (
      next.products.length > 20 ||
      new TextEncoder().encode(bootstrapCanonicalJson(next)).byteLength > BOOTSTRAP_MAX_BYTES
    ) {
      flush();
    }
    batch.products.push(product);
  }
  flush();
  return batches;
};
