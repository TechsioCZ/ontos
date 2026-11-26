import { Effect, Schema, Stream } from 'effect';

import { actionErrorSchema } from '../actions/error-schema.ts';
import type { AssetDownloadAuthorization } from './download-contract.ts';
import { MediaIntegrityFailed, MediaNotReady, mediaUnavailable } from './errors.ts';
import { MediaIntegrityRecorder } from './integrity-recorder.ts';
import { logMediaRecovery, mediaRecoveryRef } from './recovery-log.ts';
import { openVerifiedMediaStream, statRecordedObject, verifyReadyMediaAsset } from './verified-read.ts';
import type { MediaVerifiableAsset, MediaUnverifiedRead } from './verified-read.ts';

/*
 * The byte half of the governed download of one Media Asset (#1443, #1436 H1=A). It runs only after the governed
 * `download` Read allowed THIS request (the host runs the Read, offers its stored-object facts here, and calls
 * `streamConfirmedBytes`). Nothing survives a request: no URL, no ticket, no token, no cache entry, no decision.
 * Reconnecting, retrying or asking for a range is another request and another decision; a transfer already
 * authorized at its start may finish after the Permission is revoked, because no further decision is taken while
 * it streams (it ends by completion, disconnect or a failure only).
 *
 * Distinct outcomes, none of them a guess:
 * - Before the first byte: `MediaNotReady`, `MediaUnavailable` (provider outage, missing object, doubtful
 *   framing: request level, nothing durable) and `MediaIntegrityFailed` (proven corruption, 422).
 * - After the first byte only an abort is possible: the stream ends with `MediaDownloadAborted`, never cleanly.
 *   Only a fully read object of another size or digest than the sealed identity is corruption; it is handed to the
 *   integrity Action (a read never changes status), and a short, doubtful or interrupted read is not.
 */

export class MediaDownloadAborted extends actionErrorSchema('MediaDownloadAborted', {
  code: Schema.Literal('media_download_aborted'),
  reason: Schema.Literals(['integrity_failed', 'missing_object', 'unavailable']),
}) {}

export interface MediaDownload {
  readonly authorization: AssetDownloadAuthorization;
  /** The exact confirmed bytes. A clean end means the whole object verified; any other end is an abort. */
  readonly body: Stream.Stream<Uint8Array, MediaDownloadAborted>;
}

const abortReason = (read: MediaUnverifiedRead): MediaDownloadAborted['reason'] => {
  if (read.outcome === 'integrity_failed') {
    return 'integrity_failed';
  }
  return read.outcome === 'missing_object' ? 'missing_object' : 'unavailable';
};

const corrupt = () =>
  new MediaIntegrityFailed({
    code: 'media_integrity_failed',
    reason: 'The stored bytes do not match the confirmed content',
  });

const reportUnverified = (asset: MediaVerifiableAsset, read: MediaUnverifiedRead) =>
  logMediaRecovery({
    category: read.outcome,
    operation: 'verified_read',
    providerFailure: read.outcome === 'unavailable' ? read.providerFailure : undefined,
    ref: mediaRecoveryRef(asset.storageKey),
  });

const isNotReady = (read: MediaUnverifiedRead): boolean =>
  read.outcome === 'inconsistent_metadata' && (read.reason === 'not_ready' || read.reason === 'not_sealed');

const notReady = () =>
  new MediaNotReady({
    code: 'media_not_ready',
    reason: 'The asset is not ready, so its bytes cannot be presented',
  });

const bytesUnavailable = () => mediaUnavailable('The stored bytes are temporarily unavailable');

/**
 * The answer to an allowed request that wants no bytes (HEAD), from a stat alone: not ready, or unavailable for
 * everything a download would refuse before its first byte. It reads no byte, so it never proves corruption and
 * records nothing: where a download reads an object of another size in full and may answer corrupt, this one answers
 * unavailable.
 */
export const checkConfirmedBytes = Effect.fn('MediaDownload.check')(function* checkConfirmedBytes(
  asset: MediaVerifiableAsset,
) {
  yield* statRecordedObject(asset).pipe(
    Effect.catchTag('MediaVerifiedReadInterrupted', ({ read }) =>
      reportUnverified(asset, read).pipe(
        Effect.andThen(Effect.failSync(() => (isNotReady(read) ? notReady() : bytesUnavailable()))),
      ),
    ),
  );
});

/**
 * Everything after the decision: opens the stored object of an allowed request and returns the bytes behind the
 * verifier. `asset` is what the Read offered, `authorization` what it answered.
 */
export const streamConfirmedBytes = Effect.fn('MediaDownload.stream')(function* streamConfirmedBytes(
  asset: MediaVerifiableAsset,
  authorization: AssetDownloadAuthorization,
) {
  const recorder = yield* MediaIntegrityRecorder;
  const { mediaAssetRef } = authorization;
  /** What a refusal before the first byte means to the caller. */
  const refusalBeforeBytes = Effect.fn('MediaDownload.refusal')(function* refusalBeforeBytes(
    read: MediaUnverifiedRead,
  ) {
    if (read.outcome === 'integrity_failed') {
      yield* recorder.record(read.finding, mediaAssetRef);
      return yield* corrupt();
    }
    if (isNotReady(read)) {
      return yield* notReady();
    }
    if (read.outcome === 'inconsistent_metadata' && read.reason === 'declared_size_differs') {
      // The provider declares another object than the confirmed one: only a complete read can prove it. It is
      // read here with nothing delivered, so proven corruption closes the asset and a doubtful read does not.
      const full = yield* verifyReadyMediaAsset(asset);
      if (full.outcome === 'integrity_failed') {
        yield* recorder.record(full.finding, mediaAssetRef);
        return yield* corrupt();
      }
    }
    return yield* bytesUnavailable();
  });

  const opened = yield* openVerifiedMediaStream(asset).pipe(
    Effect.catchTag('MediaVerifiedReadInterrupted', ({ read }) =>
      reportUnverified(asset, read).pipe(Effect.andThen(refusalBeforeBytes(read))),
    ),
  );
  const body = opened.body.pipe(
    Stream.catchTag('MediaVerifiedReadInterrupted', ({ read }) =>
      reportUnverified(asset, read).pipe(
        Effect.andThen(
          read.outcome === 'integrity_failed' ? recorder.record(read.finding, mediaAssetRef) : Effect.void,
        ),
        Effect.andThen(
          Effect.fail(new MediaDownloadAborted({ code: 'media_download_aborted', reason: abortReason(read) })),
        ),
        Stream.fromEffect,
        Stream.drain,
      ),
    ),
  );
  return { authorization, body } satisfies MediaDownload;
});
