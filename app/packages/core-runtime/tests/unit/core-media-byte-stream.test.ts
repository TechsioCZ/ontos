import { sha256 } from '@noble/hashes/sha2.js';
import { DateTime, Effect, Option, Ref, Schema, Stream } from 'effect';
import { Hex } from 'effect/encoding';
import { expect, it } from 'effect-rstest';

import { ObjectStorage, ObjectStorageServerError, ObjectStorageTimeout } from '../../src/media/object-storage.ts';
import { streamMediaObject } from '../../src/media/byte-stream.ts';
import type { MediaByteHopAsset } from '../../src/media/byte-stream.ts';
import { TenantMediaAssetKeySchema } from '../../src/media/identity.ts';
import { deriveMediaStorageKey } from '../../src/media/storage-key.ts';
import { makeInMemoryObjectStorage, withObjectStorageFaults } from '../../src/testing/media-object-storage.ts';

/*
 * The byte hop: the one place bytes move into the provider, outside any Core transaction. It touches no database;
 * everything it decides comes from the reserved row it is handed and the stream it counts and hashes in flight.
 */

const tenantId = '00000000-0000-4000-8000-000000000001';
const assetId = '00000000-0000-4000-8000-0000000000a1';
const reservingPrincipal = '00000000-0000-4000-8000-0000000000b1';
const otherPrincipal = '00000000-0000-4000-8000-0000000000b2';
const encoder = new TextEncoder();
const content = encoder.encode('hello media bytes');
const digestOf = (bytes: Uint8Array) => Hex.encode(sha256(bytes));
const storageKey = deriveMediaStorageKey(
  Schema.decodeUnknownSync(TenantMediaAssetKeySchema)({ mediaAssetId: assetId, tenantId }),
);
const chunked = (bytes: Uint8Array) => Stream.fromIterable([bytes.slice(0, 4), bytes.slice(4, 9), bytes.slice(9)]);

const reserved = (overrides: Partial<MediaByteHopAsset> = {}): MediaByteHopAsset => ({
  byteSize: BigInt(content.byteLength),
  contentSha256: digestOf(content),
  ingestedByPrincipalId: reservingPrincipal,
  mimeType: 'application/octet-stream',
  processingStatus: 'uploaded',
  sealedAt: null,
  storageKey,
  storageProvider: 'in-memory-test-double',
  ...overrides,
});

const setup = Effect.fn('ByteStreamTest.setup')(function* setup() {
  const storage = yield* makeInMemoryObjectStorage();
  const run = <A, E>(effect: Effect.Effect<A, E, ObjectStorage>) =>
    effect.pipe(Effect.provideService(ObjectStorage, storage.service));
  return { run, storage };
});

const tagOf = (failure: { readonly _tag: string }) => failure._tag;
const callsOf = (storage: Effect.Success<ReturnType<typeof setup>>['storage']) =>
  storage.calls.pipe(Effect.map((calls) => calls.map(({ operation }) => operation)));

it.effect('stores the streamed bytes under the row key and reports the size and digest of the bytes it sent', () =>
  Effect.gen(function* stores() {
    const { run, storage } = yield* setup();
    const streamed = yield* run(
      streamMediaObject({ asset: reserved(), body: chunked(content), principalId: reservingPrincipal }),
    );
    expect(streamed).toMatchObject({ byteSize: content.byteLength, contentSha256: digestOf(content), kind: 'stored' });
    expect(Option.getOrUndefined(yield* storage.peek(storageKey))).toEqual(content);
    expect(yield* callsOf(storage)).toEqual(['put']);
  }),
);

it.effect('hashes bytes as they pass without buffering the body before the put', () =>
  Effect.gen(function* streaming() {
    const { run } = yield* setup();
    const pulled = yield* Ref.make(0);
    const observed = chunked(content).pipe(Stream.tap(() => Ref.update(pulled, (count) => count + 1)));
    const streamed = yield* run(
      streamMediaObject({ asset: reserved(), body: observed, principalId: reservingPrincipal }),
    );
    expect(streamed.kind).toBe('stored');
    expect(yield* Ref.get(pulled)).toBe(3);
  }),
);

