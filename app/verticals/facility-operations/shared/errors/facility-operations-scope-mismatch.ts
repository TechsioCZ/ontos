import { Schema } from 'effect';

export class FacilityOperationsScopeMismatch extends Schema.TaggedError<FacilityOperationsScopeMismatch>()(
  'FacilityOperationsScopeMismatch',
  {
    code: Schema.Literal('facility_operations_scope_mismatch'),
    reason: Schema.String,
  },
) {}
