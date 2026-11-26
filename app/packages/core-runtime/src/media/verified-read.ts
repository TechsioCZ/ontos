import { Effect, Option, Schema, Stream } from 'effect';

import { actionErrorSchema } from '../actions/error-schema.ts';
import { ContentDigest, DigestStepTimeout } from './content-digest.ts';
import { ObjectStorage, ObjectStorageObjectMissing } from './object-storage.ts';
import type { ObjectStat, ObjectStorageFailure } from './object-storage.ts';
import { MediaByteSizeSchema, MediaContentSha256Schema } from './public-contract.ts';
import type { MediaByteSize, MediaContentSha256 } from './public-contract.ts';
import type { MediaAssetRecord } from './repository.ts';
import { MediaStorageKeySchema } from './storage-key.ts';
import type { MediaStorageKey } from './storage-key.ts';
import { logMediaRecovery, mediaRecoveryRef } from './recovery-log.ts';
import { MediaProviderIdSchema, isSameStoredObject } from './verification.ts';

/*
 * The verified-bytes service of Core Media: it reads the stored object of one READY asset through the provider
 * port and compares what the provider really delivers with the identity the asset was confirmed with. It is the
 * one place that decides what a read result means, so download and Current never classify provider behaviour
 * themselves. It touches no database and changes no state; a proven corruption is handed on as evidence and only
 * the integrity Action may record it.
 *
 * The five outcomes are distinct on purpose (#1434 H1=A):
 * - `verified`: the delivered bytes are exactly the confirmed identity.
 * - `unavailable`: this request could not be judged (provider failure, early or doubtful end of the stream, an
 *   object that changed while it was read). Never durable, never time promoted, never corruption.
 * - `missing_object`: the provider holds no object under the key. The Core row still exists, so this is neither
 *   an absent Media Asset nor proof of corruption.
 * - `inconsistent_metadata`: the Core row is not a sealed ready identity, or (for a consumer that must not read
 *   a byte it would refuse to deliver) the provider's own stat already disagrees with the confirmed identity.
 *   Delivery is refused; nothing is claimed about the bytes.
 * - `integrity_failed`: PROVEN corruption, and only that (#1434 BR-06): the whole object was read, the stream
 *   ended with exactly the length the provider declared, the object did not change while it was read, and its
 *   size or its digest differs from the confirmed identity. A different size of a completely read object is
 *   corruption exactly like a different digest; a short, doubtful or interrupted read proves nothing.
 */

const UnavailableReasonSchema = Schema.Literals([
  /** The provider failed, timed out or closed the stream early. */
  'provider_failure',
  /** A clean end delivered another length than the provider itself declared. */
  'framing_inconsistent',
  /** The object's stat changed while it was being read, so what was hashed may not be what is stored. */
  'object_changed',
  /** The composed provider is not the one that holds this asset. */
  'provider_mismatch',
]);

const InconsistentMetadataReasonSchema = Schema.Literals([
  /** The asset is not `ready`: its bytes are not a confirmed identity yet, or no longer. */
  'not_ready',
  /** A ready row without a seal or a digest contradicts itself. */
  'not_sealed',
  /** The recorded size, digest or storage key is not a value Core could have written. */
  'identity_invalid',
  /** The provider declares another length than the recorded one: a streaming consumer refuses before a byte. */
  'declared_size_differs',
  /** The provider's technical version pin is not the one recorded for the confirmed object. */
  'object_replaced',
]);
type MediaInconsistentMetadataReason = typeof InconsistentMetadataReasonSchema.Type;

