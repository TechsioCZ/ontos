import { Match, Schema } from 'effect';

import {
  AlreadyTerminalInventoryEffectResultSchema,
  DefinitiveNonEffectInventoryEffectResultSchema,
  IndeterminateInventoryEffectResultSchema,
  InventoryEffectRecoveryRejected,
  RecoveredInventoryEffectResultSchema,
} from '../domain/inventory-effect-recovery.ts';
import {
  InventoryEffectLedgerConflict,
  InventoryEffectLedgerEffectIdSchema,
  InventoryEffectLedgerKindSchema,
  InventoryEffectLedgerRejected,
  InventoryEffectLedgerUnavailable,
} from '../domain/inventory-effect-ledger.ts';
import { CommitmentProtectionRefSchema } from '../resources/commitment-protection.ts';
import { InventoryReservationRefSchema } from '../resources/inventory-reservation.ts';
import { StockPositionRefSchema } from '../resources/stock-position.ts';

export const RecoverInventoryEffectTargetRefSchema = Schema.Union([
  InventoryReservationRefSchema,
  CommitmentProtectionRefSchema,
  StockPositionRefSchema,
]);
export type RecoverInventoryEffectTargetRef = typeof RecoverInventoryEffectTargetRefSchema.Type;

const targetTypeForKind = (kind: typeof InventoryEffectLedgerKindSchema.Type) =>
  Match.value(kind).pipe(
    Match.whenOr(
      'RESERVATION_CREATE',
      'RESERVATION_RELEASE',
      () => 'commerce.inventory.inventory-reservation' as const,
    ),
    Match.when('ESTABLISH_COMMITMENT_PROTECTION', () => 'commerce.inventory.commitment-protection' as const),
    Match.whenOr('PHYSICAL_RECEIPT', 'PHYSICAL_ISSUE', () => 'commerce.inventory.stock-position' as const),
    Match.exhaustive,
  );

export const RecoverInventoryEffectPayloadSchema = Schema.Struct({
  effectId: InventoryEffectLedgerEffectIdSchema,
  expectedKind: InventoryEffectLedgerKindSchema,
  targetRef: RecoverInventoryEffectTargetRefSchema,
}).check(
  Schema.makeFilter(({ expectedKind, targetRef }) =>
    targetRef.resourceType === targetTypeForKind(expectedKind)
      ? undefined
      : 'Recovery kind must identify its exact durable Inventory target kind',
  ),
);
export type RecoverInventoryEffectPayload = typeof RecoverInventoryEffectPayloadSchema.Type;

type RecoverInventoryEffectResultMembers = readonly [
  typeof RecoveredInventoryEffectResultSchema,
  typeof DefinitiveNonEffectInventoryEffectResultSchema,
  typeof AlreadyTerminalInventoryEffectResultSchema,
  typeof IndeterminateInventoryEffectResultSchema,
];

export const RecoverInventoryEffectResultSchema: Schema.Union<RecoverInventoryEffectResultMembers> = Schema.Union([
  RecoveredInventoryEffectResultSchema,
  DefinitiveNonEffectInventoryEffectResultSchema,
  AlreadyTerminalInventoryEffectResultSchema,
  IndeterminateInventoryEffectResultSchema,
]);
export type RecoverInventoryEffectResult = typeof RecoverInventoryEffectResultSchema.Type;

export class RecoverInventoryEffectActionRejected extends Schema.TaggedError<RecoverInventoryEffectActionRejected>()(
  'RecoverInventoryEffectActionRejected',
  {
    code: Schema.Literal('recover_inventory_effect_action_rejected'),
    effectId: InventoryEffectLedgerEffectIdSchema,
    reason: Schema.Literals(['TRUSTED_LEGAL_ENTITY_REQUIRED', 'ORIGINAL_EFFECT_SCOPE_MISMATCH']),
  },
) {}

export const RecoverInventoryEffectErrorSchema = Schema.Union([
  InventoryEffectLedgerConflict,
  InventoryEffectLedgerRejected,
  InventoryEffectLedgerUnavailable,
  InventoryEffectRecoveryRejected,
  RecoverInventoryEffectActionRejected,
]);