it.effect('refuses a body shorter than the declared size and leaves the reservation to its confirm', () =>
  Effect.gen(function* shorter() {
    const { run } = yield* setup();
    const failure = yield* Effect.flip(
      run(
        streamMediaObject({ asset: reserved(), body: chunked(content.slice(0, 5)), principalId: reservingPrincipal }),
      ),
    );
    expect(tagOf(failure)).toBe('MediaContentConflict');
  }),
);

it.effect('refuses a same-size body with another digest', () =>
  Effect.gen(function* sameSizeOtherBytes() {
    const { run } = yield* setup();
    const other = encoder.encode('HELLO MEDIA BYTES');
    expect(other.byteLength).toBe(content.byteLength);
    const failure = yield* Effect.flip(
      run(streamMediaObject({ asset: reserved(), body: chunked(other), principalId: reservingPrincipal })),
    );
    expect(tagOf(failure)).toBe('MediaContentConflict');
  }),
);

it.effect('stops an oversize body before reading it all and stores nothing readable', () =>
  Effect.gen(function* oversize() {
    const { run, storage } = yield* setup();
    const pulled = yield* Ref.make(0);
    const huge = Stream.fromIterable(Array.from({ length: 50 }, () => encoder.encode('0123456789'))).pipe(
      Stream.tap(() => Ref.update(pulled, (count) => count + 1)),
    );
    const failure = yield* Effect.flip(
      run(streamMediaObject({ asset: reserved(), body: huge, principalId: reservingPrincipal })),
    );
    expect(tagOf(failure)).toBe('MediaContentConflict');
    // 17 declared bytes: the second ten-byte chunk crosses the declaration, the other forty-eight are never pulled.
    expect(yield* Ref.get(pulled)).toBeLessThan(5);
    expect(Option.isNone(yield* storage.peek(storageKey))).toBe(true);
  }),
);

it.effect('accepts a zero-byte file and states its real digest', () =>
  Effect.gen(function* empty() {
    const { run } = yield* setup();
    const zero = new Uint8Array(0);
    const streamed = yield* run(
      streamMediaObject({
        asset: reserved({ byteSize: 0n, contentSha256: digestOf(zero) }),
        body: Stream.empty,
        principalId: reservingPrincipal,
      }),
    );
    expect(streamed).toMatchObject({ byteSize: 0, contentSha256: digestOf(zero), kind: 'stored' });
  }),
);

it.effect('makes no provider call and reads no byte for another principal than the one that reserved', () =>
  Effect.gen(function* foreign() {
    const { run, storage } = yield* setup();
    const pulled = yield* Ref.make(0);
    const body = chunked(content).pipe(Stream.tap(() => Ref.update(pulled, (count) => count + 1)));
    const failure = yield* Effect.flip(
      run(streamMediaObject({ asset: reserved(), body, principalId: otherPrincipal })),
    );
    expect(tagOf(failure)).toBe('MediaForbidden');
    expect(yield* Ref.get(pulled)).toBe(0);
    expect(yield* callsOf(storage)).toEqual([]);
  }),
);

it.effect('makes no provider call for a row that was reserved without a principal binding', () =>
  Effect.gen(function* unbound() {
    const { run, storage } = yield* setup();
    const failure = yield* Effect.flip(
      run(
        streamMediaObject({
          asset: reserved({ ingestedByPrincipalId: null }),
          body: chunked(content),
          principalId: reservingPrincipal,
        }),
      ),
    );
    expect(tagOf(failure)).toBe('MediaForbidden');
    expect(yield* callsOf(storage)).toEqual([]);
  }),
);

it.effect('never overwrites a sealed asset: an identical replay is a no-op and different bytes are a conflict', () =>
  Effect.gen(function* sealed() {
    const { run, storage } = yield* setup();
    const asset = reserved({ processingStatus: 'ready', sealedAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)) });
    const replay = yield* run(streamMediaObject({ asset, body: chunked(content), principalId: reservingPrincipal }));
    expect(replay).toMatchObject({
      byteSize: content.byteLength,
      contentSha256: digestOf(content),
      kind: 'already_stored',
    });
    const conflict = yield* Effect.flip(
      run(
        streamMediaObject({
          asset,
          body: chunked(encoder.encode('different bytes!!!')),
          principalId: reservingPrincipal,
        }),
      ),
    );
    expect(tagOf(conflict)).toBe('MediaContentConflict');
    expect(yield* callsOf(storage)).toEqual([]);
  }),
);

