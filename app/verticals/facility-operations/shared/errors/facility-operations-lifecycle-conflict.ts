import { Schema } from 'effect';

export class FacilityOperationsLifecycleConflict extends Schema.TaggedError<FacilityOperationsLifecycleConflict>()(
  'FacilityOperationsLifecycleConflict',
  {
    code: Schema.Literal('facility_operations_lifecycle_conflict'),
    reason: Schema.String,
  },
) {}
