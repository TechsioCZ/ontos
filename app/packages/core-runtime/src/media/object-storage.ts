import { Context, Schema } from 'effect';
import type { Effect, Stream } from 'effect';

import { actionErrorSchema } from '../actions/error-schema.ts';

import type { MediaStorageKey } from './storage-key.ts';

const safeReason = { reason: Schema.String } as const;

// Provider failures carry a stable code and a safe reason only: never a URL, credential, header or provider body.

const ObjectStorageTimeoutValue = actionErrorSchema('ObjectStorageTimeout', {
  code: Schema.Literal('object_storage_timeout'),
  ...safeReason,
});
export type ObjectStorageTimeout = InstanceType<typeof ObjectStorageTimeoutValue>;
export { ObjectStorageTimeoutValue as ObjectStorageTimeout };

const ObjectStorageNetworkErrorValue = actionErrorSchema('ObjectStorageNetworkError', {
  code: Schema.Literal('object_storage_network_error'),
  ...safeReason,
});
export type ObjectStorageNetworkError = InstanceType<typeof ObjectStorageNetworkErrorValue>;
export { ObjectStorageNetworkErrorValue as ObjectStorageNetworkError };

/** The provider answered with a 5xx class failure. */
const ObjectStorageServerErrorValue = actionErrorSchema('ObjectStorageServerError', {
  code: Schema.Literal('object_storage_server_error'),
  ...safeReason,
});
export type ObjectStorageServerError = InstanceType<typeof ObjectStorageServerErrorValue>;
export { ObjectStorageServerErrorValue as ObjectStorageServerError };

/** The provider has no object under the key. Never an absent Media Asset: that is the Core row's decision. */
const ObjectStorageObjectMissingValue = actionErrorSchema('ObjectStorageObjectMissing', {
  code: Schema.Literal('object_storage_object_missing'),
  ...safeReason,
});
export type ObjectStorageObjectMissing = InstanceType<typeof ObjectStorageObjectMissingValue>;
export { ObjectStorageObjectMissingValue as ObjectStorageObjectMissing };

/** The caller asked the provider to verify a SHA-256 and the provider cannot. */
const ObjectStorageChecksumUnsupportedValue = actionErrorSchema('ObjectStorageChecksumUnsupported', {
  code: Schema.Literal('object_storage_checksum_unsupported'),
  ...safeReason,
});
export type ObjectStorageChecksumUnsupported = InstanceType<typeof ObjectStorageChecksumUnsupportedValue>;
export { ObjectStorageChecksumUnsupportedValue as ObjectStorageChecksumUnsupported };

/** The provider verified the requested SHA-256 and the stored bytes differ: proof of a mismatch, not an outage. */
const ObjectStorageChecksumMismatchValue = actionErrorSchema('ObjectStorageChecksumMismatch', {
  code: Schema.Literal('object_storage_checksum_mismatch'),
  ...safeReason,
});
export type ObjectStorageChecksumMismatch = InstanceType<typeof ObjectStorageChecksumMismatchValue>;
export { ObjectStorageChecksumMismatchValue as ObjectStorageChecksumMismatch };

export type ObjectStorageFailure =
  | ObjectStorageChecksumMismatch
  | ObjectStorageChecksumUnsupported
  | ObjectStorageNetworkError
  | ObjectStorageObjectMissing
  | ObjectStorageServerError
  | ObjectStorageTimeout;

export const ObjectStorageFailureSchema = Schema.Union([
  ObjectStorageChecksumMismatchValue,
  ObjectStorageChecksumUnsupportedValue,
  ObjectStorageNetworkErrorValue,
  ObjectStorageObjectMissingValue,
  ObjectStorageServerErrorValue,
  ObjectStorageTimeoutValue,
]);

/** What the provider reports about a stored object. `versionRef` is a technical pin, never a revision. */
export interface ObjectStat {
  readonly byteSize: number;
  readonly versionRef?: string;
}

export interface PutObjectRequest<BodyError> {
  /** The streamed bytes. A failing body fails `put`, and nothing may be left readable under the key. */
  readonly body: Stream.Stream<Uint8Array, BodyError>;
  readonly contentType: string;
  /** Ask the provider to verify this lowercase hex SHA-256; a provider that cannot fails with `ObjectStorageChecksumUnsupported`. */
  readonly expectedSha256?: string;
  readonly key: MediaStorageKey;
}

export interface ObjectBody {
  /** A premature close fails the stream; it never looks like a clean end. */
  readonly body: Stream.Stream<Uint8Array, ObjectStorageFailure>;
  readonly stat: ObjectStat;
}

/**
 * The provider seam of Core Media. It deliberately has no delete and no overwrite-in-place of a confirmed
 * object: which key may be written again is the Media Asset row's decision, not the provider's. No provider SDK
 * is imported here; the real adapter implements this port in its own lane.
 */
export interface ObjectStorageService {
  /** Opens the stored object as a stream with its stat, or fails with the typed provider failure. */
  readonly get: (key: MediaStorageKey) => Effect.Effect<ObjectBody, ObjectStorageFailure>;
  /** A failed put is not proof that nothing was stored: the outcome can be uncertain. */
  readonly put: <BodyError>(
    request: PutObjectRequest<BodyError>,
  ) => Effect.Effect<ObjectStat, BodyError | ObjectStorageFailure>;
  readonly stat: (key: MediaStorageKey) => Effect.Effect<ObjectStat, ObjectStorageFailure>;
}

export class ObjectStorage extends Context.Service<ObjectStorage, ObjectStorageService>()(
  '@app/core-runtime/media/object-storage/ObjectStorage',
) {}
