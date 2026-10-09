import { Schema } from 'effect';

import { InventoryEffectLedgerEffectIdSchema } from './inventory-effect-ledger-identifiers.ts';

const effectKindSchema = Schema.Literals([
  'RESERVATION_CREATE',
  'RESERVATION_RELEASE',
  'ESTABLISH_COMMITMENT_PROTECTION',
  'PHYSICAL_RECEIPT',
  'PHYSICAL_ISSUE',
]);

export class InventoryEffectLedgerConflict extends Schema.TaggedError<InventoryEffectLedgerConflict>()(
  'InventoryEffectLedgerConflict',
  {
    attemptedKind: effectKindSchema,
    code: Schema.Literal('inventory_effect_ledger_conflict'),
    effectId: InventoryEffectLedgerEffectIdSchema,
    existingKind: effectKindSchema,
    reason: Schema.Literal('MATERIAL_INTENT_CONFLICT'),
  },
) {}