/** What the integrity Action may act on. Branded, so a plain object is not proof of corruption by type. */
export const MediaIntegrityFindingSchema = Schema.Struct({
  observed: Schema.Struct({ byteSize: MediaByteSizeSchema, contentSha256: MediaContentSha256Schema }),
  providerId: MediaProviderIdSchema,
  recorded: Schema.Struct({
    byteSize: MediaByteSizeSchema,
    contentSha256: MediaContentSha256Schema,
    versionRef: Schema.optionalKey(Schema.String),
  }),
  storageKey: MediaStorageKeySchema,
}).pipe(
  // The shape itself carries the proof rule: what was completely read differs from the recorded identity.
  Schema.check(
    Schema.makeFilter((finding) =>
      finding.observed.byteSize !== finding.recorded.byteSize ||
      finding.observed.contentSha256 !== finding.recorded.contentSha256
        ? undefined
        : 'A finding of corruption is a complete read that differs from the recorded size or digest',
    ),
  ),
  Schema.brand('MediaIntegrityFinding'),
);
export type MediaIntegrityFinding = typeof MediaIntegrityFindingSchema.Type;
export const isMediaIntegrityFinding = Schema.is(MediaIntegrityFindingSchema);

export interface MediaVerifiedBytes {
  readonly byteSize: MediaByteSize;
  readonly contentSha256: MediaContentSha256;
  readonly outcome: 'verified';
  readonly versionRef?: string | undefined;
}

/** Every outcome that is not a verification: what the consumer must report instead of bytes. */
const MediaUnverifiedReadSchema = Schema.Union([
  Schema.Struct({ finding: MediaIntegrityFindingSchema, outcome: Schema.Literal('integrity_failed') }),
  Schema.Struct({ outcome: Schema.Literal('inconsistent_metadata'), reason: InconsistentMetadataReasonSchema }),
  Schema.Struct({ outcome: Schema.Literal('missing_object') }),
  Schema.Struct({
    outcome: Schema.Literal('unavailable'),
    /** The stable code of the provider failure, when there was one: a category, never a provider message. */
    providerFailure: Schema.optionalKey(Schema.String),
    reason: UnavailableReasonSchema,
  }),
]);
export type MediaUnverifiedRead = typeof MediaUnverifiedReadSchema.Type;

export type MediaVerifiedReadOutcome = MediaUnverifiedRead | MediaVerifiedBytes;

/** The row facts a verified read needs. It never needs, and so never receives, anything else. */
export type MediaVerifiableAsset = Pick<
  MediaAssetRecord,
  | 'byteSize'
  | 'contentSha256'
  | 'processingStatus'
  | 'sealedAt'
  | 'storageKey'
  | 'storageObjectVersionRef'
  | 'storageProvider'
>;

/** The failure channel of a verified stream: the read stopped without a verification. */
export class MediaVerifiedReadInterrupted extends actionErrorSchema('MediaVerifiedReadInterrupted', {
  read: MediaUnverifiedReadSchema,
}) {}

const interrupted = (read: MediaUnverifiedRead) => new MediaVerifiedReadInterrupted({ read });

const isObjectMissing = Schema.is(ObjectStorageObjectMissing);

/** A provider failure as the interruption it is: a missing object is its own outcome, everything else unavailable. */
const providerInterruption = (failure: ObjectStorageFailure) =>
  interrupted(
    isObjectMissing(failure)
      ? { outcome: 'missing_object' }
      : { outcome: 'unavailable', providerFailure: failure.code, reason: 'provider_failure' },
  );

const RecordedIdentitySchema = Schema.Struct({
  byteSize: MediaByteSizeSchema,
  contentSha256: MediaContentSha256Schema,
  storageKey: MediaStorageKeySchema,
});

/** The recorded identity of a ready asset, or why the row is not one. */
const recordedIdentityOf = Effect.fn('MediaVerifiedRead.recordedIdentity')(function* recordedIdentityOf(
  asset: MediaVerifiableAsset,
) {
  if (asset.processingStatus !== 'ready') {
    return yield* interrupted({ outcome: 'inconsistent_metadata', reason: 'not_ready' });
  }
  if (asset.sealedAt === null || asset.contentSha256 === null) {
    return yield* interrupted({ outcome: 'inconsistent_metadata', reason: 'not_sealed' });
  }
  const identity = yield* Schema.decodeUnknownEffect(RecordedIdentitySchema)({
    byteSize: Number(asset.byteSize),
    contentSha256: asset.contentSha256,
    storageKey: asset.storageKey,
  }).pipe(
    Effect.catchTag('SchemaError', () => interrupted({ outcome: 'inconsistent_metadata', reason: 'identity_invalid' })),
  );
  return { ...identity, versionRef: asset.storageObjectVersionRef ?? undefined };
});

