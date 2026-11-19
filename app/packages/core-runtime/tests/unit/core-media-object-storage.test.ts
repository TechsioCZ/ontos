import { sha256 } from '@noble/hashes/sha2.js';
import { Effect, Exit, Option, Schema, Stream } from 'effect';
import { Hex } from 'effect/encoding';
import { expect, it } from 'effect-rstest';

import { TenantMediaAssetKeySchema } from '../../src/media/identity.ts';
import {
  ObjectStorage,
  ObjectStorageChecksumMismatch,
  ObjectStorageChecksumUnsupported,
  ObjectStorageFailureSchema,
  ObjectStorageNetworkError,
  ObjectStorageObjectMissing,
  ObjectStorageServerError,
  ObjectStorageTimeout,
} from '../../src/media/object-storage.ts';
import type { ObjectStorageFailure } from '../../src/media/object-storage.ts';
import { MediaStorageKeySchema, deriveMediaStorageKey } from '../../src/media/storage-key.ts';
import { makeInMemoryObjectStorage, withObjectStorageFaults } from '../../src/testing/media-object-storage.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const key = (mediaAssetId: string, tenant = tenantId) =>
  deriveMediaStorageKey(Schema.decodeUnknownSync(TenantMediaAssetKeySchema)({ mediaAssetId, tenantId: tenant }));
const assetA = '00000000-0000-4000-8000-0000000000a1';
const assetB = '00000000-0000-4000-8000-0000000000b2';
const bytes = new TextEncoder().encode('hello media');
const body = Stream.fromIterable([bytes.slice(0, 5), bytes.slice(5)]);

const failures = {
  checksum: new ObjectStorageChecksumUnsupported({ code: 'object_storage_checksum_unsupported', reason: 'r' }),
  mismatch: new ObjectStorageChecksumMismatch({ code: 'object_storage_checksum_mismatch', reason: 'r' }),
  missing: new ObjectStorageObjectMissing({ code: 'object_storage_object_missing', reason: 'r' }),
  network: new ObjectStorageNetworkError({ code: 'object_storage_network_error', reason: 'r' }),
  server: new ObjectStorageServerError({ code: 'object_storage_server_error', reason: 'r' }),
  timeout: new ObjectStorageTimeout({ code: 'object_storage_timeout', reason: 'r' }),
} satisfies Record<string, ObjectStorageFailure>;

it('derives a stable, collision-resistant technical key from the asset identity only', () => {
  expect(key(assetA)).toBe(key(assetA));
  expect(key(assetA)).not.toBe(key(assetB));
  expect(key(assetA)).not.toBe(key(assetA, '00000000-0000-4000-8000-000000000002'));
  expect(Schema.is(MediaStorageKeySchema)(key(assetA))).toBe(true);
  expect(key(assetA)).toMatch(/^core-media\/v1\/[0-9a-f]{64}$/u);
  expect(key(assetA)).not.toContain(assetA);
  expect(Schema.is(MediaStorageKeySchema)('core-media/v1/photo.png')).toBe(false);
});

it.effect('puts streamed bytes and reads them back with their stat', () =>
  Effect.gen(function* roundTrip() {
    const storage = yield* makeInMemoryObjectStorage();
    const stat = yield* storage.service.put({ body, contentType: 'image/png', key: key(assetA) });
    expect(stat).toEqual({ byteSize: bytes.byteLength });
    expect(yield* storage.service.stat(key(assetA))).toEqual(stat);
    const read = yield* storage.service.get(key(assetA));
    expect(read.stat).toEqual(stat);
    const chunks = yield* Stream.runCollect(read.body);
    expect(chunks.flatMap((chunk) => [...chunk])).toEqual([...bytes]);
  }),
);

it.effect('gives two assets with identical bytes two distinct objects', () =>
  Effect.gen(function* distinct() {
    const storage = yield* makeInMemoryObjectStorage();
    yield* storage.service.put({ body, contentType: 'image/png', key: key(assetA) });
    yield* storage.service.put({ body, contentType: 'image/png', key: key(assetB) });
    expect(yield* storage.peek(key(assetA))).toEqual(yield* storage.peek(key(assetB)));
    expect(Option.isSome(yield* storage.peek(key(assetA)))).toBe(true);
    expect(key(assetA)).not.toBe(key(assetB));
  }),
);

it.effect('reports a missing object as the typed provider failure, never as a success', () =>
  Effect.gen(function* missingObject() {
    const storage = yield* makeInMemoryObjectStorage();
    expect(Schema.is(ObjectStorageObjectMissing)(yield* Effect.flip(storage.service.stat(key(assetA))))).toBe(true);
    expect(Schema.is(ObjectStorageObjectMissing)(yield* Effect.flip(storage.service.get(key(assetA))))).toBe(true);
  }),
);

