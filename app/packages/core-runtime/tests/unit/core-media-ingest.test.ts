import { sha256 } from '@noble/hashes/sha2.js';
import { Cause, DateTime, Effect, Exit, Option, Predicate, Ref, Schema, Stream } from 'effect';
import { Hex } from 'effect/encoding';
import { expect, it } from 'effect-rstest';

import type { MediaByteSourceOffer } from '../../src/media/byte-source-contract.ts';
import { MediaIngestUncertain, MediaIntegrityFailed } from '../../src/media/errors.ts';
import { confirmAssetRequest, ingestMediaBytes, parseContentLength } from '../../src/media/ingest.ts';
import { TenantMediaAssetKeySchema, mediaAssetRefFor } from '../../src/media/identity.ts';
import { ObjectStorage, ObjectStorageNetworkError } from '../../src/media/object-storage.ts';
import { deriveMediaStorageKey } from '../../src/media/storage-key.ts';
import type { ConfirmAssetResultSchema } from '../../src/media/upload-contract.ts';
import type { MediaStoredObjectVerification } from '../../src/media/verification.ts';
import { makeInMemoryObjectStorage, withObjectStorageFaults } from '../../src/testing/media-object-storage.ts';

/*
 * The byte-ingress edge's own logic over the in-memory provider double: who may send bytes, what a body must be,
 * what a replay does, and that only a confirmed `ready` is a success. The double is never storage proof; the same
 * flow runs against real PostgreSQL and the S3-compatible emulator in the integration suites.
 */

const tenantId = '00000000-0000-4000-8000-000000000001';
const assetId = '00000000-0000-4000-8000-0000000000a1';
const reserving = '00000000-0000-4000-8000-0000000000b1';
const stranger = '00000000-0000-4000-8000-0000000000b2';
const company = '00000000-0000-4000-8000-0000000000c1';
const encoder = new TextEncoder();
const content = encoder.encode('the bytes of one reserved asset, sent in three pieces');
const digestOf = (bytes: Uint8Array) => Hex.encode(sha256(bytes));
const identity = Schema.decodeUnknownSync(TenantMediaAssetKeySchema)({ mediaAssetId: assetId, tenantId });
const mediaAssetRef = mediaAssetRefFor(identity);
const storageKey = deriveMediaStorageKey(identity);
const pieces = (bytes: Uint8Array) => Stream.fromIterable([bytes.slice(0, 5), bytes.slice(5, 30), bytes.slice(30)]);

const sealedAt = DateTime.toDateUtc(DateTime.makeUnsafe(0));

const reserved = (overrides: Partial<MediaByteSourceOffer> = {}): MediaByteSourceOffer => ({
  byteSize: BigInt(content.byteLength),
  contentSha256: digestOf(content),
  ingestedByPrincipalId: reserving,
  legalEntityId: null,
  mimeType: 'application/pdf',
  processingStatus: 'uploaded',
  sealedAt: null,
  storageKey,
  storageProvider: 'in-memory-test-double',
  ...overrides,
});

type ConfirmResult = typeof ConfirmAssetResultSchema.Type;

/** What the confirm Action does with evidence, without the database: verified seals, mismatch fails, else uncertain. */
const confirmOutcome = (
  verification: MediaStoredObjectVerification,
): Effect.Effect<ConfirmResult, MediaIngestUncertain | MediaIntegrityFailed> => {
  if (verification.outcome === 'verified') {
    return Effect.succeed({
      byteSize: verification.byteSize,
      contentSha256: verification.contentSha256,
      mediaAssetRef,
      processingStatus: 'ready',
    });
  }
  return Effect.fail(
    verification.outcome === 'mismatch'
      ? new MediaIntegrityFailed({ code: 'media_integrity_failed', reason: 'mismatch' })
      : new MediaIngestUncertain({ code: 'media_ingest_uncertain', reason: 'unverifiable' }),
  );
};

