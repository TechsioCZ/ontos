// fallow-ignore-file code-duplication -- Owner-local protocol code intentionally mirrors its peer owner while preserving separate deployment and persistence authority.
/* jscpd:ignore-start -- Owner-local protocol code intentionally mirrors its peer owner while preserving separate deployment and persistence authority. */
import { OwnerExecutionOutcomeSchema, PrivacyMeasureHandoffSchema } from '@app/privacy/domain/privacy-measure-handoff';
import { Schema } from 'effect';

export const ExecutePrivacyMeasurePayloadSchema = Schema.Struct({ handoff: PrivacyMeasureHandoffSchema });
export type ExecutePrivacyMeasurePayload = typeof ExecutePrivacyMeasurePayloadSchema.Type;

export { OwnerExecutionOutcomeSchema as ExecutePrivacyMeasureResultSchema } from '@app/privacy/domain/privacy-measure-handoff';

export const ExecutePrivacyMeasureAuditEvidenceSchema = Schema.Struct({
  evidenceRefs: Schema.Array(Schema.String),
  measureId: Schema.toEncoded(Schema.String.pipe(Schema.brand('PrivacyMeasureId'))),
  outcomeId: Schema.toEncoded(Schema.String.pipe(Schema.brand('PrivacyOutcomeId'))),
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
/* jscpd:ignore-end */
