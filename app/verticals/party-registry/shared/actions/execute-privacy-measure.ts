/* oxlint-disable unicorn/prefer-export-from -- This Action contract gives the shared owner outcome schema a capability-specific result name. expires: 2027-03-31. */
import { OwnerExecutionOutcomeSchema, PrivacyMeasureHandoffSchema } from '@app/privacy/domain/privacy-measure-handoff';
import { Schema } from 'effect';

export const ExecutePrivacyMeasurePayloadSchema = Schema.Struct({ handoff: PrivacyMeasureHandoffSchema });
export type ExecutePrivacyMeasurePayload = typeof ExecutePrivacyMeasurePayloadSchema.Type;

export const ExecutePrivacyMeasureResultSchema = OwnerExecutionOutcomeSchema;

export const ExecutePrivacyMeasureAuditEvidenceSchema = Schema.Struct({
  evidenceRefs: Schema.Array(Schema.String),
  measureId: Schema.String,
  outcomeId: Schema.String,
  owningCapability: Schema.String,
  sourceDecisionRef: Schema.String,
  sourceDecisionRevision: Schema.Int,
  status: OwnerExecutionOutcomeSchema.fields.status,
});

export class ExecutePrivacyMeasureRejected extends Schema.TaggedError<ExecutePrivacyMeasureRejected>()(
  'ExecutePrivacyMeasureRejected',
  {
    code: Schema.Literals([
      'PRIVACY_MEASURE_SCOPE_MISMATCH',
      'PRIVACY_MEASURE_IDEMPOTENCY_CONFLICT',
      'PRIVACY_MEASURE_PERSISTENCE_UNAVAILABLE',
    ]),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}