/** The request's stated length: the exact content size unless the test says the request stated none. */
const lengthOf = (stated: number | 'absent' | undefined): number | undefined =>
  stated === 'absent' ? undefined : (stated ?? content.byteLength);

const setup = Effect.fn('IngestTest.setup')(function* setup() {
  const storage = yield* makeInMemoryObjectStorage();
  const confirms = yield* Ref.make<readonly MediaStoredObjectVerification['outcome'][]>([]);
  const confirm = (
    verification: MediaStoredObjectVerification,
  ): Effect.Effect<ConfirmResult, MediaIngestUncertain | MediaIntegrityFailed> =>
    Ref.update(confirms, (all) => [...all, verification.outcome]).pipe(
      Effect.andThen(() => confirmOutcome(verification)),
    );
  const ingest = (
    options: {
      readonly asset?: MediaByteSourceOffer;
      readonly body?: Stream.Stream<Uint8Array, unknown>;
      readonly contentLength?: number | 'absent';
      readonly principalId?: string;
      readonly selectedLegalEntityId?: string | undefined;
      readonly storageOverride?: typeof storage.service;
    } = {},
  ) =>
    ingestMediaBytes({
      asset: options.asset ?? reserved(),
      body: options.body ?? pieces(content),
      confirm,
      contentLength: lengthOf(options.contentLength),
      mediaAssetRef,
      principalId: options.principalId ?? reserving,
      selectedLegalEntityId: options.selectedLegalEntityId,
    }).pipe(Effect.provideService(ObjectStorage, options.storageOverride ?? storage.service));
  const callsOf = storage.calls.pipe(Effect.map((calls) => calls.map(({ operation }) => operation)));
  return { callsOf, confirms: Ref.get(confirms), ingest, storage };
});

const failureTag = <A, E>(exit: Exit.Exit<A, E>): string | undefined => {
  if (!Exit.isFailure(exit)) {
    return undefined;
  }
  const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return Predicate.hasProperty(failure, '_tag') && Predicate.isString(failure._tag) ? failure._tag : undefined;
};

it.effect('stores the body, reads it back, confirms it and answers only the sealed ready identity', () =>
  Effect.gen(function* fullUpload() {
    const { callsOf, confirms, ingest, storage } = yield* setup();
    const result = yield* ingest();
    expect(result).toEqual({
      byteSize: content.byteLength,
      contentSha256: digestOf(content),
      mediaAssetRef,
      processingStatus: 'ready',
    });
    expect(Option.getOrUndefined(yield* storage.peek(storageKey))).toEqual(content);
    expect(yield* callsOf).toEqual(['put', 'get', 'stat']);
    expect(yield* confirms).toEqual(['verified']);
  }),
);

it.effect('refuses another principal before it reads a body byte, and reveals nothing of the reserved size', () =>
  Effect.gen(function* wrongPrincipal() {
    const { callsOf, confirms, ingest } = yield* setup();
    const pulled = yield* Ref.make(0);
    const exit = yield* Effect.exit(
      ingest({
        body: pieces(content).pipe(Stream.tap(() => Ref.update(pulled, (count) => count + 1))),
        contentLength: 1,
        principalId: stranger,
      }),
    );
    expect(failureTag(exit)).toBe('MediaForbidden');
    expect(yield* Ref.get(pulled)).toBe(0);
    expect(yield* callsOf).toEqual([]);
    expect(yield* confirms).toEqual([]);
  }),
);

it.effect('accepts no bytes for a failed or scanning asset', () =>
  Effect.gen(function* wrongStatus() {
    const { callsOf, ingest } = yield* setup();
    expect(failureTag(yield* Effect.exit(ingest({ asset: reserved({ processingStatus: 'failed' }) })))).toBe(
      'MediaIntegrityFailed',
    );
    expect(failureTag(yield* Effect.exit(ingest({ asset: reserved({ processingStatus: 'scanning' }) })))).toBe(
      'MediaNotReady',
    );
    expect(yield* callsOf).toEqual([]);
  }),
);

