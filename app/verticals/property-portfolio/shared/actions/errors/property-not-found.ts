import { Schema } from 'effect';

export class PropertyNotFound extends Schema.TaggedError<PropertyNotFound>()('PropertyNotFound', {
  code: Schema.Literal('property_not_found'),
  reason: Schema.String,
}) {}