interface OpenedObject {
  readonly body: Stream.Stream<Uint8Array, ObjectStorageFailure>;
  readonly key: MediaStorageKey;
  readonly recorded: {
    readonly byteSize: MediaByteSize;
    readonly contentSha256: MediaContentSha256;
    readonly versionRef: string | undefined;
  };
  readonly stat: ObjectStat;
}

/** Why the provider's own stat already disagrees with the recorded identity, before any byte is read. */
const statRefusalOf = (
  stat: ObjectStat,
  recorded: OpenedObject['recorded'],
): MediaInconsistentMetadataReason | undefined =>
  // The technical version pin is not part of the confirmed identity: bytes that verify are the confirmed bytes.
  stat.byteSize === recorded.byteSize ? undefined : 'declared_size_differs';

/**
 * Everything that can be refused before a byte is read: the row and the provider identity, and, for a consumer
 * that delivers the bytes (`refuseStatMismatch`), the provider's declared length against the recorded one, with the
 * opened body released undelivered. A full verification does not refuse on the stat: it reads the whole object, because
 * only a complete read can prove that another size is corruption.
 */
const openRecordedObject = Effect.fn('MediaVerifiedRead.open')(function* openRecordedObject(
  asset: MediaVerifiableAsset,
  options: { readonly refuseStatMismatch: boolean },
) {
  const recorded = yield* recordedIdentityOf(asset);
  const storage = yield* ObjectStorage;
  if (storage.providerId !== asset.storageProvider) {
    return yield* interrupted({ outcome: 'unavailable', reason: 'provider_mismatch' });
  }
  const opened = yield* storage.get(recorded.storageKey).pipe(Effect.mapError(providerInterruption));
  const refusal = options.refuseStatMismatch ? statRefusalOf(opened.stat, recorded) : undefined;
  if (refusal !== undefined) {
    // Nothing of it is delivered; taking at most its first chunk ends the stream, which releases the provider response.
    yield* Stream.runDrain(Stream.take(opened.body, 1)).pipe(Effect.ignore);
    return yield* interrupted({ outcome: 'inconsistent_metadata', reason: refusal });
  }
  return { body: opened.body, key: recorded.storageKey, recorded, stat: opened.stat } satisfies OpenedObject;
});

/**
 * The verdict once the stream ended cleanly. The order is the proof rule: a clean end must have delivered the
 * length the provider declared (framing), and the object must be the same one after the read as before it;
 * only then does a differing size or digest prove corruption.
 */
const verdictOf = Effect.fn('MediaVerifiedRead.verdict')(function* verdictOf(
  opened: OpenedObject,
  digest: ContentDigest,
) {
  const storage = yield* ObjectStorage;
  const observed = yield* digest.finish();
  if (observed.byteSize !== opened.stat.byteSize) {
    return yield* interrupted({ outcome: 'unavailable', reason: 'framing_inconsistent' });
  }
  const after = yield* storage.stat(opened.key).pipe(Effect.mapError(providerInterruption));
  if (!isSameStoredObject(opened.stat, after)) {
    return yield* interrupted({ outcome: 'unavailable', reason: 'object_changed' });
  }
  if (observed.byteSize === opened.recorded.byteSize && observed.contentSha256 === opened.recorded.contentSha256) {
    return {
      byteSize: observed.byteSize,
      contentSha256: observed.contentSha256,
      outcome: 'verified',
      versionRef: opened.stat.versionRef,
    } as const satisfies MediaVerifiedBytes;
  }
  const { versionRef, ...pinless } = opened.recorded;
  const finding = yield* Schema.decodeUnknownEffect(MediaIntegrityFindingSchema)({
    observed,
    providerId: storage.providerId,
    recorded: versionRef === undefined ? pinless : { ...pinless, versionRef },
    storageKey: opened.key,
  }).pipe(Effect.orDie);
  return yield* interrupted({ finding, outcome: 'integrity_failed' });
});

