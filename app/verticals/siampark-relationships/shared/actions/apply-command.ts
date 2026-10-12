import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Schema } from 'effect';
import { ActivityScopeMismatch } from '../errors/activity-scope-mismatch.ts';
import { ActivityRevisionConflict } from '../errors/activity-revision-conflict.ts';
import { ActivityPersistenceUnavailable } from '../errors/activity-persistence-unavailable.ts';
import { ActivityReferenceUnavailable } from '../errors/activity-reference-unavailable.ts';
import { ActivityReferenceIneligible } from '../errors/activity-reference-ineligible.ts';
import { ActivityPermissionDenied } from '../errors/activity-permission-denied.ts';
import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import { PartyRefSchema } from '@app/party-registry/resources/party';
import { TaskRefSchema } from '@app/siampark-work/resources/task';
import { ActivityKindSchema, ActivitySchema, ContextRefSchema } from '../apis/records.ts';

export const ActivityCommandSchema = Schema.TaggedStruct('RecordActivity', {
  contextRefs: Schema.optionalKey(Schema.Array(ContextRefSchema).check(Schema.isMaxLength(12))),
  counterpartyRef: Schema.optionalKey(CounterpartyRefSchema),
  followUpTaskRef: Schema.optionalKey(TaskRefSchema),
  kind: ActivityKindSchema,
  occurredAt: Schema.DateTimeUtcFromString,
  ownerPrincipalRef: PrincipalRefSchema,
  partyRef: Schema.optionalKey(PartyRefSchema),
  summary: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
}).check(
  Schema.makeFilter((command) =>
    command.partyRef !== undefined || command.counterpartyRef !== undefined
      ? undefined
      : 'Activity must identify a Party or Counterparty',
  ),
);
export type ActivityCommand = typeof ActivityCommandSchema.Type;
export const ApplyCommandPayloadSchema = Schema.Struct({
  command: ActivityCommandSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ApplyCommandPayload = typeof ApplyCommandPayloadSchema.Type;
export const ApplyCommandResultSchema = Schema.Struct({ activity: ActivitySchema, revision: Schema.Int });
export const ActivityErrorSchema = Schema.Union([
  ActivityScopeMismatch,
  ActivityRevisionConflict,
  ActivityPersistenceUnavailable,
  ActivityReferenceUnavailable,
  ActivityReferenceIneligible,
  ActivityPermissionDenied,
]);
export type ActivityError = typeof ActivityErrorSchema.Type;
export { ActivityScopeMismatch } from '../errors/activity-scope-mismatch.ts';
export { ActivityRevisionConflict } from '../errors/activity-revision-conflict.ts';
export { ActivityPersistenceUnavailable } from '../errors/activity-persistence-unavailable.ts';
export { ActivityReferenceUnavailable } from '../errors/activity-reference-unavailable.ts';
export { ActivityReferenceIneligible } from '../errors/activity-reference-ineligible.ts';
export { ActivityPermissionDenied } from '../errors/activity-permission-denied.ts';
