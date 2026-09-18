import { Schema } from 'effect';

export class CommercePortalAuthStepUpInvalidRequest extends Schema.TaggedError<CommercePortalAuthStepUpInvalidRequest>()(
  'CommercePortalAuthStepUpInvalidRequest',
  {
    reason: Schema.String,
  },
) {}
