import { Effect, Schema } from 'effect';

import { MediaAssetRefSchema } from '../resources/media-asset.ts';
import { mediaUnavailable } from './errors.ts';
import type { MediaUnavailable } from './errors.ts';
import { CORE_MEDIA_ASSET_RESOURCE_TYPE, CORE_MEDIA_MODULE_ID } from './identity.ts';

export const MediaProcessingStatusSchema = Schema.Literals(['uploaded', 'scanning', 'ready', 'failed']);
export type MediaProcessingStatus = typeof MediaProcessingStatusSchema.Type;

/** Provenance only: it labels how the bytes arrived and never changes any permission. */
export const MediaIngestionSourceSchema = Schema.Literals(['user', 'integration', 'import', 'system']);
export type MediaIngestionSource = typeof MediaIngestionSourceSchema.Type;

export const MediaContentSha256Schema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)).pipe(
  Schema.brand('MediaContentSha256'),
);
export type MediaContentSha256 = typeof MediaContentSha256Schema.Type;

/** A byte count the database can hold exactly: a non-negative safe integer, so `BigInt` of it cannot throw. */
export const MediaByteSizeSchema = Schema.Int.check(
  Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
).pipe(Schema.brand('MediaByteSize'));
export type MediaByteSize = typeof MediaByteSizeSchema.Type;

/**
 * Where a processing status may go. `ready` and `failed` are final here: nothing regresses from `ready`, and a
 * proven mismatch is not retried in place. `scanning` is part of the vocabulary but no scanner exists to enter it.
 */
const STATUS_SUCCESSORS = {
  failed: [],
  ready: [],
  scanning: ['ready', 'failed'],
  uploaded: ['scanning', 'ready', 'failed'],
} as const satisfies Record<MediaProcessingStatus, readonly MediaProcessingStatus[]>;

export const canTransitionMediaStatus = (from: MediaProcessingStatus, to: MediaProcessingStatus): boolean =>
  STATUS_SUCCESSORS[from].some((successor) => successor === to);

/** Every status a row may move to `to` from. */
export const mediaStatusesThatMayEnter = (to: MediaProcessingStatus): readonly MediaProcessingStatus[] =>
  MediaProcessingStatusSchema.literals.filter((from) => canTransitionMediaStatus(from, to));

/**
 * The only shape in which an asset's metadata leaves Core. It has no storage provider, storage key, provider
 * version reference, credential or URL, and no revision.
 *
 * `byteSize` and `contentSha256` describe the stored bytes, so they appear only with `contentVerified: true`:
 * the asset is `ready`, its bytes were read back and sealed. Before that, and after a failure, the row holds only
 * what the uploader declared, which is a claim and not a fact, so both values are withheld and
 * `contentVerified` says so explicitly instead of leaving a consumer to infer it from an absent key.
 */
export const MediaAssetMetadataSchema = Schema.Struct({
  byteSize: Schema.optionalKey(MediaByteSizeSchema),
  contentSha256: Schema.optionalKey(MediaContentSha256Schema),
  contentVerified: Schema.Boolean,
  displayFilename: Schema.String,
  ingestionSource: MediaIngestionSourceSchema,
  mediaAssetRef: MediaAssetRefSchema,
  mimeType: Schema.String,
  originalFilename: Schema.optionalKey(Schema.String),
  processingStatus: MediaProcessingStatusSchema,
});
export type MediaAssetMetadata = typeof MediaAssetMetadataSchema.Type;

/** The persisted columns the public projection reads; the storage columns are deliberately not part of it. */
export interface MediaAssetMetadataSource {
  readonly byteSize: bigint;
  readonly contentSha256: string | null;
  readonly displayFilename: string;
  readonly ingestionSource: string;
  readonly mediaAssetId: string;
  readonly mimeType: string;
  readonly originalFilename: string | null;
  readonly processingStatus: string;
  readonly sealedAt: Date | null;
  readonly tenantId: string;
}

/**
 * Projects a persisted asset to its public metadata, failing closed on a value outside the public vocabulary.
 * Verified content is `ready` with a seal and a digest; a `ready` row without them contradicts itself and is
 * refused rather than shown as usable.
 */
export const toMediaAssetMetadata = (
  source: MediaAssetMetadataSource,
): Effect.Effect<MediaAssetMetadata, MediaUnavailable> => {
  const verified = source.processingStatus === 'ready' && source.sealedAt !== null && source.contentSha256 !== null;
  if (source.processingStatus === 'ready' && !verified) {
    return Effect.fail(mediaUnavailable('A ready media asset carries no sealed content identity'));
  }
  const base = {
    contentVerified: verified,
    displayFilename: source.displayFilename,
    ingestionSource: source.ingestionSource,
    // Built plain on purpose: the schema, not a cast, proves both ids are uuids.
    mediaAssetRef: {
      moduleId: CORE_MEDIA_MODULE_ID,
      resourceId: source.mediaAssetId,
      resourceType: CORE_MEDIA_ASSET_RESOURCE_TYPE,
      tenantId: source.tenantId,
    },
    mimeType: source.mimeType,
    processingStatus: source.processingStatus,
  };
  const content = verified ? { ...base, byteSize: Number(source.byteSize), contentSha256: source.contentSha256 } : base;
  const candidate =
    source.originalFilename === null ? content : { ...content, originalFilename: source.originalFilename };
  return Schema.decodeUnknownEffect(MediaAssetMetadataSchema)(candidate).pipe(
    Effect.mapError((cause) => mediaUnavailable('Media asset metadata is not publishable', cause)),
  );
};
