import { sha256 } from '@noble/hashes/sha2.js';
import { DateTime, Effect, Schema, Stream } from 'effect';
import { Hex } from 'effect/encoding';
import { expect, it } from 'effect-rstest';

import { TenantMediaAssetKeySchema } from '../../src/media/identity.ts';
import {
  ObjectStorage,
  ObjectStorageNetworkError,
  ObjectStorageObjectMissing,
  ObjectStorageServerError,
  ObjectStorageTimeout,
} from '../../src/media/object-storage.ts';
import type { ObjectStorageFailure, ObjectStorageService } from '../../src/media/object-storage.ts';
import { deriveMediaStorageKey } from '../../src/media/storage-key.ts';
import { statReadyMediaAsset } from '../../src/media/verified-read.ts';
import type { MediaVerifiableAsset } from '../../src/media/verified-read.ts';
import { makeInMemoryObjectStorage, withObjectStorageFaults } from '../../src/testing/media-object-storage.ts';

/*
 * The present-availability check of Current V1 (#1443): a stat of the stored object of one READY asset against its
 * recorded identity. It reads no byte, so it can never prove corruption and never changes anything; a provider
 * that cannot answer is `unavailable`, and an object that is absent or no longer the recorded one is a distinct,
 * not-proven-corrupt answer. The full byte verification stays in the download and the recovery.
 */

const tenantId = '00000000-0000-4000-8000-000000000001';
const assetId = '00000000-0000-4000-8000-0000000000a1';
const encoder = new TextEncoder();
const content = encoder.encode('the confirmed bytes of one asset');
const digestOf = (bytes: Uint8Array) => Hex.encode(sha256(bytes));
const key = deriveMediaStorageKey(
  Schema.decodeUnknownSync(TenantMediaAssetKeySchema)({ mediaAssetId: assetId, tenantId }),
);
const PROVIDER = 'in-memory-test-double';

const readyAsset = (overrides: Partial<MediaVerifiableAsset> = {}): MediaVerifiableAsset => ({
  byteSize: BigInt(content.byteLength),
  contentSha256: digestOf(content),
  processingStatus: 'ready',
  sealedAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
  storageKey: key,
  storageObjectVersionRef: null,
  storageProvider: PROVIDER,
  ...overrides,
});

const withStored = (bytes: Uint8Array, options: { readonly versionRefs?: boolean } = {}) =>
  Effect.gen(function* stored() {
    const storage = yield* makeInMemoryObjectStorage(options);
    yield* storage.service.put({ body: Stream.make(bytes), contentType: 'application/octet-stream', key });
    return storage;
  });

const stat = (storage: ObjectStorageService, asset: MediaVerifiableAsset = readyAsset()) =>
  statReadyMediaAsset(asset).pipe(Effect.provideService(ObjectStorage, storage));

const withFault = (storage: ObjectStorageService, failure: ObjectStorageFailure) =>
  withObjectStorageFaults([{ failure, operation: 'stat' }]).pipe(Effect.provideService(ObjectStorage, storage));

it.effect('confirms a ready asset whose stored object has the recorded size, with one stat and no byte read', () =>
  Effect.gen(function* present() {
    const storage = yield* withStored(content);
    expect(yield* stat(storage.service)).toEqual({ byteSize: content.byteLength, outcome: 'present' });
    expect((yield* storage.calls).map(({ operation }) => operation).filter((operation) => operation !== 'put')).toEqual(
      ['stat'],
    );
  }),
);

it.effect('keeps the technical version pin out of the answer unless the recorded identity has one that matches', () =>
  Effect.gen(function* pinned() {
    const storage = yield* withStored(content, { versionRefs: true });
    expect(yield* stat(storage.service, readyAsset({ storageObjectVersionRef: 'v1' }))).toEqual({
      byteSize: content.byteLength,
      outcome: 'present',
    });
    // An unversioned recorded identity has no pin to contradict.
    expect((yield* stat(storage.service)).outcome).toBe('present');
  }),
);

it.effect('answers an object that is no longer the recorded one as inconsistent, never as corruption or absence', () =>
  Effect.gen(function* changed() {
    const storage = yield* withStored(content, { versionRefs: true });
    expect(yield* stat(storage.service, readyAsset({ storageObjectVersionRef: 'v7' }))).toEqual({
      outcome: 'inconsistent_metadata',
      reason: 'object_replaced',
    });
    const longer = yield* withStored(encoder.encode('another and longer body than the confirmed one'));
    expect(yield* stat(longer.service)).toEqual({
      outcome: 'inconsistent_metadata',
      reason: 'declared_size_differs',
    });
  }),
);

it.effect('answers a missing object as its own outcome', () =>
  Effect.gen(function* missingObject() {
    const empty = yield* makeInMemoryObjectStorage();
    expect(yield* stat(empty.service)).toEqual({ outcome: 'missing_object' });
  }),
);

it.effect('answers a timeout, a network failure and a 5xx as unavailable', () =>
  Effect.gen(function* outage() {
    const storage = yield* withStored(content);
    for (const failure of [
      new ObjectStorageTimeout({ code: 'object_storage_timeout', reason: 'slow' }),
      new ObjectStorageNetworkError({ code: 'object_storage_network_error', reason: 'reset' }),
      new ObjectStorageServerError({ code: 'object_storage_server_error', reason: '503' }),
    ]) {
      const faulty = yield* withFault(storage.service, failure);
      expect(yield* stat(faulty)).toEqual({
        outcome: 'unavailable',
        providerFailure: failure.code,
        reason: 'provider_failure',
      });
    }
    // The provider's missing-object answer is not an outage.
    const gone = yield* withFault(
      storage.service,
      new ObjectStorageObjectMissing({ code: 'object_storage_object_missing', reason: '404' }),
    );
    expect(yield* stat(gone)).toEqual({ outcome: 'missing_object' });
  }),
);

it.effect('never reaches the provider for a row that is not a confirmed identity', () =>
  Effect.gen(function* notConfirmed() {
    const storage = yield* withStored(content);
    for (const processingStatus of ['uploaded', 'scanning', 'failed'] as const) {
      expect(yield* stat(storage.service, readyAsset({ processingStatus }))).toEqual({
        outcome: 'inconsistent_metadata',
        reason: 'not_ready',
      });
    }
    expect(yield* stat(storage.service, readyAsset({ sealedAt: null }))).toEqual({
      outcome: 'inconsistent_metadata',
      reason: 'not_sealed',
    });
    expect(yield* stat(storage.service, readyAsset({ contentSha256: null }))).toEqual({
      outcome: 'inconsistent_metadata',
      reason: 'not_sealed',
    });
    expect((yield* storage.calls).map(({ operation }) => operation)).toEqual(['put']);
  }),
);

it.effect('answers a provider other than the one that holds the asset as unavailable without a call', () =>
  Effect.gen(function* foreign() {
    const storage = yield* withStored(content);
    expect(yield* stat(storage.service, readyAsset({ storageProvider: 'another-provider' }))).toEqual({
      outcome: 'unavailable',
      reason: 'provider_mismatch',
    });
    expect((yield* storage.calls).map(({ operation }) => operation)).toEqual(['put']);
  }),
);
