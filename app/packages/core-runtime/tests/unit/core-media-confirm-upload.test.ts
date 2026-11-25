import { sha256 } from '@noble/hashes/sha2.js';
import { Cause, Effect, Exit, Option, Predicate, Ref, Schema, Stream } from 'effect';
import { Hex } from 'effect/encoding';
import { expect, it } from 'effect-rstest';

import type { MediaByteSourceOffer } from '../../src/media/byte-source-contract.ts';
import { confirmReservedUpload } from '../../src/media/confirm-upload.ts';
import { MediaIngestUncertain, MediaIntegrityFailed } from '../../src/media/errors.ts';
import { TenantMediaAssetKeySchema, mediaAssetRefFor } from '../../src/media/identity.ts';
import { MediaByteSizeSchema, MediaContentSha256Schema } from '../../src/media/public-contract.ts';
import { ObjectStorage } from '../../src/media/object-storage.ts';
import { deriveMediaStorageKey } from '../../src/media/storage-key.ts';
import type { ConfirmAssetResultSchema } from '../../src/media/upload-contract.ts';
import type { MediaStoredObjectVerification } from '../../src/media/verification.ts';
import { makeInMemoryObjectStorage } from '../../src/testing/media-object-storage.ts';

/*
 * The confirm step on its own, over the in-memory provider double: who may ask for a read-back, that a settled row
 * never reaches the provider, and that only a confirmed `ready` is a success. The double is never storage proof.
 */

const tenantId = '00000000-0000-4000-8000-000000000001';
const assetId = '00000000-0000-4000-8000-0000000000a1';
const reserving = '00000000-0000-4000-8000-0000000000b1';
const stranger = '00000000-0000-4000-8000-0000000000b2';
const company = '00000000-0000-4000-8000-0000000000c1';
const content = new TextEncoder().encode('the bytes of one reserved asset');
const digestOf = (bytes: Uint8Array) => Hex.encode(sha256(bytes));
const identity = Schema.decodeUnknownSync(TenantMediaAssetKeySchema)({ mediaAssetId: assetId, tenantId });
const mediaAssetRef = mediaAssetRefFor(identity);
const storageKey = deriveMediaStorageKey(identity);

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
const sealedByteSize = Schema.decodeUnknownSync(MediaByteSizeSchema)(content.byteLength);
const sealedSha256 = Schema.decodeUnknownSync(MediaContentSha256Schema)(digestOf(content));

