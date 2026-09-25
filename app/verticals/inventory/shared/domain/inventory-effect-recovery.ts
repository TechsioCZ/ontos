import { DateTime, Match, Schema } from 'effect';

import {
  InventoryEffectLedgerEffectIdSchema,
  InventoryEffectLedgerIntentSchema,
  InventoryEffectLedgerKindSchema,
  InventoryEffectLedgerRecordSchema,
  InventoryEffectLedgerResolutionSchema,
} from './inventory-effect-ledger.ts';

const instant = Schema.toEncoded(Schema.DateTimeUtcFromString);
const boundedEvidenceRef = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const instantMillis = (value: string): number => DateTime.toEpochMillis(DateTime.makeUnsafe(value));
const occursNoLaterThan = (earlier: string, later: string): boolean => instantMillis(earlier) <= instantMillis(later);

export const InventoryEffectRecoveryFenceSchema = Schema.Literals([
  'PRESERVE_POSSIBLE_PARTIAL_HOLD',
  'BLOCK_RELEASED_STOCK_REUSE',
  'PRESERVE_POSSIBLE_PROTECTION_FENCE',
  'PRESERVE_PHYSICAL_QUANTITY_UNCERTAINTY',
]);
export type InventoryEffectRecoveryFence = typeof InventoryEffectRecoveryFenceSchema.Type;

export const InventoryEffectRecoveryIndeterminateReasonSchema = Schema.Literals([
  'TIMEOUT',
  'MISSING_CALLBACK',
  'WORKER_CRASH',
  'TEMPORARY_NOT_FOUND',
  'OWNER_UNAVAILABLE',
  'TRANSPORT_UNAVAILABLE',
  'PARTIAL_BACKEND_EFFECT',
  'OUTCOME_UNKNOWN',
]);

export const InventoryEffectRecoveryRequestSchema = Schema.Struct({
  effectId: InventoryEffectLedgerEffectIdSchema,
  expectedKind: InventoryEffectLedgerKindSchema,
  tenantId: InventoryEffectLedgerRecordSchema.fields.tenantId,
});
export type InventoryEffectRecoveryRequest = typeof InventoryEffectRecoveryRequestSchema.Type;

const recoveryAuthorityIdentity = {
  effectId: InventoryEffectLedgerEffectIdSchema,
  intent: InventoryEffectLedgerIntentSchema,
  kind: InventoryEffectLedgerKindSchema,
  learnedAt: instant,
} as const;

export const AuthoritativeSuccessInventoryEffectRecoveryObservationSchema = Schema.TaggedStruct(
  'AUTHORITATIVE_SUCCESS',
  {
    ...recoveryAuthorityIdentity,
    occurredAt: instant,
    ownerEvidenceRef: boundedEvidenceRef,
    resolution: InventoryEffectLedgerResolutionSchema,
  },
).check(
  Schema.makeFilter(({ learnedAt, occurredAt }) =>
    occursNoLaterThan(occurredAt, learnedAt) ? undefined : 'Recovery cannot learn an effect before it occurred',
  ),
);
export const DefinitiveNonEffectInventoryEffectRecoveryObservationSchema = Schema.TaggedStruct(
  'DEFINITIVE_NON_EFFECT',
  {
    ...recoveryAuthorityIdentity,
    nonEffectFinal: Schema.Literal(true),
    ownerEvidenceRef: boundedEvidenceRef,
    provenAt: instant,
    resolution: InventoryEffectLedgerResolutionSchema,
  },
).check(
  Schema.makeFilter(({ learnedAt, provenAt }) =>
    occursNoLaterThan(provenAt, learnedAt)
      ? undefined
      : 'Recovery cannot learn definitive non-effect proof before it was established',
  ),
);
export const IndeterminateInventoryEffectRecoveryObservationSchema = Schema.TaggedStruct('INDETERMINATE', {
  ...recoveryAuthorityIdentity,
  occurredAt: Schema.optionalKey(instant),
  reason: InventoryEffectRecoveryIndeterminateReasonSchema,
}).check(
  Schema.makeFilter(({ learnedAt, occurredAt }) =>
    occurredAt === undefined || occursNoLaterThan(occurredAt, learnedAt)
      ? undefined
      : 'An uncertain effect occurrence cannot be later than the recovery observation',
  ),
);
export const InventoryEffectRecoveryAuthorityObservationSchema = Schema.Union([
  AuthoritativeSuccessInventoryEffectRecoveryObservationSchema,
  DefinitiveNonEffectInventoryEffectRecoveryObservationSchema,
  IndeterminateInventoryEffectRecoveryObservationSchema,
]);
export type InventoryEffectRecoveryAuthorityObservation = typeof InventoryEffectRecoveryAuthorityObservationSchema.Type;

