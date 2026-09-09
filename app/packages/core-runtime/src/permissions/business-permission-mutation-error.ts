import { Schema } from 'effect';

export class BusinessPermissionMutationUnavailable extends Schema.TaggedError<BusinessPermissionMutationUnavailable>()(
  'BusinessPermissionMutationUnavailable',
  { reason: Schema.String },
) {}
