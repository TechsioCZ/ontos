import { Schema } from 'effect';

export class MerchandiseNotFound extends Schema.TaggedError<MerchandiseNotFound>()('MerchandiseNotFound', {
  code: Schema.Literal('merchandise_not_found'),
  reason: Schema.String,
}) {}