const reconciliationDebt = {
  effectId: InventoryEffectLedgerEffectIdSchema,
  fence: InventoryEffectRecoveryFenceSchema,
  kind: InventoryEffectLedgerKindSchema,
  learnedAt: instant,
  possibleEffectOccurred: Schema.Literal(true),
  reconciliationRequired: Schema.Literal(true),
  record: Schema.optionalKey(InventoryEffectLedgerRecordSchema),
  tenantId: InventoryEffectLedgerRecordSchema.fields.tenantId,
} as const;

export const RecoveredInventoryEffectResultSchema = Schema.TaggedStruct('RECOVERED', {
  effectId: InventoryEffectLedgerEffectIdSchema,
  learnedAt: instant,
  occurredAt: instant,
  ownerEvidenceRef: boundedEvidenceRef,
  record: InventoryEffectLedgerRecordSchema,
});
export const DefinitiveNonEffectInventoryEffectResultSchema = Schema.TaggedStruct('DEFINITIVE_NON_EFFECT', {
  effectId: InventoryEffectLedgerEffectIdSchema,
  learnedAt: instant,
  ownerEvidenceRef: boundedEvidenceRef,
  provenAt: instant,
  record: InventoryEffectLedgerRecordSchema,
});
export const AlreadyTerminalInventoryEffectResultSchema = Schema.TaggedStruct('ALREADY_TERMINAL', {
  effectId: InventoryEffectLedgerEffectIdSchema,
  record: InventoryEffectLedgerRecordSchema,
});
export const IndeterminateInventoryEffectResultSchema = Schema.TaggedStruct('INDETERMINATE', {
  ...reconciliationDebt,
  occurredAt: Schema.optionalKey(instant),
  reason: InventoryEffectRecoveryIndeterminateReasonSchema,
});
export type InventoryEffectRecoveryResult =
  | typeof RecoveredInventoryEffectResultSchema.Type
  | typeof DefinitiveNonEffectInventoryEffectResultSchema.Type
  | typeof AlreadyTerminalInventoryEffectResultSchema.Type
  | typeof IndeterminateInventoryEffectResultSchema.Type;

export class InventoryEffectRecoveryRejected extends Schema.TaggedError<InventoryEffectRecoveryRejected>()(
  'InventoryEffectRecoveryRejected',
  {
    code: Schema.Literal('inventory_effect_recovery_rejected'),
    effectId: InventoryEffectLedgerEffectIdSchema,
    reason: Schema.Literals([
      'TENANT_SCOPE_MISMATCH',
      'EFFECT_KIND_MISMATCH',
      'AUTHORITY_IDENTITY_MISMATCH',
      'AUTHORITY_KIND_MISMATCH',
      'AUTHORITY_INTENT_MISMATCH',
      'INVALID_AUTHORITY_OUTCOME',
      'OWNER_EFFECT_NOT_FOUND',
      'OWNER_STATE_CONFLICT',
      'OWNER_PERSISTENCE_UNAVAILABLE',
      'PROTECTION_ESTABLISHED_AFTER_CONFIRMATION_EXPIRY',
      'PROTECTION_PROOF_TIME_MISMATCH',
    ]),
  },
) {}

export const inventoryEffectRecoveryFenceFor = (
  kind: typeof InventoryEffectLedgerKindSchema.Type,
): InventoryEffectRecoveryFence =>
  Match.value(kind).pipe(
    Match.when('RESERVATION_CREATE', () => 'PRESERVE_POSSIBLE_PARTIAL_HOLD' as const),
    Match.when('RESERVATION_RELEASE', () => 'BLOCK_RELEASED_STOCK_REUSE' as const),
    Match.when('ESTABLISH_COMMITMENT_PROTECTION', () => 'PRESERVE_POSSIBLE_PROTECTION_FENCE' as const),
    Match.whenOr('PHYSICAL_RECEIPT', 'PHYSICAL_ISSUE', () => 'PRESERVE_PHYSICAL_QUANTITY_UNCERTAINTY' as const),
    Match.exhaustive,
  );
