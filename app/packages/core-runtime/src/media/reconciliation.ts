import { Effect, Option, Schema } from 'effect';

import { MediaIngestUncertain, MediaIntegrityFailed } from './errors.ts';
import { MediaByteSizeSchema, MediaContentSha256Schema } from './public-contract.ts';
import type { MediaByteSize, MediaContentSha256 } from './public-contract.ts';
import { logMediaRecovery, mediaRecoveryRef } from './recovery-log.ts';
import type { MediaAssetRecord } from './repository.ts';
import { MediaStorageKeySchema } from './storage-key.ts';
import type { ConfirmAssetResultSchema } from './upload-contract.ts';
import { verifyStoredMediaObject } from './verification.ts';
import type { MediaStoredObjectVerification } from './verification.ts';

/*
 * Reconciliation of an uncertain upload as the ORIGINAL intent (#1434 H2=A, #1447 recovery). The asset row,
 * created by the reserve Action under the invocation's own id, is the anchor: it names the one intended asset, its
 * declared content and its storage key, so a crash in either order (the provider holds bytes the database never
 * recorded, or the database recorded an asset the provider may not hold) is settled against the same row, never a
 * second one. Nothing here is a scheduler: a client or a bound workload calls it, from the same-key retry or the
 * next authorized confirmation, and every call is a fresh decision of the confirm Action under that caller's own
 * authority. There is no retry loop, timer, attempt count or deadline in this file.
 *
 * Exactly three outcomes, and a timeout is none of them by itself:
 * - `completed`: the correct bytes are proven and the row is `ready` (now, or already). The asset id never changes.
 * - `closed_failed`: the original intent is closed as failed, only because the confirm Action proved the stored
 *   bytes differ (or the row was already failed). Only now may a NEW independent upload begin.
 * - `unresolved`: nothing could be proven. The row stays as it is, nothing is guessed, and a new upload is not
 *   yet allowed; the same client may still send the bytes to the same asset and reconcile again.
 */

type ConfirmResult = typeof ConfirmAssetResultSchema.Type;

const isIngestUncertain = Schema.is(MediaIngestUncertain);
const isIntegrityFailed = Schema.is(MediaIntegrityFailed);

/** The row facts reconciliation reads. It never needs, and so never receives, anything else. */
export type ReconcilableMediaAsset = Pick<
  MediaAssetRecord,
  'byteSize' | 'contentSha256' | 'processingStatus' | 'storageKey' | 'storageProvider'
>;

type UnresolvedReason =
  | Extract<MediaStoredObjectVerification, { readonly outcome: 'unverifiable' }>['reason']
  | 'evidence_disagrees'
  /** The row holds a size, digest or key Core could not have written: nothing is read or guessed from it. */
  | 'row_inconsistent'
  | 'state_not_recoverable';

export type MediaUploadReconciliation =
  | {
      readonly byteSize: MediaByteSize;
      readonly contentSha256: MediaContentSha256;
      readonly outcome: 'completed';
    }
  | { readonly outcome: 'closed_failed' }
  | { readonly outcome: 'unresolved'; readonly reason: UnresolvedReason };

export interface ReconcileUploadInput<Failure extends { readonly _tag: string }, Requirements> {
  readonly asset: ReconcilableMediaAsset;
  /**
   * Runs the confirm Action with the given evidence, under the caller's own principal. It is where the original
   * authorization conditions are decided again: a denial or an unavailable decision is its failure, and the row
   * stays untouched.
   */
  readonly confirm: (
    verification: MediaStoredObjectVerification,
  ) => Effect.Effect<ConfirmResult, Failure | MediaIngestUncertain | MediaIntegrityFailed, Requirements>;
}

const SealedIdentitySchema = Schema.Struct({ byteSize: MediaByteSizeSchema, contentSha256: MediaContentSha256Schema });

const conciliated = (reconciliation: MediaUploadReconciliation, storageKey: string) =>
  logMediaRecovery({
    category: reconciliation.outcome,
    operation: 'reconcile',
    ref: mediaRecoveryRef(storageKey),
  }).pipe(Effect.as(reconciliation));

const unresolvedFor = (verification: MediaStoredObjectVerification): UnresolvedReason =>
  verification.outcome === 'unverifiable' ? verification.reason : 'evidence_disagrees';

/**
 * Settles one uploaded asset against the real provider and the database, through the confirm Action only:
 * `ready` and `failed` rows are answered from the row the caller read: a succeeded or closed intent never runs again and
 * the provider is not asked. The confirm Action's conditional update, not that snapshot, arbitrates any change, and a
 * `failed` row is final whether it was closed as an upload or later by proven corruption. An `uploaded` row is read back
 * from the provider and judged by the Action. A row holding a value Core could not have written is `row_inconsistent`.
 */
export const reconcileUncertainUpload = Effect.fn('MediaReconciliation.reconcile')(function* reconcileUncertainUpload<
  Failure extends { readonly _tag: string },
  Requirements,
>(input: ReconcileUploadInput<Failure, Requirements>) {
  const { asset } = input;
  if (asset.processingStatus === 'ready') {
    const sealed = yield* Schema.decodeUnknownEffect(SealedIdentitySchema)({
      byteSize: Number(asset.byteSize),
      contentSha256: asset.contentSha256,
    }).pipe(Effect.option);
    return yield* Option.match(sealed, {
      onNone: () => conciliated({ outcome: 'unresolved', reason: 'row_inconsistent' }, asset.storageKey),
      onSome: (identity) => conciliated({ ...identity, outcome: 'completed' }, asset.storageKey),
    });
  }
  if (asset.processingStatus === 'failed') {
    return yield* conciliated({ outcome: 'closed_failed' }, asset.storageKey);
  }
  if (asset.processingStatus !== 'uploaded') {
    return yield* conciliated({ outcome: 'unresolved', reason: 'state_not_recoverable' }, asset.storageKey);
  }
  const storageKey = yield* Schema.decodeUnknownEffect(MediaStorageKeySchema)(asset.storageKey).pipe(Effect.option);
  if (Option.isNone(storageKey)) {
    return yield* conciliated({ outcome: 'unresolved', reason: 'row_inconsistent' }, asset.storageKey);
  }
  const verification = yield* verifyStoredMediaObject({
    expected: { byteSize: Number(asset.byteSize), contentSha256: asset.contentSha256 ?? undefined },
    storageKey: storageKey.value,
    storageProvider: asset.storageProvider,
  });
  return yield* input.confirm(verification).pipe(
    Effect.flatMap(({ byteSize, contentSha256 }) =>
      conciliated({ byteSize, contentSha256, outcome: 'completed' }, asset.storageKey),
    ),
    Effect.catchIf(isIngestUncertain, () =>
      conciliated({ outcome: 'unresolved', reason: unresolvedFor(verification) }, asset.storageKey),
    ),
    Effect.catchIf(isIntegrityFailed, () => conciliated({ outcome: 'closed_failed' }, asset.storageKey)),
  );
});
