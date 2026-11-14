import { Console, Effect, Schema } from 'effect';
import {
  BootstrapPlaygroundCatalogPayloadSchema,
  BootstrapPlaygroundCatalogResultSchema,
} from '../../verticals/merchandise/shared/actions/bootstrap-playground-catalog.ts';
import {
  PLAYGROUND_MANIFEST_DIGEST,
  bootstrapBatches,
} from '../../verticals/merchandise/shared/domain/playground-catalog-bootstrap.ts';
import type { SeedClient } from './seed-client.mts';
import {
  AkrosPlaygroundCopyError,
  bootstrapCopyCatalog,
  copyDigest,
  validateCopyPlan,
} from './akros-playground-copy.mts';
import type { CopyPlan } from './akros-playground-copy.mts';

const Payload = Schema.toEncoded(BootstrapPlaygroundCatalogPayloadSchema);
const Result = Schema.toEncoded(BootstrapPlaygroundCatalogResultSchema);

/** Backend checkpoints make unknown-write recovery safe with fresh invocations; never retry an uncertain write here. */
export const bootstrapFrozenCatalog = (client: Pick<SeedClient, 'call'>, plan: CopyPlan) =>
  Effect.gen(function* runFrozenCatalogBootstrap() {
    yield* validateCopyPlan(plan, plan.fingerprint);
    const catalog = yield* bootstrapCopyCatalog(plan.snapshot);
    const batches = bootstrapBatches(catalog);
    const manifest = {
      batchDigests: batches.map(copyDigest),
      categories: catalog.categories.length,
      homepageFeaturedProductIds: catalog.homepageFeaturedProductIds,
      products: catalog.products.length,
      sourceFingerprint: plan.fingerprint,
      variants: catalog.products.reduce((total, { product }) => total + (product.variants?.length ?? 0), 0),
    };
    if (copyDigest(manifest) !== PLAYGROUND_MANIFEST_DIGEST) {
      return yield* new AkrosPlaygroundCopyError({
        reason: 'Frozen bootstrap manifest differs from the approved boundary.',
      });
    }
    const call = (payload: typeof Payload.Type) =>
      client.call('merchandise', '/merchandise/actions/bootstrap-playground-catalog', Payload, payload, Result, true);
    const decoded = yield* Schema.decodeUnknownEffect(Payload)({
      _tag: 'Begin',
      confirmation: 'Initialize empty AKROS playground from the approved frozen source',
      manifest,
    });
    let progress = yield* call(decoded);
    yield* Console.log(
      `Catalog bootstrap ${progress.status}: ${progress.nextBatch}/${batches.length} committed batches.`,
    );
    for (let index = progress.nextBatch; index < batches.length; index += 1) {
      const batch = batches[index];
      if (batch === undefined) {
        return yield* new AkrosPlaygroundCopyError({ reason: 'Frozen bootstrap partition is incomplete.' });
      }
      progress = yield* call({ _tag: 'Batch', batch, index, sourceFingerprint: progress.sourceFingerprint });
      if (progress.nextBatch !== index + 1) {
        return yield* new AkrosPlaygroundCopyError({
          reason: 'Governed bootstrap checkpoint did not advance exactly once.',
        });
      }
      yield* Console.log(`Catalog bootstrap: ${progress.nextBatch}/${batches.length} committed batches.`);
    }
    const result = yield* call({ _tag: 'Verify', sourceFingerprint: progress.sourceFingerprint });
    if (result.status !== 'VERIFIED' || result.nextBatch !== batches.length) {
      return yield* new AkrosPlaygroundCopyError({ reason: 'Governed catalog bootstrap was not verified.' });
    }
    return result;
  });
