import { Schema } from 'effect';

export class CatalogMediaConflict extends Schema.TaggedError<CatalogMediaConflict>()('CatalogMediaConflict', {
  actualRevision: Schema.optionalKey(Schema.Int),
  code: Schema.Literal('catalog_media_conflict'),
  reason: Schema.String,
}) {}