it.effect('stores nothing when the body fails, and passes the body failure through unchanged', () =>
  Effect.gen(function* failingBody() {
    const storage = yield* makeInMemoryObjectStorage();
    const exit = yield* Effect.exit(
      storage.service.put({
        body: Stream.concat(Stream.make(bytes), Stream.fail('client aborted')),
        contentType: 'image/png',
        key: key(assetA),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(yield* storage.peek(key(assetA))).toEqual(Option.none());
  }),
);

it.effect('refuses a requested SHA-256 it cannot attest, and verifies it when it can', () =>
  Effect.gen(function* checksum() {
    const digest = Hex.encode(sha256(bytes));
    const refusing = yield* makeInMemoryObjectStorage();
    const refused = yield* Effect.flip(
      refusing.service.put({ body, contentType: 'x/y', expectedSha256: digest, key: key(assetA) }),
    );
    expect(Schema.is(ObjectStorageChecksumUnsupported)(refused)).toBe(true);
    expect(yield* refusing.peek(key(assetA))).toEqual(Option.none());
    const attesting = yield* makeInMemoryObjectStorage({ attestsSha256: true });
    yield* attesting.service.put({ body, contentType: 'x/y', expectedSha256: digest, key: key(assetA) });
    const mismatch = yield* Effect.flip(
      attesting.service.put({ body, contentType: 'x/y', expectedSha256: '0'.repeat(64), key: key(assetB) }),
    );
    expect(Schema.is(ObjectStorageChecksumMismatch)(mismatch)).toBe(true);
    expect(yield* attesting.peek(key(assetB))).toEqual(Option.none());
  }),
);

it.effect('records a technical version reference only when asked, never a revision', () =>
  Effect.gen(function* versionRefs() {
    const plain = yield* makeInMemoryObjectStorage();
    expect(yield* plain.service.put({ body, contentType: 'x/y', key: key(assetA) })).not.toHaveProperty('versionRef');
    const versioned = yield* makeInMemoryObjectStorage({ versionRefs: true });
    expect(yield* versioned.service.put({ body, contentType: 'x/y', key: key(assetA) })).toEqual({
      byteSize: bytes.byteLength,
      versionRef: 'v1',
    });
  }),
);

it.effect('exposes no delete or revision operation on the port', () =>
  Effect.gen(function* surface() {
    const storage = yield* makeInMemoryObjectStorage();
    expect(Object.keys(storage.service).toSorted()).toEqual(['get', 'put', 'stat']);
  }),
);

it.effect('spies every call, so a denied request can prove it made zero', () =>
  Effect.gen(function* spy() {
    const storage = yield* makeInMemoryObjectStorage();
    expect(yield* storage.calls).toEqual([]);
    yield* storage.service.put({ body, contentType: 'x/y', key: key(assetA) });
    yield* storage.service.stat(key(assetA));
    expect(yield* storage.calls).toEqual([
      { key: key(assetA), operation: 'put' },
      { key: key(assetA), operation: 'stat' },
    ]);
  }),
);

it.effect('injects a fault before the call without touching storage, for exactly the configured number of calls', () =>
  Effect.gen(function* before() {
    const storage = yield* makeInMemoryObjectStorage();
    const faulty = yield* withObjectStorageFaults([{ failure: failures.timeout, operation: 'put', times: 1 }]).pipe(
      Effect.provideService(ObjectStorage, storage.service),
    );
    expect(yield* Effect.flip(faulty.put({ body, contentType: 'x/y', key: key(assetA) }))).toBe(failures.timeout);
    expect(yield* storage.calls).toEqual([]);
    yield* faulty.put({ body, contentType: 'x/y', key: key(assetA) });
    expect(yield* storage.peek(key(assetA))).toEqual(Option.some(bytes));
  }),
);

it.effect('injects the uncertain outcome: stored, yet the caller is told the put failed', () =>
  Effect.gen(function* after() {
    const storage = yield* makeInMemoryObjectStorage();
    const faulty = yield* withObjectStorageFaults([
      { failure: failures.network, operation: 'put', when: 'after' },
    ]).pipe(Effect.provideService(ObjectStorage, storage.service));
    expect(yield* Effect.flip(faulty.put({ body, contentType: 'x/y', key: key(assetA) }))).toBe(failures.network);
    expect(yield* storage.peek(key(assetA))).toEqual(Option.some(bytes));
  }),
);

it('keeps the provider failure set closed and distinguishable', () => {
  expect(new Set(Object.values(failures).map((failure) => failure._tag)).size).toBe(6);
  for (const failure of Object.values(failures)) {
    expect(Schema.is(ObjectStorageFailureSchema)(failure)).toBe(true);
  }
});
