import { Schema } from 'effect';

export class PropertyIneligible extends Schema.TaggedError<PropertyIneligible>()('PropertyIneligible', {
  code: Schema.Literal('property_ineligible'),
  reason: Schema.String,
}) {}
