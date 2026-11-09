import { OwnerExecutionOutcomeSchema, PrivacyMeasureHandoffSchema } from '@app/privacy/domain/privacy-measure-handoff';
import { Schema } from 'effect';
import { SymmyJobRetentionResultSchema } from '../domain/symmy-job-retention.ts';

export const ExecuteSymmyRetentionPayloadSchema = Schema.Struct({ handoff: PrivacyMeasureHandoffSchema });
export type ExecuteSymmyRetentionPayload = typeof ExecuteSymmyRetentionPayloadSchema.Type;
export const ExecuteSymmyRetentionResultSchema = Schema.Struct({
  outcome: OwnerExecutionOutcomeSchema,
  status: SymmyJobRetentionResultSchema,
});
export class ExecuteSymmyRetentionRejected extends Schema.TaggedError<ExecuteSymmyRetentionRejected>()(
  'ExecuteSymmyRetentionRejected',
  {
    code: Schema.Literals(['retention_conflict', 'retention_scope_denied', 'retention_unavailable']),
    reason: Schema.String,
  },
) {}
