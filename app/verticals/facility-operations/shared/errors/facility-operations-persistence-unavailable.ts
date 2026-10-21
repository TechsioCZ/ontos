import { Schema } from 'effect';

export class FacilityOperationsPersistenceUnavailable extends Schema.TaggedError<FacilityOperationsPersistenceUnavailable>()(
  'FacilityOperationsPersistenceUnavailable',
  {
    code: Schema.Literal('facility_operations_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
