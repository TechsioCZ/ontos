import { Schema } from 'effect';

import { ProcessingActivityLifecycleSchema } from '../domain/processing-activity.ts';
import { PrivacyIsoTimestampSchema } from '../domain/privacy-subject.ts';
import { ProcessingActivityRefSchema } from '../resources/processing-activity.ts';

export { ProcessingActivitySchema as TransitionProcessingActivityResultSchema } from '../domain/processing-activity.ts';

export const TransitionProcessingActivityPayloadSchema = Schema.Struct({
  activityRef: ProcessingActivityRefSchema,
  decisionEvidenceRefs: Schema.Array(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
  effectiveAt: PrivacyIsoTimestampSchema,
  to: ProcessingActivityLifecycleSchema,
});
export type TransitionProcessingActivityPayload = typeof TransitionProcessingActivityPayloadSchema.Type;
