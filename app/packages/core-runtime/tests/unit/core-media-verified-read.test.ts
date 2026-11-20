import { sha256 } from '@noble/hashes/sha2.js';
import { Cause, DateTime, Effect, Exit, Option, Schema, Stream } from 'effect';
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
import {
  isMediaIntegrityFinding,
  MediaVerifiedReadInterrupted,
  openVerifiedMediaStream,
  verifyReadyMediaAsset,
} from '../../src/media/verified-read.ts';
import type { MediaVerifiableAsset } from '../../src/media/verified-read.ts';
import { makeInMemoryObjectStorage, withObjectStorageFaults } from '../../src/testing/media-object-storage.ts';

/*
 * The verified read of a READY asset (#1434 H1=A). The five outcomes are distinct, and only the proven one,
 * a completely and cleanly read object whose size or digest differs from the recorded one, is corruption. Every other
 * way a read can go wrong is a request-level result that changes nothing durable. A completely read object of
 * ANOTHER size is corruption like another digest (#1434 BR-06); a short, doubtful or interrupted read is not.
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

const verify = (storage: ObjectStorageService, asset: MediaVerifiableAsset = readyAsset()) =>
  verifyReadyMediaAsset(asset).pipe(Effect.provideService(ObjectStorage, storage));

const timeout = new ObjectStorageTimeout({ code: 'object_storage_timeout', reason: 'slow' });
const network = new ObjectStorageNetworkError({ code: 'object_storage_network_error', reason: 'reset' });
const serverError = new ObjectStorageServerError({ code: 'object_storage_server_error', reason: '503' });
const missing = new ObjectStorageObjectMissing({ code: 'object_storage_object_missing', reason: '404' });

const withFault = (storage: ObjectStorageService, failure: ObjectStorageFailure, operation: 'get' | 'stat') =>
  withObjectStorageFaults([{ failure, operation }]).pipe(Effect.provideService(ObjectStorage, storage));

it.effect('verifies the bytes of a ready asset against the confirmed size and digest', () =>
  Effect.gen(function* verified() {
    const storage = yield* withStored(content, { versionRefs: true });
    const outcome = yield* verify(storage.service, readyAsset({ storageObjectVersionRef: 'v1' }));
    expect(outcome).toEqual({
      byteSize: content.byteLength,
      contentSha256: digestOf(content),
      outcome: 'verified',
      versionRef: 'v1',
    });
  }),
);

it.effect('answers a timeout, a network failure and a 5xx as unavailable, never as corruption or absence', () =>
  Effect.gen(function* outage() {
    const storage = yield* withStored(content);
    for (const failure of [timeout, network, serverError]) {
      const faulty = yield* withFault(storage.service, failure, 'get');
      expect(yield* verify(faulty)).toEqual({
        outcome: 'unavailable',
        providerFailure: failure.code,
        reason: 'provider_failure',
      });
    }
  }),
);

it.effect('stays unavailable however often the provider fails: there is no count and no time that promotes it', () =>
  Effect.gen(function* repeated() {
    const storage = yield* withStored(content);
    const faulty = yield* withObjectStorageFaults([{ failure: timeout, operation: 'get' }]).pipe(
      Effect.provideService(ObjectStorage, storage.service),
    );
    for (let attempt = 0; attempt < 25; attempt += 1) {
      expect((yield* verify(faulty)).outcome).toBe('unavailable');
    }
    // The same asset is verified as soon as the provider answers the same bytes again.
    expect((yield* verify(storage.service)).outcome).toBe('verified');
  }),
);

it.effect('answers a provider 404 as a missing object: not an absent asset and not corruption', () =>
  Effect.gen(function* notThere() {
    const empty = yield* makeInMemoryObjectStorage();
    expect(yield* verify(empty.service)).toEqual({ outcome: 'missing_object' });
    const storage = yield* withStored(content);
    const faulty = yield* withFault(storage.service, missing, 'get');
    expect(yield* verify(faulty)).toEqual({ outcome: 'missing_object' });
  }),
);

it.effect('answers a stream that fails midway as unavailable, whatever the provider reports', () =>
  Effect.gen(function* midway() {
    const storage = yield* withStored(content);
    const dropped: ObjectStorageService = {
      ...storage.service,
      get: () =>
        Effect.succeed({
          body: Stream.concat(Stream.make(content.slice(0, 6)), Stream.fail(network)),
          stat: { byteSize: content.byteLength },
        }),
    };
    expect(yield* verify(dropped)).toMatchObject({ outcome: 'unavailable', reason: 'provider_failure' });
  }),
);

it.effect('never proves corruption from a truncated transfer that ends cleanly (design-review M3)', () =>
  Effect.gen(function* truncated() {
    const storage = yield* withStored(content);
    const cleanButShort: ObjectStorageService = {
      ...storage.service,
      get: () =>
        Effect.succeed({
          // A proxy turned a dropped connection into a clean end: five bytes, while the stat declares the object.
          body: Stream.make(content.slice(0, 5)),
          stat: { byteSize: content.byteLength },
        }),
    };
    expect(yield* verify(cleanButShort)).toEqual({ outcome: 'unavailable', reason: 'framing_inconsistent' });
    const cleanButLong: ObjectStorageService = {
      ...storage.service,
      get: () =>
        Effect.succeed({
          body: Stream.make(content, content),
          stat: { byteSize: content.byteLength },
        }),
    };
    expect(yield* verify(cleanButLong)).toEqual({ outcome: 'unavailable', reason: 'framing_inconsistent' });
  }),
);

it.effect('proves corruption from a complete read of the recorded length whose digest differs', () =>
  Effect.gen(function* corrupt() {
    const tampered = encoder.encode('THE CONFIRMED BYTES OF ONE ASSET');
    expect(tampered.byteLength).toBe(content.byteLength);
    const storage = yield* withStored(tampered);
    const outcome = yield* verify(storage.service);
    expect(outcome.outcome).toBe('integrity_failed');
    if (outcome.outcome !== 'integrity_failed') {
      return;
    }
    expect(isMediaIntegrityFinding(outcome.finding)).toBe(true);
    expect(outcome.finding).toMatchObject({
      observed: { byteSize: content.byteLength, contentSha256: digestOf(tampered) },
      providerId: PROVIDER,
      recorded: { byteSize: content.byteLength, contentSha256: digestOf(content) },
      storageKey: key,
    });
  }),
);

it.effect(
  'proves corruption from a complete read of ANOTHER length (#1434 BR-06): a different size is corruption',
  () =>
    Effect.gen(function* otherLength() {
      const longer = encoder.encode('a different and longer confirmed body');
      const storage = yield* withStored(longer);
      const outcome = yield* verify(storage.service);
      expect(outcome.outcome).toBe('integrity_failed');
      if (outcome.outcome !== 'integrity_failed') {
        return;
      }
      expect(isMediaIntegrityFinding(outcome.finding)).toBe(true);
      expect(outcome.finding.observed).toEqual({ byteSize: longer.byteLength, contentSha256: digestOf(longer) });
      expect(outcome.finding.recorded).toMatchObject({
        byteSize: content.byteLength,
        contentSha256: digestOf(content),
      });
      // A shorter object that is read completely is corruption in the same way.
      const shorter = yield* withStored(content.slice(0, 5));
      expect((yield* verify(shorter.service)).outcome).toBe('integrity_failed');
    }),
);

it.effect(
  'never proves corruption from another length unless the whole object was read with the promised framing',
  () =>
    Effect.gen(function* otherLengthDoubtful() {
      const storage = yield* withStored(content);
      const longer = encoder.encode('a different and longer confirmed body');
      const brokenFraming: ObjectStorageService = {
        ...storage.service,
        // The provider declares a longer object, but the clean end delivers fewer bytes than it declared.
        get: () => Effect.succeed({ body: Stream.make(longer.slice(0, 7)), stat: { byteSize: longer.byteLength } }),
      };
      expect(yield* verify(brokenFraming)).toEqual({ outcome: 'unavailable', reason: 'framing_inconsistent' });
      const droppedMidway: ObjectStorageService = {
        ...storage.service,
        get: () =>
          Effect.succeed({
            body: Stream.concat(Stream.make(longer.slice(0, 7)), Stream.fail(network)),
            stat: { byteSize: longer.byteLength },
          }),
      };
      expect(yield* verify(droppedMidway)).toMatchObject({ outcome: 'unavailable', reason: 'provider_failure' });
    }),
);

it.effect('a streaming consumer refuses, without reading a byte, an object whose declared length differs', () =>
  Effect.gen(function* otherLengthStream() {
    const storage = yield* withStored(encoder.encode('a different and longer confirmed body'));
    let pulled = false;
    const watching: ObjectStorageService = {
      ...storage.service,
      get: (objectKey) =>
        storage.service.get(objectKey).pipe(
          Effect.map((opened) => ({
            ...opened,
            body: Stream.suspend(() => {
              pulled = true;
              return opened.body;
            }),
          })),
        ),
    };
    const exit = yield* openVerifiedMediaStream(readyAsset()).pipe(
      Effect.provideService(ObjectStorage, watching),
      Effect.exit,
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
        read: { outcome: 'inconsistent_metadata', reason: 'declared_size_differs' },
      });
    }
    expect(pulled).toBe(false);
  }),
);

it.effect('reads the whole object under another technical version pin and judges only the bytes', () =>
  Effect.gen(function* otherVersion() {
    const storage = yield* withStored(content, { versionRefs: true });
    // The pin is technical, never the identity: the same bytes under another pin are still the confirmed bytes.
    expect((yield* verify(storage.service, readyAsset({ storageObjectVersionRef: 'v9' }))).outcome).toBe('verified');
    const tampered = yield* withStored(encoder.encode('THE CONFIRMED BYTES OF ONE ASSET'), { versionRefs: true });
    expect((yield* verify(tampered.service, readyAsset({ storageObjectVersionRef: 'v9' }))).outcome).toBe(
      'integrity_failed',
    );
    // A streaming consumer still refuses a pin that differs before the first byte.
    const exit = yield* openVerifiedMediaStream(readyAsset({ storageObjectVersionRef: 'v9' })).pipe(
      Effect.provideService(ObjectStorage, storage.service),
      Effect.exit,
    );
    expect(Exit.isFailure(exit)).toBe(true);
    // No recorded pin means no pin to compare, whatever the provider reports now.
    expect((yield* verify(storage.service, readyAsset({ storageObjectVersionRef: null }))).outcome).toBe('verified');
  }),
);

it.effect('refuses a row that is not a sealed ready identity before it asks the provider anything', () =>
  Effect.gen(function* rows() {
    const storage = yield* withStored(content);
    const refusals = [
      [readyAsset({ processingStatus: 'uploaded' }), 'not_ready'],
      [readyAsset({ processingStatus: 'failed' }), 'not_ready'],
      [readyAsset({ sealedAt: null }), 'not_sealed'],
      [readyAsset({ contentSha256: null }), 'not_sealed'],
      [readyAsset({ contentSha256: 'not-a-digest' }), 'identity_invalid'],
      [readyAsset({ storageKey: 'core-media/v1/short' }), 'identity_invalid'],
      [readyAsset({ byteSize: -1n }), 'identity_invalid'],
    ] as const;
    for (const [asset, reason] of refusals) {
      expect(yield* verify(storage.service, asset)).toEqual({ outcome: 'inconsistent_metadata', reason });
    }
    expect(yield* storage.calls).toEqual([{ key, operation: 'put' }]);
  }),
);

it.effect('answers another composed provider as unavailable without a provider call', () =>
  Effect.gen(function* otherProvider() {
    const storage = yield* withStored(content);
    expect(yield* verify(storage.service, readyAsset({ storageProvider: 'some-other-provider' }))).toEqual({
      outcome: 'unavailable',
      reason: 'provider_mismatch',
    });
    expect(yield* storage.calls).toHaveLength(1);
  }),
);

it.effect('answers an object that changed while it was read as unavailable, never as corruption', () =>
  Effect.gen(function* replaced() {
    const storage = yield* withStored(content, { versionRefs: true });
    const swapping: ObjectStorageService = {
      ...storage.service,
      get: (objectKey) =>
        storage.service.get(objectKey).pipe(
          Effect.tap(() =>
            storage.service.put({
              body: Stream.make(encoder.encode('THE CONFIRMED BYTES OF ONE ASSET')),
              contentType: 'application/octet-stream',
              key: objectKey,
            }),
          ),
        ),
    };
    expect(yield* verify(swapping)).toEqual({ outcome: 'unavailable', reason: 'object_changed' });
  }),
);

it.effect('answers a failing closing stat as unavailable: the read cannot be proven to be of one object', () =>
  Effect.gen(function* closing() {
    const storage = yield* withStored(encoder.encode('THE CONFIRMED BYTES OF ONE ASSET'));
    const faulty = yield* withFault(storage.service, timeout, 'stat');
    expect(yield* verify(faulty)).toEqual({
      outcome: 'unavailable',
      providerFailure: 'object_storage_timeout',
      reason: 'provider_failure',
    });
  }),
);

it('refuses a value that is not a complete finding of corruption', () => {
  const recorded = { byteSize: 1, contentSha256: 'a'.repeat(64) };
  const base = { providerId: PROVIDER, storageKey: key };
  // An observation equal to the recorded identity and a plain missing field are none of them a finding.
  expect(isMediaIntegrityFinding({ ...base, observed: { byteSize: 1, contentSha256: 'a'.repeat(64) }, recorded })).toBe(
    false,
  );
  // Another length is a finding, even with an equal digest field: size is part of the confirmed identity (BR-06).
  expect(isMediaIntegrityFinding({ ...base, observed: { byteSize: 2, contentSha256: 'a'.repeat(64) }, recorded })).toBe(
    true,
  );
  expect(isMediaIntegrityFinding({ ...base, observed: { byteSize: 2, contentSha256: 'b'.repeat(64) }, recorded })).toBe(
    true,
  );
  expect(isMediaIntegrityFinding({ ...base, recorded })).toBe(false);
  expect(isMediaIntegrityFinding({ ...base, observed: { byteSize: 1, contentSha256: 'b'.repeat(64) }, recorded })).toBe(
    true,
  );
});

it.effect('streams a verified object chunk by chunk and ends cleanly only after the verdict', () =>
  Effect.gen(function* streamed() {
    const storage = yield* withStored(content);
    const opened = yield* openVerifiedMediaStream(readyAsset()).pipe(
      Effect.provideService(ObjectStorage, storage.service),
    );
    expect(opened).toMatchObject({ byteSize: content.byteLength, contentSha256: digestOf(content) });
    const chunks = yield* Stream.runCollect(opened.body);
    expect(Buffer.concat(chunks).equals(Buffer.from(content))).toBe(true);
  }),
);

it.effect('pulls the provider lazily: one chunk taken is one chunk read, nothing is buffered whole', () =>
  Effect.gen(function* lazy() {
    const storage = yield* withStored(content);
    let pulls = 0;
    const counting: ObjectStorageService = {
      ...storage.service,
      get: () =>
        Effect.succeed({
          body: Stream.fromIterable([content.slice(0, 4), content.slice(4, 8), content.slice(8)]).pipe(
            Stream.mapEffect((chunk) =>
              Effect.sync(() => {
                pulls += 1;
                return chunk;
              }),
            ),
          ),
          stat: { byteSize: content.byteLength },
        }),
    };
    const opened = yield* openVerifiedMediaStream(readyAsset()).pipe(Effect.provideService(ObjectStorage, counting));
    const first = yield* Stream.runCollect(Stream.take(opened.body, 1));
    expect(first).toHaveLength(1);
    expect(pulls).toBeLessThan(3);
  }),
);

it.effect('ends a stream of corrupt bytes with the typed finding, and a dropped stream as unavailable', () =>
  Effect.gen(function* failing() {
    const tampered = yield* withStored(encoder.encode('THE CONFIRMED BYTES OF ONE ASSET'));
    const opened = yield* openVerifiedMediaStream(readyAsset()).pipe(
      Effect.provideService(ObjectStorage, tampered.service),
    );
    const exit = yield* Effect.exit(Stream.runDrain(opened.body));
    const failure = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
    expect(Schema.is(MediaVerifiedReadInterrupted)(failure)).toBe(true);
    expect(failure?.read.outcome).toBe('integrity_failed');
    const storage = yield* withStored(content);
    const dropped: ObjectStorageService = {
      ...storage.service,
      get: () =>
        Effect.succeed({
          body: Stream.concat(Stream.make(content.slice(0, 3)), Stream.fail(timeout)),
          stat: { byteSize: content.byteLength },
        }),
    };
    const reopened = yield* openVerifiedMediaStream(readyAsset()).pipe(Effect.provideService(ObjectStorage, dropped));
    const droppedExit = yield* Effect.exit(Stream.runDrain(reopened.body));
    const droppedFailure = Exit.isFailure(droppedExit)
      ? Option.getOrUndefined(Cause.findErrorOption(droppedExit.cause))
      : undefined;
    expect(droppedFailure?.read).toMatchObject({ outcome: 'unavailable', reason: 'provider_failure' });
  }),
);

it.effect('refuses before the first byte when the provider cannot even open the object', () =>
  Effect.gen(function* refusal() {
    const storage = yield* withStored(content);
    const faulty = yield* withFault(storage.service, serverError, 'get');
    const exit = yield* Effect.exit(
      openVerifiedMediaStream(readyAsset()).pipe(Effect.provideService(ObjectStorage, faulty)),
    );
    const failure = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
    expect(failure?.read).toMatchObject({ outcome: 'unavailable', reason: 'provider_failure' });
  }),
);
