import { Schema } from 'effect';

export class CommercePortalAuthStepUpRejected extends Schema.TaggedError<CommercePortalAuthStepUpRejected>()(
  'CommercePortalAuthStepUpRejected',
  {
    reason: Schema.String,
  },
) {}
