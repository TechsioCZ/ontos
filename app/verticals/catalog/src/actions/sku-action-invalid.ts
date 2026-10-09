import { Schema } from 'effect';

export class SkuActionInvalid extends Schema.TaggedError<SkuActionInvalid>()('SkuActionInvalid', {
  code: Schema.Literal('sku_action_invalid'),
  reason: Schema.String,
}) {}
