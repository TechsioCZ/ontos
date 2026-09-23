import { Schema } from 'effect';

export class VariantActionNotFound extends Schema.TaggedError<VariantActionNotFound>()('VariantActionNotFound', {
  code: Schema.Literal('variant_action_not_found'),
  reason: Schema.String,
}) {}
