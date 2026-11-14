import { Schema } from 'effect';

export class PropertyConflict extends Schema.TaggedError<PropertyConflict>()('PropertyConflict', {
  code: Schema.Literal('property_conflict'),
  reason: Schema.String,
}) {}
