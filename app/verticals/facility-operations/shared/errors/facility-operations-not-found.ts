import { Schema } from 'effect';

export class FacilityOperationsNotFound extends Schema.TaggedError<FacilityOperationsNotFound>()('FacilityOperationsNotFound', {
  code: Schema.Literal('facility_operations_not_found'),
  reason: Schema.String,
}) {}
