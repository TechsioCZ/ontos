import { Effect, Schema } from 'effect';

import type { MediaAssetRef } from '../resources/media-asset.ts';
import { isCallersReservation } from './byte-source-contract.ts';
import type { MediaByteSourceOffer } from './byte-source-contract.ts';
import { MediaIngestUncertain, MediaIntegrityFailed, mediaAssetNotFound } from './errors.ts';
import { reconcileUncertainUpload } from './reconciliation.ts';
import { deriveMediaStorageKey } from './storage-key.ts';
import type { ConfirmAssetResultSchema } from './upload-contract.ts';
import { MediaStoredObjectVerificationSchema } from './verification.ts';
import type { MediaStoredObjectVerification } from './verification.ts';

/*
 * The confirm step of an upload on its own: the client sent its bytes already (or sent them and never learned how it
 * ended) and now asks for the asset to be settled. It is the same reconciliation the byte edge ends with, minus the
 * body, so it completes the ORIGINAL asset and never creates a second one.
 *
 * The caller that may trigger a read-back of the stored object is the principal that reserved the asset, exactly as
 * for the byte hop: a stranger learns nothing of the asset, not even that it exists. The confirm Action is still
 * what decides, under the caller's own capability, for EVERY row: an asset that is already sealed or closed is not
 * answered from the row here, because that would answer without the capability, the idempotency check or the replay
 * re-decision. For such a row the Action needs no evidence about the stored object (it follows the row), so it is
 * handed evidence that proves nothing and the provider is not asked.
 */

type ConfirmResult = typeof ConfirmAssetResultSchema.Type;

export interface ConfirmReservedUploadInput<Failure extends { readonly _tag: string }, Requirements> {
  /** The reserved row the byte-source Read offered, read in the trusted tenant scope. */
  readonly asset: MediaByteSourceOffer;
  /** Runs the confirm Action with the given evidence under the caller's own principal. */
  readonly confirm: (
    verification: MediaStoredObjectVerification,
  ) => Effect.Effect<ConfirmResult, Failure | MediaIngestUncertain | MediaIntegrityFailed, Requirements>;
  readonly mediaAssetRef: MediaAssetRef;
  /** The authenticated caller. Anyone but the principal that reserved the asset does not find it. */
  readonly principalId: string;
  /** The company the caller selected, if any: an asset reserved in another company is not found. */
  readonly selectedLegalEntityId?: string | undefined;
}

export const confirmReservedUpload = Effect.fn('MediaConfirmUpload.confirm')(function* confirmReservedUpload<
  Failure extends { readonly _tag: string },
  Requirements,
>(input: ConfirmReservedUploadInput<Failure, Requirements>) {
  const { asset } = input;
  const namedKey = deriveMediaStorageKey({
    mediaAssetId: input.mediaAssetRef.resourceId,
    tenantId: input.mediaAssetRef.tenantId,
  });
  if (asset.storageKey !== namedKey || !isCallersReservation(asset, input)) {
    return yield* mediaAssetNotFound();
  }
  if (asset.processingStatus !== 'uploaded') {
    const evidence = yield* Schema.decodeUnknownEffect(MediaStoredObjectVerificationSchema)({
      outcome: 'unverifiable',
      providerId: asset.storageProvider,
      reason: 'object_missing',
      storageKey: asset.storageKey,
    }).pipe(Effect.orDie);
    return yield* input.confirm(evidence);
  }
  const reconciliation = yield* reconcileUncertainUpload({ asset, confirm: input.confirm });
  if (reconciliation.outcome === 'completed') {
    return {
      byteSize: reconciliation.byteSize,
      contentSha256: reconciliation.contentSha256,
      mediaAssetRef: input.mediaAssetRef,
      processingStatus: 'ready',
    } as const satisfies ConfirmResult;
  }
  if (reconciliation.outcome === 'closed_failed') {
    return yield* new MediaIntegrityFailed({
      code: 'media_integrity_failed',
      reason: 'The stored bytes do not match the declared content',
    });
  }
  return yield* new MediaIngestUncertain({
    code: 'media_ingest_uncertain',
    reason: `The stored bytes could not be confirmed yet (${reconciliation.reason})`,
  });
});
