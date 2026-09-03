import { Schema } from 'effect';
import { PartyRefSchema } from '../resources/party.ts';

export const MergeReadinessBlockerCodeSchema = Schema.Literals([
  'PRODUCTION_MERGE_DISABLED',
  'PREPARED_STATE_UNAVAILABLE',
  'AUTHORITATIVE_IDENTITY_CONFLICT',
  'COUNTERPARTY_COLLISION',
  'CONSUMER_PROFILE_COLLISION',
  'CONNECTOR_CORRELATION_COLLISION',
  'UNSUPPORTED_REFERENCE_CLASS',
  'CONSUMER_RECONCILIATION_UNPROVEN',
  'CONSUMER_PARTIAL_RETRY_UNPROVEN',
  'WRONG_MERGE_RECOVERY_UNPROVEN',
  'CROSS_TENANT_MERGE_SET',
  'DUPLICATE_SET_NOT_CONFIRMED',
  'INVALID_MERGE_SET',
  'COUNTERPARTY_ROLE_PERIOD_COLLISION',
  'RELATIONSHIP_PERIOD_COLLISION',
  'RELATIONSHIP_SELF_REFERENCE',
  'STRONG_IDENTIFIER_CONFLICT',
]);
export type MergeReadinessBlockerCode = typeof MergeReadinessBlockerCodeSchema.Type;

export const MergeReadinessBlockerSchema = Schema.Struct({
  code: MergeReadinessBlockerCodeSchema,
  detail: Schema.String.check(Schema.isMinLength(1)),
  ownerKey: Schema.String.check(Schema.isMinLength(1)),
});
export type MergeReadinessBlocker = typeof MergeReadinessBlockerSchema.Type;

export const MergeReadinessResultSchema = Schema.Struct({
  analysis: Schema.Struct({
    collisionCodes: Schema.Array(MergeReadinessBlockerCodeSchema),
    referencePlanStatus: Schema.Literals(['BLOCKED', 'PLANNED']),
    selectedSurvivorPartyRef: Schema.NullOr(PartyRefSchema),
    selectionStatus: Schema.Literals(['BLOCKED', 'SELECTED']),
  }),
  blockers: Schema.Array(MergeReadinessBlockerSchema).check(Schema.isMinLength(1)),
  mergeExecutionEnabled: Schema.Literal(false),
  partyRefs: Schema.Array(PartyRefSchema).check(Schema.isMinLength(2)),
  status: Schema.Literal('DISABLED'),
});
export type MergeReadinessResult = typeof MergeReadinessResultSchema.Type;
