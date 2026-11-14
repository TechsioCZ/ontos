import { Schema } from 'effect';

export class FacilityOperationsPermissionDenied extends Schema.TaggedError<FacilityOperationsPermissionDenied>()(
  'FacilityOperationsPermissionDenied',
  {
    code: Schema.Literal('facility_operations_permission_denied'),
    reason: Schema.String,
  },
) {}
