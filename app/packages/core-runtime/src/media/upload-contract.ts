import { Schema } from 'effect';

import { MediaAssetRefSchema } from '../resources/media-asset.ts';
import { MediaByteSizeSchema, MediaContentSha256Schema, MediaIngestionSourceSchema } from './public-contract.ts';

/*
 * The public shapes of the two short upload Actions (reserve, then confirm). The bytes never appear in either:
 * they travel on the byte hop between them, outside any Core transaction.
 */

/** Control characters (NUL included, which PostgreSQL text cannot hold) have no place in any recorded name. */
const CONTROL_CHARACTER = /\p{Cc}/u;
/** Bidirectional overrides and isolates: they let a name display as something it is not. */
const BIDIRECTIONAL_CONTROL = /[‪-‮⁦-⁩]/u;
const PATH_SEPARATOR = /[/\\]/u;

const isRecordedText = Schema.makeFilter<string>((value) => {
  if (value.trim().length === 0) {
    return 'Must not be blank';
  }
  return CONTROL_CHARACTER.test(value) ? 'Must not contain control characters' : undefined;
});

/**
 * The mandatory presentation name. "Safe" is read as: not blank, no control or bidirectional-override
 * character, no path separator, and not a relative path component. It is a rule about the name, not a
 * product limit, so there is deliberately no length cap here; the rename Action reuses this one schema.
 */
export const MediaDisplayFilenameSchema = Schema.String.check(
  isRecordedText,
  Schema.makeFilter<string>((value) => {
    if (PATH_SEPARATOR.test(value) || value === '.' || value === '..') {
      return 'Must be a plain file name, not a path';
    }
    return BIDIRECTIONAL_CONTROL.test(value) ? 'Must not contain bidirectional override characters' : undefined;
  }),
).pipe(Schema.brand('MediaDisplayFilename'));
export type MediaDisplayFilename = typeof MediaDisplayFilenameSchema.Type;

/** The honest origin name as the source gave it: recorded, never rewritten and never invented. */
const MediaOriginalFilenameSchema = Schema.String.check(isRecordedText);

/** The recorded type. It is a claim, not proof; there is no allowlist and no syntax rule beyond being text. */
const MediaMimeTypeSchema = Schema.String.check(isRecordedText);

const ExternalSourceRefSchema = Schema.String.check(isRecordedText);

/**
 * PROPOSED DEFAULT (ratification pending): a reservation declares the size and SHA-256 of the file it is about
 * to receive. They fix the content identity before any byte moves, so a replay with other bytes is a conflict.
 * This is the single place that makes them required; relaxing the default means making these two optional here
 * and leaving the reservation without a digest claim.
 */
const DeclaredContentFields = {
  declaredByteSize: MediaByteSizeSchema,
  declaredContentSha256: MediaContentSha256Schema,
} as const;

/**
 * What the caller states about the file. Tenant, company, principal, storage identity and the asset id come
 * from the trusted scope and the reservation itself, never from here, and no business target is named: a
 * reservation creates no link and no assignment.
 */
export const UploadAssetPayloadSchema = Schema.Struct({
  ...DeclaredContentFields,
  displayFilename: MediaDisplayFilenameSchema,
  externalSourceRef: Schema.optionalKey(ExternalSourceRefSchema),
  ingestionSource: MediaIngestionSourceSchema,
  mimeType: MediaMimeTypeSchema,
  originalFilename: Schema.optionalKey(MediaOriginalFilenameSchema),
});
export type UploadAssetPayload = typeof UploadAssetPayloadSchema.Type;

/** A reservation is not an upload success: the asset exists as `uploaded` and is not usable. */
export const UploadAssetResultSchema = Schema.Struct({
  mediaAssetRef: MediaAssetRefSchema,
  processingStatus: Schema.Literal('uploaded'),
});
export type UploadAssetResult = typeof UploadAssetResultSchema.Type;

export const ConfirmAssetPayloadSchema = Schema.Struct({
  mediaAssetRef: MediaAssetRefSchema,
});
export type ConfirmAssetPayload = typeof ConfirmAssetPayloadSchema.Type;

/** The only success of an upload: the asset is `ready`, with the size and SHA-256 of the stored bytes. */
export const ConfirmAssetResultSchema = Schema.Struct({
  byteSize: MediaByteSizeSchema,
  contentSha256: MediaContentSha256Schema,
  mediaAssetRef: MediaAssetRefSchema,
  processingStatus: Schema.Literal('ready'),
});
export type ConfirmAssetResult = typeof ConfirmAssetResultSchema.Type;