it.effect('answers an asset reserved in another company as not found, with no provider call', () =>
  Effect.gen(function* otherCompany() {
    const { callsOf, ingest } = yield* setup();
    const exit = yield* Effect.exit(
      ingest({ asset: reserved({ legalEntityId: company }), selectedLegalEntityId: stranger }),
    );
    expect(failureTag(exit)).toBe('MediaAssetNotFound');
    expect(yield* callsOf).toEqual([]);
    const sameCompany = yield* ingest({ asset: reserved({ legalEntityId: company }), selectedLegalEntityId: company });
    expect(sameCompany.processingStatus).toBe('ready');
  }),
);

it.effect('answers a body of unstated length with a typed 411 error and reads no byte', () =>
  Effect.gen(function* lengthRequired() {
    const { callsOf, ingest } = yield* setup();
    const exit = yield* Effect.exit(ingest({ contentLength: 'absent' }));
    expect(failureTag(exit)).toBe('MediaLengthRequired');
    // The put is opened and aborted by the failing body; nothing is read back and nothing is stored.
    expect(yield* callsOf).toEqual(['put']);
  }),
);

it.effect('refuses a stated length other than the reserved size before any byte reaches the provider', () =>
  Effect.gen(function* lengthConflict() {
    const { callsOf, ingest, storage } = yield* setup();
    const exit = yield* Effect.exit(ingest({ contentLength: content.byteLength + 1 }));
    expect(failureTag(exit)).toBe('MediaContentConflict');
    expect(Option.isNone(yield* storage.peek(storageKey))).toBe(true);
    expect(yield* callsOf).toEqual(['put']);
  }),
);

it.effect('is a conflict when the body is not the declared content, and leaves nothing readable', () =>
  Effect.gen(function* wrongBytes() {
    const { ingest, storage } = yield* setup();
    const other = encoder.encode('X'.repeat(content.byteLength));
    expect(failureTag(yield* Effect.exit(ingest({ body: pieces(other) })))).toBe('MediaContentConflict');
    const longer = encoder.encode(`${'Y'.repeat(content.byteLength)}!`);
    expect(failureTag(yield* Effect.exit(ingest({ body: pieces(longer) })))).toBe('MediaContentConflict');
    const shorter = content.slice(0, content.byteLength - 1);
    expect(failureTag(yield* Effect.exit(ingest({ body: pieces(shorter) })))).toBe('MediaContentConflict');
    expect(Option.isNone(yield* storage.peek(storageKey))).toBe(true);
  }),
);

it.effect('does not let a bad retry replace a correct stored object', () =>
  Effect.gen(function* badRetry() {
    const { ingest, storage } = yield* setup();
    yield* storage.service.put({ body: pieces(content), contentType: 'application/pdf', key: storageKey });
    const other = encoder.encode('Z'.repeat(content.byteLength));
    expect(failureTag(yield* Effect.exit(ingest({ body: pieces(other) })))).toBe('MediaContentConflict');
    expect(Option.getOrUndefined(yield* storage.peek(storageKey))).toEqual(content);
  }),
);

it.effect('is uncertain, never ready, when the body ends in a dropped connection, and nothing is stored', () =>
  Effect.gen(function* dropped() {
    const { confirms, ingest, storage } = yield* setup();
    const body = Stream.make(content.slice(0, 10)).pipe(Stream.concat(Stream.fail('connection reset')));
    const exit = yield* Effect.exit(ingest({ body }));
    expect(failureTag(exit)).toBe('MediaIngestUncertain');
    expect(Option.isNone(yield* storage.peek(storageKey))).toBe(true);
    // The unprovable stored object was judged once and stayed unconfirmed.
    expect(yield* confirms).toEqual(['unverifiable']);
  }),
);

