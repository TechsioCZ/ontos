import { Schema } from 'effect';

export class PropertyUnavailable extends Schema.TaggedError<PropertyUnavailable>()('PropertyUnavailable', {
  cause: Schema.optionalKey(Schema.Defect()),
  code: Schema.Literal('property_unavailable'),
  reason: Schema.String,
}) {}
