import { Effect, Schema, Stream } from 'effect';

import { ContentTally, tallyStream } from './content-tally.ts';
import {
  MediaContentConflict,
  MediaForbidden,
  MediaIngestUncertain,
  MediaIntegrityFailed,
  MediaNotReady,
  mediaUnavailable,
} from './errors.ts';
import { ObjectStorage, ObjectStorageFailureSchema } from './object-storage.ts';
import type { ObjectStat } from './object-storage.ts';
import type { MediaAssetRecord } from './repository.ts';
import type { MediaByteSize, MediaContentSha256 } from './public-contract.ts';
import { MediaStorageKeySchema } from './storage-key.ts';

/*
 * The byte hop of the reserve, stream, confirm shape. It moves the bytes of one reserved asset into the
 * provider and touches no database and no Core transaction: everything it decides comes from the reserved row
 * it is handed and from the stream it counts and hashes while the bytes pass. Whether the stored bytes are
 * what was declared is not decided here; that is verification (read back) and the confirm Action.
 */

/** The reserved row's facts the byte hop reads. It never needs, and so never receives, anything else. */
export type MediaByteHopAsset = Pick<
  MediaAssetRecord,
  | 'byteSize'
  | 'contentSha256'
  | 'ingestedByPrincipalId'
  | 'mimeType'
  | 'processingStatus'
  | 'sealedAt'
  | 'storageKey'
  | 'storageProvider'
>;

export interface MediaByteHopInput<BodyError> {
  /** The reserved row, read in the trusted tenant scope by the caller of the hop. */
  readonly asset: MediaByteHopAsset;
  /** The request body as a stream. It is consumed once, never buffered whole, and only after the checks pass. */
  readonly body: Stream.Stream<Uint8Array, BodyError>;
  /** The principal making this request: the byte hop is bound to the principal that reserved the asset. */
  readonly principalId: string;
}

/** What the hop did. Both variants report the size and digest of the bytes it counted, never a claim. */
export type MediaByteHopResult =
  | {
      readonly byteSize: MediaByteSize;
      readonly contentSha256: MediaContentSha256;
      readonly kind: 'already_stored';
    }
  | {
      readonly byteSize: MediaByteSize;
      readonly contentSha256: MediaContentSha256;
      readonly kind: 'stored';
      readonly stat: ObjectStat;
    };

const conflict = (reason: string) => new MediaContentConflict({ code: 'media_content_conflict', reason });
const isObjectStorageFailure = Schema.is(ObjectStorageFailureSchema);

/**
 * Whether these bytes are the content the reservation fixed. A reservation without a digest claim fixes only
 * the size; the digest of what was received is then reported, not compared.
 */
const matchesReservation = (
  asset: MediaByteHopAsset,
  received: { readonly byteSize: number; readonly contentSha256: string },
): boolean =>
  received.byteSize === Number(asset.byteSize) &&
  (asset.contentSha256 === null || asset.contentSha256 === received.contentSha256);

/**
 * Streams the bytes of one reserved asset into the provider, or, for a sealed asset, only compares them.
 *
 * - A request from another principal than the reserving one is refused before a byte is read.
 * - `uploaded`: the bytes go to the row's own key. A body longer than declared stops early; a body that ends
 *   short or hashes differently is a conflict, and the unconfirmed object under the key is left for the
 *   confirm step to judge or for a corrected retry to overwrite.
 * - `ready`: the stored object is never written again. The body is read once to compare: identical bytes are a
 *   harmless replay, different bytes are a conflict.
 * - `failed` and `scanning` accept no bytes.
 * - A provider failure is uncertain, never "nothing stored" and never "failed": the object may be there.
 */
export const streamMediaObject = Effect.fn('MediaByteHop.stream')(function* streamMediaObject<BodyError>(
  input: MediaByteHopInput<BodyError>,
) {
  const { asset } = input;
  if (asset.ingestedByPrincipalId === null || asset.ingestedByPrincipalId !== input.principalId) {
    return yield* new MediaForbidden({
      code: 'media_forbidden',
      reason: 'Bytes can only be sent by the principal that reserved the asset',
    });
  }
  if (asset.processingStatus === 'failed') {
    return yield* new MediaIntegrityFailed({
      code: 'media_integrity_failed',
      reason: 'The asset failed its integrity check and accepts no bytes',
    });
  }
  if (asset.processingStatus !== 'uploaded' && asset.processingStatus !== 'ready') {
    return yield* new MediaNotReady({
      code: 'media_not_ready',
      reason: 'The asset is not in a state that accepts bytes',
    });
  }
  const storage = yield* ObjectStorage;
  if (storage.providerId !== asset.storageProvider) {
    return yield* mediaUnavailable('The configured storage provider is not the one that holds this asset');
  }
  const key = yield* Schema.decodeUnknownEffect(MediaStorageKeySchema)(asset.storageKey).pipe(
    Effect.mapError((cause) => mediaUnavailable('The asset storage key is not a Core Media key', cause)),
  );
  const tally = new ContentTally();
  const counted = tallyStream(input.body, tally, {
    byteSize: Number(asset.byteSize),
    onExceed: () => conflict('The body is longer than the declared size'),
  });

  if (asset.processingStatus === 'ready') {
    yield* Stream.runDrain(counted);
    const received = tally.finish();
    if (!matchesReservation(asset, received)) {
      return yield* conflict('The bytes differ from the content this asset was confirmed with');
    }
    return { ...received, kind: 'already_stored' } as const satisfies MediaByteHopResult;
  }

  const stat = yield* storage.put({ body: counted, contentType: asset.mimeType, key }).pipe(
    Effect.catchIf(isObjectStorageFailure, (failure) =>
      Effect.fail(
        new MediaIngestUncertain({
          code: 'media_ingest_uncertain',
          reason: `The provider did not confirm the stored bytes (${failure.code})`,
        }),
      ),
    ),
  );
  const received = tally.finish();
  if (!matchesReservation(asset, received)) {
    return yield* conflict('The received bytes differ from the declared size or SHA-256');
  }
  return { ...received, kind: 'stored', stat } as const satisfies MediaByteHopResult;
});
