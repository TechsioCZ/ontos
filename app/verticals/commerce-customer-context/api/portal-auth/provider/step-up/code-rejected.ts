import { Schema } from 'effect';

/** Internal verifier result; the public step-up boundary emits one generic rejection outcome. */
export class CommercePortalAuthStepUpCodeRejected extends Schema.TaggedError<CommercePortalAuthStepUpCodeRejected>()(
  'CommercePortalAuthStepUpCodeRejected',
  {
    reason: Schema.String,
  },
) {}
