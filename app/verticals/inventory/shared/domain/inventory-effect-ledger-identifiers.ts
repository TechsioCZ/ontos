import { Schema } from 'effect';

export const InventoryEffectLedgerEffectIdSchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
).pipe(Schema.brand('InventoryEffectLedgerEffectId'));
