import { sha256 } from '@noble/hashes/sha2.js';
import { Effect, Schema, Stream } from 'effect';
import { Hex } from 'effect/encoding';
import { expect, it } from 'effect-rstest';

import { TenantMediaAssetKeySchema } from '../../src/media/identity.ts';
import { ObjectStorage, ObjectStorageNetworkError, ObjectStorageTimeout } from '../../src/media/object-storage.ts';
import type { ObjectStorageService } from '../../src/media/object-storage.ts';
import { deriveMediaStorageKey } from '../../src/media/storage-key.ts';
import type { VerifyStoredMediaObjectInput } from '../../src/media/verification.ts';
import { isMediaStoredObjectVerification, verifyStoredMediaObject } from '../../src/media/verification.ts';
import { makeInMemoryObjectStorage, withObjectStorageFaults } from '../../src/testing/media-object-storage.ts';

/*
 * Verification reads the stored object back and hashes what the provider actually holds, outside any Core
 * transaction. Absence, a premature close, a provider failure or a read that disagrees with the provider's own
 * stat is never proof of a mismatch: only a cleanly read, framing-consistent object that differs is.
 */

const tenantId = '00000000-0000-4000-8000-000000000001';
const assetId = '00000000-0000-4000-8000-0000000000a1';
const encoder = new TextEncoder();
const content = encoder.encode('hello media bytes');
const digestOf = (bytes: Uint8Array) => Hex.encode(sha256(bytes));
const key = deriveMediaStorageKey(
  Schema.decodeUnknownSync(TenantMediaAssetKeySchema)({ mediaAssetId: assetId, tenantId }),
);
const expected = { byteSize: content.byteLength, contentSha256: digestOf(content) };
const target = { expected, storageKey: key, storageProvider: 'in-memory-test-double' };

const withStored = (bytes: Uint8Array, options: { readonly versionRefs?: boolean } = {}) =>
  Effect.gen(function* stored() {
    const storage = yield* makeInMemoryObjectStorage(options);
    yield* storage.service.put({ body: Stream.make(bytes), contentType: 'application/octet-stream', key });
    return storage;
  });

const verify = (storage: ObjectStorageService, input: VerifyStoredMediaObjectInput = target) =>
  verifyStoredMediaObject(input).pipe(Effect.provideService(ObjectStorage, storage));

it.effect('verifies the bytes the provider holds and reports their own size and digest', () =>
  Effect.gen(function* verified() {
    const storage = yield* withStored(content, { versionRefs: true });
    const evidence = yield* verify(storage.service);
    expect(evidence).toMatchObject({
      byteSize: content.byteLength,
      contentSha256: digestOf(content),
      outcome: 'verified',
      providerId: 'in-memory-test-double',
      storageKey: key,
      versionRef: 'v1',
    });
    expect(isMediaStoredObjectVerification(evidence)).toBe(true);
  }),
);

it.effect('proves a size mismatch only from a completely read object', () =>
  Effect.gen(function* sizeMismatch() {
    const storage = yield* withStored(content.slice(0, 5));
    const evidence = yield* verify(storage.service);
    expect(evidence).toMatchObject({ mismatch: 'size', outcome: 'mismatch' });
  }),
);

it.effect('proves a digest mismatch of the same size', () =>
  Effect.gen(function* digestMismatch() {
    const storage = yield* withStored(encoder.encode('HELLO MEDIA BYTES'));
    const evidence = yield* verify(storage.service);
    expect(evidence).toMatchObject({ mismatch: 'sha256', outcome: 'mismatch' });
  }),
);

it.effect('is unverifiable, never a mismatch, when the object is not there', () =>
  Effect.gen(function* absent() {
    const storage = yield* makeInMemoryObjectStorage();
    expect(yield* verify(storage.service)).toMatchObject({ outcome: 'unverifiable', reason: 'object_missing' });
  }),
);

it.effect('is unverifiable when the provider times out, fails the network or closes the stream early', () =>
  Effect.gen(function* faults() {
    const storage = yield* withStored(content);
    const timeout = new ObjectStorageTimeout({ code: 'object_storage_timeout', reason: 'r' });
    const network = new ObjectStorageNetworkError({ code: 'object_storage_network_error', reason: 'r' });
    for (const failure of [timeout, network]) {
      const faulty = yield* withObjectStorageFaults([{ failure, operation: 'get' }]).pipe(
        Effect.provideService(ObjectStorage, storage.service),
      );
      expect(yield* verify(faulty)).toMatchObject({ outcome: 'unverifiable', reason: 'provider_failure' });
    }
    const prematureClose: ObjectStorageService = {
      ...storage.service,
      get: () =>
        Effect.succeed({
          body: Stream.concat(Stream.make(content.slice(0, 6)), Stream.fail(network)),
          stat: { byteSize: content.byteLength },
        }),
    };
    expect(yield* verify(prematureClose)).toMatchObject({ outcome: 'unverifiable', reason: 'provider_failure' });
  }),
);

it.effect('is unverifiable when a clean end delivers fewer bytes than the provider itself declared', () =>
  Effect.gen(function* truncated() {
    const storage = yield* withStored(content);
    const liar: ObjectStorageService = {
      ...storage.service,
      get: () =>
        Effect.succeed({
          // Ends cleanly after five bytes while the provider's own stat declares the whole object.
          body: Stream.make(content.slice(0, 5)),
          stat: { byteSize: content.byteLength },
        }),
    };
    expect(yield* verify(liar)).toMatchObject({ outcome: 'unverifiable', reason: 'framing_inconsistent' });
  }),
);

it.effect('is unverifiable when the composed provider is not the one the row names', () =>
  Effect.gen(function* otherProvider() {
    const storage = yield* withStored(content);
    const evidence = yield* verify(storage.service, { ...target, storageProvider: 'some-other-provider' });
    expect(evidence).toMatchObject({ outcome: 'unverifiable', reason: 'provider_mismatch' });
    expect(yield* storage.calls).toHaveLength(1);
  }),
);

it.effect('seals the digest it computed when the reservation declared none', () =>
  Effect.gen(function* undeclared() {
    const storage = yield* withStored(content);
    const evidence = yield* verify(storage.service, { ...target, expected: { byteSize: content.byteLength } });
    expect(evidence).toMatchObject({ contentSha256: digestOf(content), outcome: 'verified' });
  }),
);

it.effect('detects an object replaced while it was being read', () =>
  Effect.gen(function* replaced() {
    const storage = yield* withStored(content, { versionRefs: true });
    const swapping: ObjectStorageService = {
      ...storage.service,
      get: (objectKey) =>
        storage.service.get(objectKey).pipe(
          // Another writer stores new bytes under the same key after the read began.
          Effect.tap(() =>
            storage.service.put({
              body: Stream.make(encoder.encode('replaced bytes!!!!')),
              contentType: 'application/octet-stream',
              key: objectKey,
            }),
          ),
        ),
    };
    expect(yield* verify(swapping)).toMatchObject({ outcome: 'unverifiable', reason: 'object_changed' });
  }),
);

it('refuses a value that is not a complete finding as verification evidence', () => {
  expect(isMediaStoredObjectVerification({ outcome: 'verified', providerId: 'in-memory-test-double' })).toBe(false);
  expect(isMediaStoredObjectVerification({ outcome: 'sealed', providerId: 'p', storageKey: key })).toBe(false);
  expect(isMediaStoredObjectVerification(null)).toBe(false);
});
