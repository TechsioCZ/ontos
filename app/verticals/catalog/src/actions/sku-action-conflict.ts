import { Schema } from 'effect';

export class SkuActionConflict extends Schema.TaggedError<SkuActionConflict>()('SkuActionConflict', {
  code: Schema.Literal('sku_action_conflict'),
  reason: Schema.String,
}) {}
