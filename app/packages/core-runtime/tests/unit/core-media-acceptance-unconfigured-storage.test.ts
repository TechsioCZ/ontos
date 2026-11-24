import { DateTime, Effect, Schema, Stream } from 'effect';
import { expect, it } from 'effect-rstest';

import { currentEntryOf } from '../../src/media/current-contract.ts';
import { TenantMediaAssetKeySchema } from '../../src/media/identity.ts';
import { ObjectStorage, ObjectStorageNetworkError, unconfiguredObjectStorage } from '../../src/media/object-storage.ts';
import { deriveMediaStorageKey } from '../../src/media/storage-key.ts';
import { verifyStoredMediaObject } from '../../src/media/verification.ts';
import { statReadyMediaAsset, verifyReadyMediaAsset } from '../../src/media/verified-read.ts';
import type { MediaVerifiableAsset } from '../../src/media/verified-read.ts';
import { makeInMemoryObjectStorage } from '../../src/testing/media-object-storage.ts';

/*
 * A host with no object store configured (L1447-BDD-02, L1447-BDD-40): the port is never a provider that answers.
 * It reaches nothing, its identity matches no asset, and every use of it ends as an unavailable request, which is
 * retryable and neither a verified byte, corruption nor an absent asset. Only a provider that was actually run can
 * ever read as storage; this one cannot be mistaken for the in-memory double either.
 */

const tenantId = '00000000-0000-4000-8000-000000000001';
const assetId = '00000000-0000-4000-8000-0000000000a1';
const bytes = new TextEncoder().encode('bytes that no provider holds');
const key = deriveMediaStorageKey(
  Schema.decodeUnknownSync(TenantMediaAssetKeySchema)({ mediaAssetId: assetId, tenantId }),
);

/** A confirmed row as a configured host recorded it: sealed, ready, naming the provider that stored it. */
const readyAssetOn = (storageProvider: string): MediaVerifiableAsset => ({
  byteSize: BigInt(bytes.byteLength),
  contentSha256: 'a'.repeat(64),
  processingStatus: 'ready',
  sealedAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
  storageKey: key,
  storageObjectVersionRef: null,
  storageProvider,
});

const unconfigured = <Value, Failure>(effect: Effect.Effect<Value, Failure, ObjectStorage>) =>
  effect.pipe(Effect.provideService(ObjectStorage, unconfiguredObjectStorage));

it.effect('refuses every use of the port with a retryable network failure, and stores or returns nothing', () =>
  Effect.gen(function* refuses() {
    const failures = yield* Effect.all(
      [
        unconfiguredObjectStorage.stat(key).pipe(Effect.flip),
        unconfiguredObjectStorage.get(key).pipe(Effect.flip),
        unconfiguredObjectStorage
          .put({ body: Stream.make(bytes), contentType: 'application/pdf', key })
          .pipe(Effect.flip),
      ],
      { concurrency: 1 },
    );
    for (const failure of failures) {
      expect(Schema.is(ObjectStorageNetworkError)(failure)).toBe(true);
      expect(failure).toMatchObject({
        code: 'object_storage_network_error',
        reason: 'No object store is configured',
      });
    }
  }),
);

it.effect('is a provider that no row names and that cannot be taken for the in-memory double', () =>
  Effect.gen(function* identity() {
    const inMemory = yield* makeInMemoryObjectStorage();
    expect(unconfiguredObjectStorage.providerId).toBe('core-media-unconfigured');
    expect(unconfiguredObjectStorage.providerId).not.toBe(inMemory.service.providerId);
  }),
);

it.effect('answers a Current stat, a full verification and an upload verification as unavailable, never as proof', () =>
  Effect.gen(function* unavailable() {
    const inMemoryAsset = readyAssetOn('in-memory-test-double');
    // Whatever provider the row names, the unconfigured port is neither it nor a way to confirm it.
    for (const asset of [inMemoryAsset, readyAssetOn('core-media-unconfigured')]) {
      const stat = yield* unconfigured(statReadyMediaAsset(asset));
      expect(stat.outcome).toBe('unavailable');
      const verified = yield* unconfigured(verifyReadyMediaAsset(asset));
      expect(verified.outcome).toBe('unavailable');
      // Current turns that into the retryable answer: never AVAILABLE, never ABSENT, never CURRENT_UNVERIFIED.
      const resourceRef = {
        moduleId: 'core.media',
        resourceId: assetId,
        resourceType: 'core.media.asset',
        tenantId,
      } as const;
      expect(currentEntryOf(resourceRef, stat).kind).toBe('UNAVAILABLE');
    }
    const upload = yield* unconfigured(
      verifyStoredMediaObject({
        expected: { byteSize: bytes.byteLength, contentSha256: 'a'.repeat(64) },
        storageKey: key,
        storageProvider: 'in-memory-test-double',
      }),
    );
    expect(upload.outcome).toBe('unverifiable');
  }),
);
