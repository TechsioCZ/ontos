import { Schema } from 'effect';

export class FacilityOperationsReferenceUnavailable extends Schema.TaggedError<FacilityOperationsReferenceUnavailable>()(
  'FacilityOperationsReferenceUnavailable',
  {
    code: Schema.Literal('facility_operations_reference_unavailable'),
    reason: Schema.String,
  },
) {}
