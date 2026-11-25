import { Effect, Schema, Stream } from 'effect';

import { ContentDigest, digestStream } from './content-digest.ts';
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
 * The body, counted and hashed in flight, that FAILS at its clean end unless it is exactly the reserved content.
 * A body that is too long stops at the first chunk past the declared size; a body that ends short or hashes
 * differently fails on its last pull. Because the failure is part of the stream the provider is reading, the
 * `put` aborts and, by the port contract, leaves nothing readable under the key: a retry with wrong bytes
 * cannot replace a correct object that is already stored, and the typed conflict reaches the client.
 */
const reservedContentStream = <BodyError>(
  asset: MediaByteHopAsset,
  body: Stream.Stream<Uint8Array, BodyError>,
  digest: ContentDigest,
  differsFrom: string,
) =>
  digestStream(body, digest, {
    byteSize: Number(asset.byteSize),
    onExceed: () => conflict('The body is longer than the declared size'),
  }).pipe(
    Stream.concat(
      Stream.unwrap(
        digest
          .finish()
          .pipe(
            Effect.map((received) =>
              matchesReservation(asset, received) ? Stream.empty : Stream.fail(conflict(differsFrom)),
            ),
          ),
      ),
    ),
  );

/**
 * Streams the bytes of one reserved asset into the provider, or, for a sealed asset, only compares them.
 *
 * - A request from another principal than the reserving one is refused before a byte is read.
 * - `uploaded`: the bytes go to the row's own key. A body longer than declared stops early; a body that ends
 *   short or hashes differently fails at its end, so the put aborts and the typed conflict goes to the client.
 *   An aborted put leaves nothing readable, so an earlier correct object under the key survives a bad retry and
 *   the confirm step still judges it. `expectedSha256` is not sent: the port has no way to ask whether a
 *   provider can verify it, and a provider that cannot would fail every upload as uncertain.
 * - `ready`: the stored object is never written again. The body is read once to compare: identical bytes are a
 *   harmless replay, different bytes are a conflict.
 * - `failed` and `scanning` accept no bytes.
 * - A provider failure is uncertain, never "nothing stored" and never "failed": the object may be there.
 *
 * Two cases stay provider-dependent: a put that races a sealed `ready` after this hop read the row as
 * `uploaded`, and a same-size overwrite between the verification and the ready commit when the provider reports
 * no `versionRef` (the S3 adapter pins the ETag where there is no version id, so Current then answers
 * unverified for the swapped object). A provider that writes create-only (the S3 adapter does when the deployment states the
 * provider honours `If-None-Match: *`) refuses to replace an existing object with `ObjectStorageObjectExists`,
 * which this hop reports as an uncertain ingest; a provider without it keeps the race open.
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
  const digest = new ContentDigest();

  if (asset.processingStatus === 'ready') {
    yield* Stream.runDrain(
      reservedContentStream(
        asset,
        input.body,
        digest,
        'The bytes differ from the content this asset was confirmed with',
      ),
    );
    return { ...(yield* digest.finish()), kind: 'already_stored' } as const satisfies MediaByteHopResult;
  }

  const counted = reservedContentStream(
    asset,
    input.body,
    digest,
    'The received bytes differ from the declared size or SHA-256',
  );
  const stat = yield* storage
    .put({ body: counted, byteSize: Number(asset.byteSize), contentType: asset.mimeType, key })
    .pipe(
      Effect.catchIf(isObjectStorageFailure, (failure) =>
        Effect.fail(
          new MediaIngestUncertain({
            code: 'media_ingest_uncertain',
            reason: `The provider did not confirm the stored bytes (${failure.code})`,
          }),
        ),
      ),
    );
  return { ...(yield* digest.finish()), kind: 'stored', stat } as const satisfies MediaByteHopResult;
});