it.effect('accepts no bytes for a failed or scanning asset', () =>
  Effect.gen(function* closed() {
    const { run, storage } = yield* setup();
    const failed = yield* Effect.flip(
      run(
        streamMediaObject({
          asset: reserved({ processingStatus: 'failed' }),
          body: chunked(content),
          principalId: reservingPrincipal,
        }),
      ),
    );
    expect(tagOf(failed)).toBe('MediaIntegrityFailed');
    const scanning = yield* Effect.flip(
      run(
        streamMediaObject({
          asset: reserved({ processingStatus: 'scanning' }),
          body: chunked(content),
          principalId: reservingPrincipal,
        }),
      ),
    );
    expect(tagOf(scanning)).toBe('MediaNotReady');
    expect(yield* callsOf(storage)).toEqual([]);
  }),
);

it.effect('is uncertain, not failed or absent, when the provider times out or answers 5xx', () =>
  Effect.gen(function* outage() {
    const storage = yield* makeInMemoryObjectStorage();
    const timeout = new ObjectStorageTimeout({ code: 'object_storage_timeout', reason: 'r' });
    const server = new ObjectStorageServerError({ code: 'object_storage_server_error', reason: 'r' });
    for (const failure of [timeout, server]) {
      const faulty = yield* withObjectStorageFaults([{ failure, operation: 'put' }]).pipe(
        Effect.provideService(ObjectStorage, storage.service),
      );
      const result = yield* Effect.flip(
        streamMediaObject({ asset: reserved(), body: chunked(content), principalId: reservingPrincipal }).pipe(
          Effect.provideService(ObjectStorage, faulty),
        ),
      );
      expect(tagOf(result)).toBe('MediaIngestUncertain');
    }
  }),
);

it.effect('stays uncertain when the provider stored the bytes but told Core it failed', () =>
  Effect.gen(function* storedButUnacknowledged() {
    const storage = yield* makeInMemoryObjectStorage();
    const faulty = yield* withObjectStorageFaults([
      {
        failure: new ObjectStorageTimeout({ code: 'object_storage_timeout', reason: 'r' }),
        operation: 'put',
        when: 'after',
      },
    ]).pipe(Effect.provideService(ObjectStorage, storage.service));
    const result = yield* Effect.flip(
      streamMediaObject({ asset: reserved(), body: chunked(content), principalId: reservingPrincipal }).pipe(
        Effect.provideService(ObjectStorage, faulty),
      ),
    );
    expect(tagOf(result)).toBe('MediaIngestUncertain');
    // The bytes are there, which is exactly why the outcome must never be reported as "nothing stored".
    expect(Option.isSome(yield* storage.peek(storageKey))).toBe(true);
  }),
);

it.effect('surfaces a body that fails mid-transfer as its own typed error and stores nothing', () =>
  Effect.gen(function* interrupted() {
    const { run, storage } = yield* setup();
    const dropped = { _tag: 'ClientDisconnected' } as const;
    const body = Stream.concat(Stream.make(content.slice(0, 5)), Stream.fail(dropped));
    const failure = yield* Effect.flip(
      run(streamMediaObject({ asset: reserved(), body, principalId: reservingPrincipal })),
    );
    expect(failure).toBe(dropped);
    expect(Option.isNone(yield* storage.peek(storageKey))).toBe(true);
  }),
);

it.effect('refuses a provider that is not the one the row names, before any call', () =>
  Effect.gen(function* otherProvider() {
    const { run, storage } = yield* setup();
    const failure = yield* Effect.flip(
      run(
        streamMediaObject({
          asset: reserved({ storageProvider: 'some-other-provider' }),
          body: chunked(content),
          principalId: reservingPrincipal,
        }),
      ),
    );
    expect(tagOf(failure)).toBe('MediaUnavailable');
    expect(yield* callsOf(storage)).toEqual([]);
  }),
);

it.effect('seals no digest of its own when the reservation declared none, and reports what it sent', () =>
  Effect.gen(function* relaxed() {
    const { run } = yield* setup();
    const streamed = yield* run(
      streamMediaObject({
        asset: reserved({ contentSha256: null }),
        body: chunked(content),
        principalId: reservingPrincipal,
      }),
    );
    expect(streamed).toMatchObject({ contentSha256: digestOf(content), kind: 'stored' });
  }),
);