/** What the confirm Action does: a settled row is followed whatever the evidence, an `uploaded` one is judged by it. */
const confirmOutcome = (
  status: MediaByteSourceOffer['processingStatus'],
  verification: MediaStoredObjectVerification,
): Effect.Effect<ConfirmResult, MediaIngestUncertain | MediaIntegrityFailed> => {
  if (status === 'failed') {
    return Effect.fail(new MediaIntegrityFailed({ code: 'media_integrity_failed', reason: 'the asset failed' }));
  }
  if (status === 'ready' || verification.outcome === 'verified') {
    return Effect.succeed({
      byteSize: sealedByteSize,
      contentSha256: sealedSha256,
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

const setup = Effect.fn('ConfirmUploadTest.setup')(function* setup() {
  const storage = yield* makeInMemoryObjectStorage();
  const confirms = yield* Ref.make<readonly MediaStoredObjectVerification['outcome'][]>([]);
  const run = (
    options: {
      readonly asset?: MediaByteSourceOffer;
      readonly principalId?: string;
      readonly selectedLegalEntityId?: string;
    } = {},
  ) => {
    const asset = options.asset ?? reserved();
    return confirmReservedUpload({
      asset,
      confirm: (verification) =>
        Ref.update(confirms, (all) => [...all, verification.outcome]).pipe(
          Effect.andThen(() => confirmOutcome(asset.processingStatus, verification)),
        ),
      mediaAssetRef,
      principalId: options.principalId ?? reserving,
      selectedLegalEntityId: options.selectedLegalEntityId,
    }).pipe(Effect.provideService(ObjectStorage, storage.service));
  };
  const calls = storage.calls.pipe(Effect.map((all) => all.map(({ operation }) => operation)));
  return { calls, confirms: Ref.get(confirms), run, storage };
});

const failureTag = <A, E>(exit: Exit.Exit<A, E>): string | undefined => {
  if (!Exit.isFailure(exit)) {
    return undefined;
  }
  const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return Predicate.hasProperty(failure, '_tag') && Predicate.isString(failure._tag) ? failure._tag : undefined;
};

const storeContent = (storage: Effect.Success<ReturnType<typeof setup>>['storage'], bytes: Uint8Array) =>
  storage.service.put({ body: Stream.make(bytes), contentType: 'application/pdf', key: storageKey });

it.effect('seals the asset from the stored object and answers the ready identity', () =>
  Effect.gen(function* settled() {
    const { calls, confirms, run, storage } = yield* setup();
    yield* storeContent(storage, content);
    const before = (yield* calls).length;
    const result = yield* run();
    expect(result).toEqual({
      byteSize: content.byteLength,
      contentSha256: digestOf(content),
      mediaAssetRef,
      processingStatus: 'ready',
    });
    expect((yield* calls).slice(before)).toEqual(['get', 'stat']);
    expect(yield* confirms).toEqual(['verified']);
  }),
);

it.effect('is uncertain, and keeps the asset recoverable, while no object is stored yet', () =>
  Effect.gen(function* notThereYet() {
    const { confirms, run } = yield* setup();
    expect(failureTag(yield* Effect.exit(run()))).toBe('MediaIngestUncertain');
    expect(yield* confirms).toEqual(['unverifiable']);
  }),
);

it.effect('proves a stored object that is not the declared content as an integrity failure', () =>
  Effect.gen(function* differentBytes() {
    const { run, storage } = yield* setup();
    yield* storeContent(storage, new TextEncoder().encode('X'.repeat(content.byteLength)));
    expect(failureTag(yield* Effect.exit(run()))).toBe('MediaIntegrityFailed');
  }),
);

it.effect(
  'asks the Action for a sealed or failed asset too, with evidence that proves nothing and no provider read',
  () =>
    Effect.gen(function* settledRows() {
      const { calls, confirms, run } = yield* setup();
      // The Action, not this step, decides: capability, idempotency and replay are its. It follows the row.
      const sealed = yield* run({ asset: reserved({ processingStatus: 'ready' }) });
      expect(sealed.processingStatus).toBe('ready');
      expect(failureTag(yield* Effect.exit(run({ asset: reserved({ processingStatus: 'failed' }) })))).toBe(
        'MediaIntegrityFailed',
      );
      expect(yield* confirms).toEqual(['unverifiable', 'unverifiable']);
      expect(yield* calls).toEqual([]);
    }),
);

it.effect('does not reveal the asset to another principal or another company, and reads nothing for them', () =>
  Effect.gen(function* notFound() {
    const { calls, confirms, run } = yield* setup();
    expect(failureTag(yield* Effect.exit(run({ principalId: stranger })))).toBe('MediaAssetNotFound');
    expect(
      failureTag(
        yield* Effect.exit(run({ asset: reserved({ legalEntityId: company }), selectedLegalEntityId: stranger })),
      ),
    ).toBe('MediaAssetNotFound');
    expect(failureTag(yield* Effect.exit(run({ asset: reserved({ ingestedByPrincipalId: null }) })))).toBe(
      'MediaAssetNotFound',
    );
    // A row that does not carry the asset's own storage key is another asset's row.
    expect(failureTag(yield* Effect.exit(run({ asset: reserved({ storageKey: `${storageKey}-other` }) })))).toBe(
      'MediaAssetNotFound',
    );
    expect(yield* calls).toEqual([]);
    expect(yield* confirms).toEqual([]);
  }),
);
