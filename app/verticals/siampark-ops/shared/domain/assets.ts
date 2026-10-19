// Siampark provoz — agenda `assets` (S02 majetek a inventura + S03 odpisy).
// OWNED BY THE `assets` LANE. Change freely; keep exporting AssetsStateSchema and emptyAssetsState.
// Old JSONB rows must still decode: add new fields as `Schema.optionalKey(...)` or reseed (pnpm demo:seed:siampark-ops).
import { Schema } from 'effect';
import { AuditFieldsSchema, NoteSchema, PropertyRefSchema, TextSchema, opsIdOf } from './common.ts';

export const AssetIdSchema = opsIdOf('SiamparkAssetId');
export type AssetId = typeof AssetIdSchema.Type;

export const AssetSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  id: AssetIdSchema,
  inventoryNumber: TextSchema(64),
  name: TextSchema(200),
  category: TextSchema(120),
  location: Schema.optionalKey(PropertyRefSchema),
  note: Schema.optionalKey(NoteSchema),
});
export type Asset = typeof AssetSchema.Type;

export const AssetsStateSchema = Schema.Struct({
  assets: Schema.Array(AssetSchema),
});
export type AssetsState = typeof AssetsStateSchema.Type;
export type AssetsStateEncoded = typeof AssetsStateSchema.Encoded;

/** State written by the seed when nothing else is known. Must decode with AssetsStateSchema. */
export const emptyAssetsState: AssetsStateEncoded = { assets: [] };
