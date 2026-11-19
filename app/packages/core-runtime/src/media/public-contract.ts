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

export const MediaContentSha256Schema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

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
 * version reference, credential or URL, and no revision. `contentSha256` is present only once the bytes are
 * sealed (confirmed), never as an in-flight claim.
 */
export const MediaAssetMetadataSchema = Schema.Struct({
  byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  contentSha256: Schema.optionalKey(MediaContentSha256Schema),
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

/** Projects a persisted asset to its public metadata, failing closed on a value outside the public vocabulary. */
export const toMediaAssetMetadata = (
  source: MediaAssetMetadataSource,
): Effect.Effect<MediaAssetMetadata, MediaUnavailable> => {
  const base = {
    byteSize: Number(source.byteSize),
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
  // The digest is a claim until the bytes are sealed, so it leaves Core only with `sealedAt`.
  const sealed =
    source.contentSha256 !== null && source.sealedAt !== null ? { ...base, contentSha256: source.contentSha256 } : base;
  const candidate =
    source.originalFilename === null ? sealed : { ...sealed, originalFilename: source.originalFilename };
  return Schema.decodeUnknownEffect(MediaAssetMetadataSchema)(candidate).pipe(
    Effect.mapError((cause) => mediaUnavailable('Media asset metadata is not publishable', cause)),
  );
};