/**
 * The stream of the opened object. Every chunk is digested as it passes, and the LAST chunk is withheld until the
 * verdict is in: a consumer that announces the confirmed length (HTTP `Content-Length`) then never sees a complete
 * body for bytes that turn out wrong, because the final bytes are only released after the object verified.
 */
const verifiedBody = (opened: OpenedObject) =>
  Stream.suspend(() => {
    const digest = new ContentDigest();
    // The last chunk read so far, withheld until the next one (or the verdict) arrives.
    let held = Option.none<Uint8Array>();
    const exchange = (next: Option.Option<Uint8Array>) => {
      const previous = Option.toArray(held);
      held = next;
      return previous;
    };
    return opened.body.pipe(
      Stream.mapError(providerInterruption),
      // One chunk at a time: the digest is order-dependent, so the sequence is the contract, not an accident.
      Stream.mapEffect((chunk) => digest.add(chunk).pipe(Effect.as(chunk)), { concurrency: 1 }),
      // An empty chunk carries no byte and must never push the real last chunk out before the verdict.
      Stream.filter((chunk) => chunk.byteLength > 0),
      Stream.map((chunk) => exchange(Option.some(chunk))),
      Stream.flattenIterable,
      Stream.concat(
        Stream.fromEffect(verdictOf(opened, digest)).pipe(
          Stream.map(() => exchange(Option.none())),
          Stream.flattenIterable,
        ),
      ),
    );
  });

export interface OpenedVerifiedMediaStream {
  /**
   * The object's bytes, passed on chunk by chunk, never buffered whole. A clean end means the whole object was
   * verified; any other end is `MediaVerifiedReadInterrupted`. Bytes already emitted before a failing end were
   * NOT yet verified, except that the last chunk is only emitted after the verdict: a consumer that must not
   * present unverified bytes at all verifies first (`verifyReadyMediaAsset`).
   */
  readonly body: Stream.Stream<Uint8Array, MediaVerifiedReadInterrupted>;
  readonly byteSize: MediaByteSize;
  readonly contentSha256: MediaContentSha256;
}

/**
 * Opens the stored object of a ready asset for a consumer that streams it. Everything that can be refused before
 * the first byte is refused here, as `MediaVerifiedReadInterrupted` on the failure channel, with zero bytes read.
 */
export const openVerifiedMediaStream = Effect.fn('MediaVerifiedRead.openStream')(function* openVerifiedMediaStream(
  asset: MediaVerifiableAsset,
) {
  const storage = yield* ObjectStorage;
  // The transport runs the body in its own context, so what the body reads from the host travels with it.
  const digestStepTimeout = yield* Effect.service(DigestStepTimeout);
  const opened = yield* openRecordedObject(asset, { refuseStatMismatch: true });
  return {
    body: verifiedBody(opened).pipe(
      Stream.provideService(ObjectStorage, storage),
      Stream.provideService(DigestStepTimeout, digestStepTimeout),
    ),
    byteSize: opened.recorded.byteSize,
    contentSha256: opened.recorded.contentSha256,
  } satisfies OpenedVerifiedMediaStream;
});

/**
 * Reads the whole stored object of a ready asset and judges it, without keeping or returning a single byte.
 * The service never fails: every outcome, a provider failure included, is a value, so a caller cannot mistake
 * an outage for corruption or the other way round.
 */
