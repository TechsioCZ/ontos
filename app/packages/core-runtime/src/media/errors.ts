import { Schema } from 'effect';

import { ActionRequestHashConflict } from '../actions/errors.ts';
import { actionErrorSchema } from '../actions/error-schema.ts';

const safeReason = { reason: Schema.String } as const;

/** A definite refusal for this principal. Never used for a tenant mismatch, which is `MediaAssetNotFound`. */
const MediaForbiddenValue = actionErrorSchema('MediaForbidden', {
  code: Schema.Literal('media_forbidden'),
  ...safeReason,
});
export type MediaForbidden = InstanceType<typeof MediaForbiddenValue>;
export { MediaForbiddenValue as MediaForbidden };

/** A required capability (database, access decision, provider) could not answer; a retry may succeed. */
const MediaUnavailableValue = actionErrorSchema('MediaUnavailable', {
  code: Schema.Literal('media_unavailable'),
  ...safeReason,
});
export type MediaUnavailable = InstanceType<typeof MediaUnavailableValue>;
export { MediaUnavailableValue as MediaUnavailable };

/** The asset is absent in the caller's tenant, or it belongs to another tenant: the two are not distinguishable. */
const MediaAssetNotFoundValue = actionErrorSchema('MediaAssetNotFound', {
  code: Schema.Literal('media_asset_not_found'),
  ...safeReason,
});
export type MediaAssetNotFound = InstanceType<typeof MediaAssetNotFoundValue>;
export { MediaAssetNotFoundValue as MediaAssetNotFound };

/**
 * The bytes differ from the content identity the reservation fixed: the declared size or SHA-256, or the digest
 * a sealed asset already holds. It is also the answer when the verification evidence names another object than
 * the asset's own. A caller error, never a silent retry and never an overwrite.
 */
const MediaContentConflictValue = actionErrorSchema('MediaContentConflict', {
  code: Schema.Literal('media_content_conflict'),
  ...safeReason,
});
export type MediaContentConflict = InstanceType<typeof MediaContentConflictValue>;
export { MediaContentConflictValue as MediaContentConflict };

/** The stored bytes were proven not to match the confirmed identity. This is not an absent asset. */
const MediaIntegrityFailedValue = actionErrorSchema('MediaIntegrityFailed', {
  code: Schema.Literal('media_integrity_failed'),
  ...safeReason,
});
export type MediaIntegrityFailed = InstanceType<typeof MediaIntegrityFailedValue>;
export { MediaIntegrityFailedValue as MediaIntegrityFailed };

/** The asset exists but is not `ready` yet, so its bytes must not be presented. */
const MediaNotReadyValue = actionErrorSchema('MediaNotReady', {
  code: Schema.Literal('media_not_ready'),
  ...safeReason,
});
export type MediaNotReady = InstanceType<typeof MediaNotReadyValue>;
export { MediaNotReadyValue as MediaNotReady };

/**
 * The declared size is more than the configured object store can ever write, so no reservation is made: a retry of
 * the same size cannot succeed. It follows from the provider's protocol, never from a product size limit.
 */
const MediaTooLargeValue = actionErrorSchema('MediaTooLarge', {
  code: Schema.Literal('media_too_large'),
  ...safeReason,
});
export type MediaTooLarge = InstanceType<typeof MediaTooLargeValue>;
export { MediaTooLargeValue as MediaTooLarge };

/** Whether the bytes were stored is unknown; the intent stays recoverable, it is neither success nor proof of absence. */
const MediaIngestUncertainValue = actionErrorSchema('MediaIngestUncertain', {
  code: Schema.Literal('media_ingest_uncertain'),
  ...safeReason,
});
export type MediaIngestUncertain = InstanceType<typeof MediaIngestUncertainValue>;
export { MediaIngestUncertainValue as MediaIngestUncertain };

/**
 * A byte upload did not state its length. The body of a reserved asset has exactly the size the reservation fixed,
 * so a request that cannot say how long its body is cannot be carried to the provider (a provider answers a body
 * of unknown length with `411`), and no body is read for it. A caller error, never a product size limit.
 */
const MediaLengthRequiredValue = actionErrorSchema('MediaLengthRequired', {
  code: Schema.Literal('media_length_required'),
  ...safeReason,
});
export type MediaLengthRequired = InstanceType<typeof MediaLengthRequiredValue>;
export { MediaLengthRequiredValue as MediaLengthRequired };

/**
 * Every outcome a Core Media operation may fail with. The idempotency conflict is the Action runtime's
 * own error: Core Media reuses it rather than defining a second request-hash conflict.
 */
export type MediaFailure =
  | ActionRequestHashConflict
  | MediaAssetNotFound
  | MediaContentConflict
  | MediaForbidden
  | MediaIngestUncertain
  | MediaIntegrityFailed
  | MediaLengthRequired
  | MediaNotReady
  | MediaTooLarge
  | MediaUnavailable;

export const MediaFailureSchema = Schema.Union([
  ActionRequestHashConflict,
  MediaAssetNotFoundValue,
  MediaContentConflictValue,
  MediaForbiddenValue,
  MediaIngestUncertainValue,
  MediaIntegrityFailedValue,
  MediaLengthRequiredValue,
  MediaNotReadyValue,
  MediaTooLargeValue,
  MediaUnavailableValue,
]);
export const isMediaFailure = Schema.is(MediaFailureSchema);

/**
 * The HTTP status each failure keeps at a Core Media edge (ERRORS.md): a definite denial is 403, an absent or
 * foreign-tenant asset 404, a state or idempotency conflict 409, a body of unstated length 411, proven corruption or a
 * size the store cannot write 422, and uncertainty 503.
 * The record is keyed by tag, so a new failure cannot be added without choosing its status.
 */
const MEDIA_FAILURE_STATUS = {
  ActionRequestHashConflict: 409,
  MediaAssetNotFound: 404,
  MediaContentConflict: 409,
  MediaForbidden: 403,
  MediaIngestUncertain: 503,
  MediaIntegrityFailed: 422,
  MediaLengthRequired: 411,
  MediaNotReady: 409,
  MediaTooLarge: 422,
  MediaUnavailable: 503,
} as const satisfies Record<MediaFailure['_tag'], number>;

export const mediaFailureStatus = (failure: MediaFailure): (typeof MEDIA_FAILURE_STATUS)[MediaFailure['_tag']] =>
  MEDIA_FAILURE_STATUS[failure._tag];

/** The one safe answer for a missing asset and for another tenant's asset. */
export const mediaAssetNotFound = (): MediaAssetNotFound =>
  new MediaAssetNotFoundValue({ code: 'media_asset_not_found', reason: 'Media asset not found' });

export const mediaUnavailable = (reason: string, cause?: unknown): MediaUnavailable => {
  const failure = new MediaUnavailableValue({ code: 'media_unavailable', reason });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};
