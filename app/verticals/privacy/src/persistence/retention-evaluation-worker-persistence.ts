/* eslint-disable effect-native/no-nullable-schema-field -- The owner routine returns nullable PostgreSQL columns for not-found and not-due outcomes; expires: 2027-03-31. */
import { defineScopedRoutine } from '@app/core-runtime';
import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime';
import { Schema } from 'effect';

const RetentionWorkStatusSchema = Schema.Literals(['PENDING', 'READY', 'BLOCKED', 'INDETERMINATE', 'COMPLETED']);

const RoutineTimestampSchema = Schema.Union([Schema.Date, Schema.String]);

const RetentionEvaluationRoutineRowSchema = Schema.Struct({
  blocker_refs: Schema.Array(Schema.String),
  evaluated_at: Schema.NullOr(RoutineTimestampSchema),
  outcome: Schema.Literals([
    'EVALUATED',
    'INVALID_INPUT',
    'NOT_DUE',
    'NOT_FOUND',
    'REPLAY',
    'SCOPE_MISMATCH',
    'STATE_AMBIGUOUS',
    'STATE_UNAVAILABLE',
  ]),
  owner_outcome_ref: Schema.NullOr(Schema.String),
  reason: Schema.String,
  status: Schema.NullOr(RetentionWorkStatusSchema),
  work_record: Schema.NullOr(Schema.Unknown),
  work_ref: Schema.NullOr(Schema.String),
});
export type RetentionEvaluationRoutineRow = typeof RetentionEvaluationRoutineRowSchema.Type;

const processRetentionEvaluationRoutine = defineScopedRoutine({
  name: 'process_retention_evaluation_work',
  ownerModuleKey: 'privacy.core',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'timestamptz' },
  ] as const,
  resultSchema: RetentionEvaluationRoutineRowSchema,
  routineKey: 'retention.evaluation-process',
  schema: 'privacy',
});

export const processRetentionEvaluationInScope = (
  scope: OutboxWorkerLegalEntityScope,
  input: {
    readonly evaluatedAt: Date;
    readonly messageId: string;
    readonly workRef: string;
  },
) =>
  scope.routineInvoker.invoke(processRetentionEvaluationRoutine, [input.workRef, input.messageId, input.evaluatedAt]);