it.effect('completes the original asset when the provider stored the bytes but reported a failure', () =>
  Effect.gen(function* storedButReported() {
    const { ingest, storage } = yield* setup();
    const faulty = yield* withObjectStorageFaults([
      {
        failure: new ObjectStorageNetworkError({ code: 'object_storage_network_error', reason: 'reset' }),
        operation: 'put',
        times: 1,
        when: 'after',
      },
    ]).pipe(Effect.provideService(ObjectStorage, storage.service));
    const result = yield* ingest({ storageOverride: faulty });
    expect(result.processingStatus).toBe('ready');
    expect(result.contentSha256).toBe(digestOf(content));
  }),
);

it.effect('stays uncertain when the provider fails the write and holds nothing', () =>
  Effect.gen(function* providerDown() {
    const { ingest, storage } = yield* setup();
    const faulty = yield* withObjectStorageFaults([
      {
        failure: new ObjectStorageNetworkError({ code: 'object_storage_network_error', reason: 'down' }),
        operation: 'put',
      },
    ]).pipe(Effect.provideService(ObjectStorage, storage.service));
    expect(failureTag(yield* Effect.exit(ingest({ storageOverride: faulty })))).toBe('MediaIngestUncertain');
    expect(Option.isNone(yield* storage.peek(storageKey))).toBe(true);
  }),
);

it.effect('closes the intent as an integrity failure when the stored object proves different', () =>
  Effect.gen(function* proven() {
    const { ingest, storage } = yield* setup();
    // Bytes of the right length but another content sit under the key (written outside the hop).
    yield* storage.service.put({
      body: Stream.make(encoder.encode('Q'.repeat(content.byteLength))),
      contentType: 'application/pdf',
      key: storageKey,
    });
    const faulty = yield* withObjectStorageFaults([
      {
        failure: new ObjectStorageNetworkError({ code: 'object_storage_network_error', reason: 'x' }),
        operation: 'put',
      },
    ]).pipe(Effect.provideService(ObjectStorage, storage.service));
    expect(failureTag(yield* Effect.exit(ingest({ storageOverride: faulty })))).toBe('MediaIntegrityFailed');
  }),
);

it.effect('answers a replay of the same bytes with the sealed identity and no second effect', () =>
  Effect.gen(function* replay() {
    const { callsOf, confirms, ingest } = yield* setup();
    const sealed = reserved({ processingStatus: 'ready', sealedAt });
    const result = yield* ingest({ asset: sealed });
    expect(result).toMatchObject({ contentSha256: digestOf(content), processingStatus: 'ready' });
    // The body was compared, nothing was written or read from the provider, and no confirm ran.
    expect(yield* callsOf).toEqual([]);
    expect(yield* confirms).toEqual([]);
  }),
);

it.effect('is a conflict when a replay carries different bytes, and the sealed object is untouched', () =>
  Effect.gen(function* replayConflict() {
    const { callsOf, ingest } = yield* setup();
    const sealed = reserved({ processingStatus: 'ready', sealedAt });
    const other = encoder.encode('R'.repeat(content.byteLength));
    expect(failureTag(yield* Effect.exit(ingest({ asset: sealed, body: pieces(other) })))).toBe('MediaContentConflict');
    expect(yield* callsOf).toEqual([]);
  }),
);

it('parses only an exact decimal Content-Length', () => {
  expect(parseContentLength('12')).toBe(12);
  expect(parseContentLength('0')).toBe(0);
  for (const bad of [undefined, '', '-1', '1.5', '1e3', ' 5', '5 ', '0x10', '12345678901234567890']) {
    expect(parseContentLength(bad)).toBeUndefined();
  }
});

it('derives one confirm identity per asset and never carries a locator in it', () => {
  const first = confirmAssetRequest(mediaAssetRef);
  expect(first).toEqual(confirmAssetRequest(mediaAssetRef));
  expect(first.idempotencyKey).toMatch(/^[0-9a-f]{64}$/u);
  expect(first.idempotencyKey).not.toContain(storageKey);
  expect(first.payload).toEqual({ mediaAssetRef });
});
