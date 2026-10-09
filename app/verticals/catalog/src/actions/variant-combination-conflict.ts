import { Schema } from 'effect';

import { AttributeDefinitionRefSchema } from '../../shared/resources/attribute-definition.ts';

/** A definite #440 confirmation rejection; an unavailable basis stays a separate failure. */
export class VariantCombinationConflict extends Schema.TaggedError<VariantCombinationConflict>()(
  'VariantCombinationConflict',
  {
    attributeDefinitionId: Schema.optionalKey(AttributeDefinitionRefSchema.fields.resourceId),
    code: Schema.Literal('variant_combination_conflict'),
    conflict: Schema.Literals([
      'DUPLICATE',
      'MISSING_AXIS',
      'IMPERMISSIBLE',
      'STALE_BASIS',
      'REVISION',
      'LIFECYCLE',
      'INVALID_CHANGE',
    ]),
    reason: Schema.String,
  },
) {}
