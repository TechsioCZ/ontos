import { Schema } from 'effect';

export class CommercePortalAuthStepUpUnavailable extends Schema.TaggedError<CommercePortalAuthStepUpUnavailable>()(
  'CommercePortalAuthStepUpUnavailable',
  {
    operation: Schema.String,
    reason: Schema.String,
  },
) {}
