import { Context, Effect, Schema, Stream } from 'effect';

import { actionErrorSchema } from '../actions/error-schema.ts';
import { ContentTally } from './content-tally.ts';
import { ObjectStorage, ObjectStorageObjectMissing } from './object-storage.ts';
import type { ObjectStat, ObjectStorageFailure } from './object-storage.ts';
import { MediaByteSizeSchema, MediaContentSha256Schema } from './public-contract.ts';
import type { MediaStorageKey } from './storage-key.ts';
import { MediaStorageKeySchema } from './storage-key.ts';

/*
 * Verification of a stored object: the size and SHA-256 of the bytes the provider actually holds, read back and
 * hashed outside any Core transaction. It decides nothing about the asset row; it produces evidence that the
 * confirm Action consumes. Only a cleanly read, framing-consistent, unchanged object that differs from what was
 * declared is a mismatch. Everything else that goes wrong is `unverifiable`, which never closes an asset.
 */

const UnverifiableReasonSchema = Schema.Literals([
  /** The provider has no object under the key (yet): never a mismatch, never an absent asset. */
  'object_missing',
  /** The provider failed, timed out, or closed the stream early. */
  'provider_failure',
  /** A clean end delivered a different length than the provider's own stat declared. */
  'framing_inconsistent',
  /** The composed provider is not the one the row names. */
  'provider_mismatch',
  /** The object's stat changed while it was being read, so what was hashed may not be what is stored. */
  'object_changed',
]);
type UnverifiableReason = typeof UnverifiableReasonSchema.Type;

const MediaProviderIdSchema = Schema.String.pipe(Schema.brand('MediaProviderId'));

const EvidenceBaseFields = {
  providerId: MediaProviderIdSchema,
  storageKey: MediaStorageKeySchema,
} as const;

/**
 * What a verification found, as a closed union the confirm Action decides on. It is branded so a plain object
 * is not evidence by type, and the schema is the one runtime check of its shape. Who may provide it is the
 * composing host's trust boundary, exactly as for the provider port and the trusted scope.
 */
export const MediaStoredObjectVerificationSchema = Schema.Union([
  Schema.Struct({
    ...EvidenceBaseFields,
    byteSize: MediaByteSizeSchema,
    contentSha256: MediaContentSha256Schema,
    outcome: Schema.Literal('verified'),
    /** The provider's technical pin of the verified object, when it has one. Never a revision. */
    versionRef: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...EvidenceBaseFields,
    mismatch: Schema.Literals(['sha256', 'size']),
    observed: Schema.Struct({ byteSize: MediaByteSizeSchema, contentSha256: MediaContentSha256Schema }),
    outcome: Schema.Literal('mismatch'),
  }),
  Schema.Struct({
    ...EvidenceBaseFields,
    outcome: Schema.Literal('unverifiable'),
    reason: UnverifiableReasonSchema,
  }),
]).pipe(Schema.brand('MediaStoredObjectVerification'));
export type MediaStoredObjectVerification = typeof MediaStoredObjectVerificationSchema.Type;
export const isMediaStoredObjectVerification = Schema.is(MediaStoredObjectVerificationSchema);

export interface VerifyStoredMediaObjectInput {
  /** What the reservation declared. A missing digest claim means only the size is compared. */
  readonly expected: { readonly byteSize: number; readonly contentSha256?: string | undefined };
  readonly storageKey: MediaStorageKey;
  readonly storageProvider: string;
}

/** Internal control flow of one verification: why the stored object could not be judged. */
const UnverifiableValue = actionErrorSchema('MediaObjectUnverifiable', { reason: UnverifiableReasonSchema });
const unverifiable = (reason: UnverifiableReason) => new UnverifiableValue({ reason });
const isObjectMissing = Schema.is(ObjectStorageObjectMissing);

const unverifiableOf = (failure: ObjectStorageFailure) =>
  unverifiable(isObjectMissing(failure) ? 'object_missing' : 'provider_failure');

const sameObject = (before: ObjectStat, after: ObjectStat): boolean =>
  before.byteSize === after.byteSize && before.versionRef === after.versionRef;

/**
 * Reads the stored object back and compares what it holds with what was declared. It never fails: every
 * outcome, including every provider failure, is a value of the evidence, so the caller cannot mistake an
 * outage for a mismatch or the other way round.
 */
export const verifyStoredMediaObject = Effect.fn('MediaVerification.verify')(function* verifyStoredMediaObject(
  input: VerifyStoredMediaObjectInput,
) {
  const storage = yield* ObjectStorage;
  const base = { providerId: storage.providerId, storageKey: input.storageKey };
  const read = Effect.gen(function* readBack() {
    if (storage.providerId !== input.storageProvider) {
      return yield* unverifiable('provider_mismatch');
    }
    const opened = yield* storage.get(input.storageKey).pipe(Effect.mapError(unverifiableOf));
    const tally = new ContentTally();
    yield* opened.body.pipe(
      Stream.runForEach((chunk) => Effect.sync(() => tally.add(chunk))),
      Effect.mapError(unverifiableOf),
    );
    const observed = tally.finish();
    // A clean end that disagrees with the provider's own length is a transfer problem, not a bad object.
    if (observed.byteSize !== opened.stat.byteSize) {
      return yield* unverifiable('framing_inconsistent');
    }
    const after = yield* storage.stat(input.storageKey).pipe(Effect.mapError(unverifiableOf));
    if (!sameObject(opened.stat, after)) {
      return yield* unverifiable('object_changed');
    }
    if (observed.byteSize !== input.expected.byteSize) {
      return { ...base, mismatch: 'size', observed, outcome: 'mismatch' } as const;
    }
    if (input.expected.contentSha256 !== undefined && observed.contentSha256 !== input.expected.contentSha256) {
      return { ...base, mismatch: 'sha256', observed, outcome: 'mismatch' } as const;
    }
    return { ...base, ...observed, outcome: 'verified', versionRef: opened.stat.versionRef } as const;
  });
  const outcome = yield* read.pipe(
    Effect.catchTag('MediaObjectUnverifiable', ({ reason }) =>
      Effect.succeed({ ...base, outcome: 'unverifiable', reason } as const),
    ),
  );
  // The brand is earned here: the verifier validates its own finding against the evidence schema.
  return yield* Schema.decodeUnknownEffect(MediaStoredObjectVerificationSchema)(outcome).pipe(Effect.orDie);
});

/**
 * The evidence the confirm Action decides on, handed to it as a request-scoped service by the trusted caller
 * that verified the stored object outside the Action: a payload field could be forged by any caller, a service
 * only the composing host can provide.
 */
export class StoredMediaObjectVerification extends Context.Service<
  StoredMediaObjectVerification,
  MediaStoredObjectVerification
>()('@app/core-runtime/media/verification/StoredMediaObjectVerification') {}
