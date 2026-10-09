import type { Effect as EffectType } from 'effect';
import { Context, DateTime, Effect } from 'effect';

import type { InventoryEffectRecoveryAuthorityObservation } from '../../shared/domain/inventory-effect-recovery.ts';
import type { InventoryEffectLedgerRecord } from '../../shared/domain/inventory-effect-ledger.ts';

/**
 * The selected effect owner must query or exact-retry the immutable owner-scoped identity in the
 * supplied ledger record. Implementations must never substitute a fresh provider identity.
 */
export interface InventoryEffectRecoveryAuthority {
  readonly recoverOriginal: (
    original: InventoryEffectLedgerRecord,
  ) => EffectType.Effect<InventoryEffectRecoveryAuthorityObservation>;
}

/** Fail closed until the selected Inventory Backend installs its owner-specific recovery adapter. */
export const InventoryEffectRecoveryAuthorityPort = Context.Reference<InventoryEffectRecoveryAuthority>(
  '@app/inventory/services/inventory-effect-recovery-authority/InventoryEffectRecoveryAuthorityPort',
  {
    defaultValue: () => ({
      recoverOriginal: (original) =>
        DateTime.now.pipe(
          Effect.map((now) => ({
            _tag: 'INDETERMINATE' as const,
            effectId: original.effectId,
            intent: original.intent,
            kind: original.intent._tag,
            learnedAt: DateTime.formatIso(now),
            reason: 'OWNER_UNAVAILABLE' as const,
          })),
        ),
    }),
  },
);
