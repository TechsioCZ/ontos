import { Schema } from 'effect';

export class SkuActionStale extends Schema.TaggedError<SkuActionStale>()('SkuActionStale', {
  actualRevision: Schema.Int,
  code: Schema.Literal('sku_action_stale'),
}) {}