export const verifyReadyMediaAsset = Effect.fn('MediaVerifiedRead.verify')(function* verifyReadyMediaAsset(
  asset: MediaVerifiableAsset,
) {
  const read = Effect.gen(function* read() {
    const opened = yield* openRecordedObject(asset, { refuseStatMismatch: false });
    const digest = new ContentDigest();
    yield* opened.body.pipe(
      Stream.runForEach((chunk) => digest.add(chunk)),
      Effect.mapError(providerInterruption),
    );
    return yield* verdictOf(opened, digest);
  });
  const outcome = yield* read.pipe(
    Effect.catchTag('MediaVerifiedReadInterrupted', ({ read: unverified }) =>
      Effect.succeed<MediaVerifiedReadOutcome>(unverified),
    ),
  );
  yield* logMediaRecovery({
    category: outcome.outcome,
    operation: 'verified_read',
    providerFailure: outcome.outcome === 'unavailable' ? outcome.providerFailure : undefined,
    ref: mediaRecoveryRef(asset.storageKey),
  });
  return outcome;
});

/**
 * The refusals that need no byte: the row, the provider identity and the provider's declared length against the
 * recorded one. It opens no body.
 */
export const statRecordedObject = Effect.fn('MediaVerifiedRead.statRecorded')(function* statRecordedObject(
  asset: MediaVerifiableAsset,
) {
  const recorded = yield* recordedIdentityOf(asset);
  const storage = yield* ObjectStorage;
  if (storage.providerId !== asset.storageProvider) {
    return yield* interrupted({ outcome: 'unavailable', reason: 'provider_mismatch' });
  }
  const stat = yield* storage.stat(recorded.storageKey).pipe(Effect.mapError(providerInterruption));
  const refusal = statRefusalOf(stat, recorded);
  if (refusal !== undefined) {
    return yield* interrupted({ outcome: 'inconsistent_metadata', reason: refusal });
  }
  return { recorded, stat };
});

/** What a stat of a ready asset's stored object found: no byte was read, so nothing here proves corruption. */
export type MediaStatOutcome =
  | Exclude<MediaUnverifiedRead, { readonly outcome: 'integrity_failed' }>
  | { readonly byteSize: MediaByteSize; readonly outcome: 'present' };

/**
 * The present-availability check of one READY asset (Current V1, #1443): the provider's stat of the stored object
 * against the recorded identity. It reads no byte, so it is the cheap check Current may repeat on every answer and
 * it can never say `integrity_failed`; a different size or a replaced version pin is `inconsistent_metadata`
 * (not proven corruption), a missing object is `missing_object`, and a provider that cannot answer is
 * `unavailable`. Like the full verification it never fails and changes nothing.
 */
export const statReadyMediaAsset = Effect.fn('MediaVerifiedRead.stat')(function* statReadyMediaAsset(
  asset: MediaVerifiableAsset,
) {
  const check = Effect.gen(function* check() {
    const { recorded, stat } = yield* statRecordedObject(asset);
    // A pin that was recorded must still be the provider's: another one is another stored object.
    if (recorded.versionRef !== undefined && stat.versionRef !== recorded.versionRef) {
      return yield* interrupted({ outcome: 'inconsistent_metadata', reason: 'object_replaced' });
    }
    return { byteSize: recorded.byteSize, outcome: 'present' } as const satisfies MediaStatOutcome;
  });
  const outcome = yield* check.pipe(
    Effect.catchTag('MediaVerifiedReadInterrupted', ({ read: unverified }) =>
      // A stat reads no byte, so the proof of corruption is unreachable here.
      unverified.outcome === 'integrity_failed'
        ? Effect.die('A stat cannot prove corruption')
        : Effect.succeed<MediaStatOutcome>(unverified),
    ),
  );
  if (outcome.outcome !== 'present') {
    yield* logMediaRecovery({
      category: outcome.outcome,
      operation: 'verified_read',
      providerFailure: outcome.outcome === 'unavailable' ? outcome.providerFailure : undefined,
      ref: mediaRecoveryRef(asset.storageKey),
    });
  }
  return outcome;
});
