import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Effect, Stream } from 'effect';
import { Hex } from 'effect/encoding';

import type { MediaAssetRef } from '../resources/media-asset.ts';
import { streamMediaObject } from './byte-stream.ts';
import type { MediaByteSourceOffer } from './byte-source-contract.ts';
import {
  MediaContentConflict,
  MediaIngestUncertain,
  MediaIntegrityFailed,
  MediaLengthRequired,
  mediaAssetNotFound,
} from './errors.ts';
import { reconcileUncertainUpload } from './reconciliation.ts';
import { deriveMediaStorageKey } from './storage-key.ts';
import type { ConfirmAssetResultSchema } from './upload-contract.ts';
import type { MediaStoredObjectVerification } from './verification.ts';

/*
 * The byte-ingress half of an upload (#1433): everything between "the host ran the byte-source Read" and "the asset
 * is `ready`". The host hands over the reserved row the Read offered, the request body as a stream and the one thing
 * only it can do, running the confirm Action under the caller's own principal. Nothing here holds a Core transaction
 * while bytes move, and nothing survives the request.
 *
 *  1. The byte hop (`streamMediaObject`) authorizes the move by the row and the reserving principal, then streams
 *     the body into the provider. The body is never buffered whole here and the digest is the platform's.
 *  2. Whatever the hop ended with (stored, already stored, or uncertain), the stored object is then judged by the
 *     same reconciliation a recovery uses: read back, verified, and sealed by the confirm Action. So a retry after
 *     an uncertain end completes the ORIGINAL asset, never a second one.
 *  3. Only `ready` is a success. A proven mismatch is an integrity failure, anything not provable is uncertain.
 */

type ConfirmResult = typeof ConfirmAssetResultSchema.Type;

export interface IngestMediaBytesInput<BodyError, ConfirmFailure extends { readonly _tag: string }, ConfirmServices> {
  /** The reserved row the byte-source Read offered, read in the trusted tenant scope. */
  readonly asset: MediaByteSourceOffer;
  readonly body: Stream.Stream<Uint8Array, BodyError>;
  /** Runs the confirm Action with the given evidence under the caller's own principal. */
  readonly confirm: (
    verification: MediaStoredObjectVerification,
  ) => Effect.Effect<ConfirmResult, ConfirmFailure | MediaIngestUncertain | MediaIntegrityFailed, ConfirmServices>;
  /** The request's own `Content-Length`; undefined when it stated none. */
  readonly contentLength: number | undefined;
  readonly mediaAssetRef: MediaAssetRef;
  /** The authenticated caller. The hop refuses everyone but the principal that reserved the asset. */
  readonly principalId: string;
  /** The company the caller selected, if any: an asset reserved in another company is not found. */
  readonly selectedLegalEntityId?: string | undefined;
}

/** The headers of an upload answer: private, never cached, never sniffed. They are the only ones the edge sets. */
export const uploadResponseHeaders = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
} as const;

/**
 * The request of the confirm Action for one ATTEMPT to complete an asset. Each request of the edge is its own fresh
 * decision: a key shared by every attempt would replay a refusal (a caller who lacked the capability once, or whose
 * evidence was unprovable) as the answer of every later one. The attempt is the caller's own freshness (its
 * correlation and a clock reading), and nothing is lost by it: the asset row arbitrates, the Action's transition is
 * conditional, and a retry that finds the asset sealed follows the row instead of sealing it again.
 */
export const confirmAssetRequest = (mediaAssetRef: MediaAssetRef, attempt: string) => ({
  idempotencyKey: Hex.encode(
    sha256(utf8ToBytes(`core.media.confirm\0${mediaAssetRef.tenantId}\0${mediaAssetRef.resourceId}\0${attempt}`)),
  ),
  payload: { mediaAssetRef },
});

const CONTENT_LENGTH = /^[0-9]{1,16}$/u;

/** The exact length a request states, or undefined when it states none or something that is not a length. */
export const parseContentLength = (header: string | undefined): number | undefined =>
  header !== undefined && CONTENT_LENGTH.test(header) ? Number(header) : undefined;

/**
 * The body behind its length rule. The rule runs when the hop first pulls the body, which is after the hop's own
 * checks (reserving principal, state, provider), so a caller that may not send bytes learns nothing about the
 * reserved size. A body of unstated length is `411`; a stated length other than the reserved size is a conflict,
 * and either way no byte reaches the provider.
 */
const lengthCheckedBody = <BodyError>(
  asset: MediaByteSourceOffer,
  body: Stream.Stream<Uint8Array, BodyError>,
  contentLength: number | undefined,
) =>
  Stream.unwrap(
    Effect.gen(function* checkLength() {
      if (contentLength === undefined) {
        return yield* new MediaLengthRequired({
          code: 'media_length_required',
          reason: 'The request must state the exact Content-Length of the file',
        });
      }
      if (contentLength !== Number(asset.byteSize)) {
        return yield* new MediaContentConflict({
          code: 'media_content_conflict',
          reason: 'The stated Content-Length differs from the size the asset was reserved with',
        });
      }
      return body;
    }),
  );

export const ingestMediaBytes = Effect.fn('MediaIngest.ingest')(function* ingestMediaBytes<
  BodyError,
  ConfirmFailure extends { readonly _tag: string },
  ConfirmServices,
>(input: IngestMediaBytesInput<BodyError, ConfirmFailure, ConfirmServices>) {
  const { asset } = input;
  // The row must be the very asset the caller named, in the caller's tenant: its storage key is a pure function of
  // that identity, so a row offered for another tenant or another asset id never gets a byte written to its key.
  const namedKey = deriveMediaStorageKey({
    mediaAssetId: input.mediaAssetRef.resourceId,
    tenantId: input.mediaAssetRef.tenantId,
  });
  if (asset.storageKey !== namedKey) {
    return yield* mediaAssetNotFound();
  }
  if (
    input.selectedLegalEntityId !== undefined &&
    asset.legalEntityId !== null &&
    asset.legalEntityId !== input.selectedLegalEntityId
  ) {
    return yield* mediaAssetNotFound();
  }
  // A body that breaks mid-flight (a dropped connection, a short body) is a transfer that did not finish: the put
  // aborts and leaves nothing readable, and the stored object is judged by the verification below.
  const body = lengthCheckedBody(
    asset,
    input.body.pipe(
      Stream.mapError(
        () =>
          new MediaIngestUncertain({
            code: 'media_ingest_uncertain',
            reason: 'The request body did not arrive completely',
          }),
      ),
    ),
    input.contentLength,
  );
  yield* streamMediaObject({ asset, body, principalId: input.principalId }).pipe(
    // Whether the bytes are stored is unknown, not "not stored": the reconciliation below reads the object back.
    Effect.catchTag('MediaIngestUncertain', () => Effect.void),
  );
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
