import { Schema } from 'effect';

/** A definite Product-local axis write rejection; no selection was changed. */
export class VariantAxisWriteConflict extends Schema.TaggedError<VariantAxisWriteConflict>()(
  'VariantAxisWriteConflict',
  {
    code: Schema.Literal('variant_axis_write_conflict'),
    conflict: Schema.Literals([
      'NOT_FOUND',
      'REVISION',
      'DEFINITION',
      'TYPE_RULE',
      'ACTIVE_SELECTION',
      'INVALID_INPUT',
      'MISSING_AXIS_VALUE',
      'DUPLICATE_COMBINATION',
      'INVALID_VALUE',
      'UNVERIFIABLE_VALUE',
      'UNRECORDED_COMBINATION',
      'WRONG_PRODUCT',
      'NEW_REALIZATION_REQUIRES_NEW_VARIANT',
      'MEMBERSHIP_TRANSFER_REQUIRES_NEW_VARIANT',
      'MEMBERSHIP_CORRECTION_MUST_CHANGE_PRODUCT',
      'CORRECTION_EVIDENCE_REQUIRED',
      'RETIRED_PARENT_PRODUCT',
      'RETIRED_PACKAGE_OPTION',
      'OPEN_SELECTION_REVALIDATION_REQUIRED',
    ]),
    reason: Schema.String,
  },
) {}
