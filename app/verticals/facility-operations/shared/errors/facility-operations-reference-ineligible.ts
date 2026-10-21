import { Schema } from 'effect';

export class FacilityOperationsReferenceIneligible extends Schema.TaggedError<FacilityOperationsReferenceIneligible>()(
  'FacilityOperationsReferenceIneligible',
  {
    code: Schema.Literal('facility_operations_reference_ineligible'),
    reason: Schema.String,
  },
) {}
