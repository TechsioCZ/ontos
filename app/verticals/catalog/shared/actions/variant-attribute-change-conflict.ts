import { Schema } from 'effect';

export class VariantAttributeChangeConflict extends Schema.TaggedError<VariantAttributeChangeConflict>()(
  'VariantAttributeChangeConflict',
  { code: Schema.Literal('variant_attribute_change_conflict'), reason: Schema.String },
) {}
