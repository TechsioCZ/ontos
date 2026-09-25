import { Schema } from 'effect';

import { InventoryEffectLedgerEffectIdSchema } from './inventory-effect-ledger-identifiers.ts';

export class InventoryEffectLedgerUnavailable extends Schema.TaggedError<InventoryEffectLedgerUnavailable>()(
  'InventoryEffectLedgerUnavailable',
  {
    code: Schema.Literal('inventory_effect_ledger_unavailable'),
    effectId: InventoryEffectLedgerEffectIdSchema,
    reason: Schema.String,
    retryable: Schema.Literal(true),
  },
) {}
