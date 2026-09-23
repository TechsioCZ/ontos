import { Schema } from 'effect';

export class SkuActionNotFound extends Schema.TaggedError<SkuActionNotFound>()('SkuActionNotFound', {
  code: Schema.Literal('sku_action_not_found'),
  reason: Schema.String,
}) {}
