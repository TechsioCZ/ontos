import { Effect, Schema } from 'effect';

import type { MediaAssetRef } from '../resources/media-asset.ts';
import { mediaAssetNotFound } from './errors.ts';
import type { MediaAssetNotFound } from './errors.ts';

/** Core Media is a Core-owned system capability; this is its owner key (entrypoint `moduleKey`, access-key prefix). */
export const CORE_MEDIA_MODULE_ID = 'core.media';
/** The owner-qualified resource type of one Media Asset; it must start with the module id and a dot. */
export const CORE_MEDIA_ASSET_RESOURCE_TYPE = 'core.media.asset';

const uuid = Schema.String.check(Schema.isUUID());

/** The identity of a Media Asset: an opaque uuid, never a file name, storage key or provider version reference. */
export const MediaAssetIdSchema = uuid.pipe(Schema.brand('MediaAssetId'));
export type MediaAssetId = typeof MediaAssetIdSchema.Type;

export const MediaTenantIdSchema = uuid.pipe(Schema.brand('MediaTenantId'));
export type MediaTenantId = typeof MediaTenantIdSchema.Type;

/** Identity is `(tenantId, mediaAssetId)`: the asset id is unique only within its tenant. */
export const TenantMediaAssetKeySchema = Schema.Struct({
  mediaAssetId: MediaAssetIdSchema,
  tenantId: MediaTenantIdSchema,
});
export type TenantMediaAssetKey = typeof TenantMediaAssetKeySchema.Type;

/**
 * The owner-qualified ref of one Media Asset, branded so a plain string cannot stand in for it. It has exactly
 * the four fields (and the `resourceType`-prefixed-by-`moduleId` rule) a consumer deployment's own ref shape,
 * Catalog's `CatalogDocumentResourceRef`, carries, so a Core ref maps onto it unchanged.
 */
export const CoreMediaOwnerResourceRefSchema = Schema.Struct({
  moduleId: Schema.Literal(CORE_MEDIA_MODULE_ID),
  resourceId: MediaAssetIdSchema,
  resourceType: Schema.Literal(CORE_MEDIA_ASSET_RESOURCE_TYPE),
  tenantId: MediaTenantIdSchema,
});
export type CoreMediaOwnerResourceRef = typeof CoreMediaOwnerResourceRefSchema.Type;

/** The public ref for a trusted key: the only builder, so every ref carries the same owner, type and ids. */
export const mediaAssetRefFor = (key: TenantMediaAssetKey): CoreMediaOwnerResourceRef => ({
  moduleId: CORE_MEDIA_MODULE_ID,
  resourceId: key.mediaAssetId,
  resourceType: CORE_MEDIA_ASSET_RESOURCE_TYPE,
  tenantId: key.tenantId,
});

/**
 * Resolves a client-supplied ref inside the trusted scope tenant. A ref of another tenant fails with the
 * very error a missing asset gets, so a caller cannot probe another tenant's assets.
 */
export const resolveMediaAssetRef = (
  ref: MediaAssetRef,
  scopeTenantId: string,
): Effect.Effect<MediaAssetId, MediaAssetNotFound> =>
  ref.tenantId === scopeTenantId
    ? Schema.decodeUnknownEffect(MediaAssetIdSchema)(ref.resourceId).pipe(Effect.mapError(mediaAssetNotFound))
    : Effect.fail(mediaAssetNotFound());
