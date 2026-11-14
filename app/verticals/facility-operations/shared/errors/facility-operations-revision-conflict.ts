import { Schema } from 'effect';

export class FacilityOperationsRevisionConflict extends Schema.TaggedError<FacilityOperationsRevisionConflict>()(
  'FacilityOperationsRevisionConflict',
  {
    code: Schema.Literal('facility_operations_revision_conflict'),
    reason: Schema.String,
  },
) {}
