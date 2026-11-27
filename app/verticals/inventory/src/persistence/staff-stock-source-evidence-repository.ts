import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Effect } from 'effect';

import { inventorySourceImportLedger } from './inventory-source-import-ledger-table.ts';
import { inventoryPhysicalStockEffects } from './physical-stock-effect-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

export interface StaffStockSourceIssuer {
  readonly backendId: string;
  readonly backendKind: string;
}

/** The source evidence a staff stock edit continues: what the External Business System already reported. */
export const staffStockSourceEvidenceForScope = (transaction: ScopedTransaction, scope: OperationalScope) => ({
  /** The undecoded proposals of every accepted absolute on-hand fact the issuer reported for the Stock Position. */
  acceptedOnHandProposals: (customerConfigurationId: string, issuer: StaffStockSourceIssuer, positionId: string) =>
    transaction
      .select({ proposal: inventorySourceImportLedger.proposalJson })
      .from(inventorySourceImportLedger)
      .where(
        and(
          eq(inventorySourceImportLedger.tenantId, scope.tenantId),
          eq(inventorySourceImportLedger.customerConfigurationId, customerConfigurationId),
          eq(inventorySourceImportLedger.issuerBackendKind, issuer.backendKind),
          eq(inventorySourceImportLedger.issuerBackendId, issuer.backendId),
          eq(inventorySourceImportLedger.factMeaning, 'ABSOLUTE_PHYSICAL_ON_HAND'),
          eq(inventorySourceImportLedger.positionId, positionId),
          eq(inventorySourceImportLedger.status, 'ACCEPTED'),
        ),
      )
      .pipe(Effect.map((rows) => rows.map(({ proposal }) => proposal))),
  /** The undecoded ids of every applied physical stock effect of the Stock Position. */
  appliedEffectIds: (positionId: string) =>
    transaction
      .select({ effectId: inventoryPhysicalStockEffects.effectId })
      .from(inventoryPhysicalStockEffects)
      .where(
        and(
          eq(inventoryPhysicalStockEffects.tenantId, scope.tenantId),
          eq(inventoryPhysicalStockEffects.positionId, positionId),
          eq(inventoryPhysicalStockEffects.state, 'APPLIED'),
        ),
      )
      .pipe(Effect.map((rows) => rows.map(({ effectId }) => effectId))),
});
