import { Schema } from 'effect';

import { InventoryEffectLedgerEffectIdSchema } from './inventory-effect-ledger-identifiers.ts';

export class InventoryEffectLedgerRejected extends Schema.TaggedError<InventoryEffectLedgerRejected>()(
  'InventoryEffectLedgerRejected',
  {
    code: Schema.Literal('inventory_effect_ledger_rejected'),
    effectId: InventoryEffectLedgerEffectIdSchema,
    reason: Schema.Literals([
      'INVALID_RESOLUTION',
      'INVALID_TRANSITION',
      'REVISION_CONFLICT',
      'TENANT_SCOPE_MISMATCH',
      'TERMINAL_EFFECT_IMMUTABLE',
    ]),
  },
) {}
