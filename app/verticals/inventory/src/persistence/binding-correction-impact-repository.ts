import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, asc, eq } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';

import { CatalogToStockBindingUnavailable } from '../../shared/domain/catalog-to-stock-binding-unavailable.ts';
import type { CommitmentProtection } from '../../shared/domain/commitment-protection.ts';
import { CommitmentProtectionSchema } from '../../shared/domain/commitment-protection.ts';
import type { ReservationConfirmation } from '../../shared/domain/reservation-confirmation.ts';
import { ReservationConfirmationSchema } from '../../shared/domain/reservation-confirmation.ts';
import type {
  BindingCorrectionAffectedRequirement,
  BindingCorrectionImpactPersistence,
} from '../services/binding-correction-impact.service.ts';
import { inventoryBindingCorrectionReconciliations } from './binding-correction-impact-table.ts';
import { commitmentProtectionPersistenceForScope } from './commitment-protection-repository.ts';
import { inventoryCommitmentProtections } from './commitment-protection-table.ts';
import { inventoryObligationRequirements, inventoryObligations } from './inventory-obligation-table.ts';
import { reservationConfirmationPersistenceForScope } from './reservation-confirmation-repository.ts';
import { inventoryReservationConfirmations } from './reservation-confirmation-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

interface AffectedRequirementRow {
  readonly attemptId: string | null;
  readonly lifecycleMeaning: string;
  readonly obligationId: string;
  readonly originKind: string;
  readonly purchaseDemandOccurrenceId: string;
}

const unavailable = (cause?: unknown) => {
  const failure = new CatalogToStockBindingUnavailable({
    code: 'catalog_to_stock_binding_unavailable',
    reason: 'Binding correction impact persistence is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const decodeConfirmation = (snapshot: ReservationConfirmation) =>
  Schema.decodeEffect(ReservationConfirmationSchema)(snapshot).pipe(Effect.mapError(unavailable));
const decodeProtection = (snapshot: CommitmentProtection) =>
  Schema.decodeEffect(CommitmentProtectionSchema)(snapshot).pipe(Effect.mapError(unavailable));

export const bindingCorrectionImpactPersistenceForScope = (
  transaction: ScopedTransaction,
  operationScope: OperationalScope,
): BindingCorrectionImpactPersistence => {
  const confirmations = reservationConfirmationPersistenceForScope(transaction, operationScope);
  const protections = commitmentProtectionPersistenceForScope(transaction, operationScope);

  const lockAffected: BindingCorrectionImpactPersistence['lockAffected'] = Effect.fn(
    'BindingCorrectionImpactPersistence.lockAffected',
  )(function* lockAffectedRequirements(input) {
    if (input.previousBinding.bindingRef.tenantId !== operationScope.tenantId) {
      return yield* unavailable();
    }
    const requirements = yield* transaction
      .select({
        attemptId: inventoryObligations.attemptId,
        lifecycleMeaning: inventoryObligations.lifecycleMeaning,
        obligationId: inventoryObligationRequirements.obligationId,
        originKind: inventoryObligations.originKind,
        purchaseDemandOccurrenceId: inventoryObligationRequirements.purchaseDemandOccurrenceId,
      })
      .from(inventoryObligationRequirements)
      .innerJoin(
        inventoryObligations,
        and(
          eq(inventoryObligations.tenantId, inventoryObligationRequirements.tenantId),
          eq(inventoryObligations.obligationId, inventoryObligationRequirements.obligationId),
        ),
      )
      .where(
        and(
          eq(inventoryObligationRequirements.tenantId, operationScope.tenantId),
          eq(inventoryObligationRequirements.bindingId, input.previousBinding.bindingRef.resourceId),
          eq(inventoryObligationRequirements.stockItemId, input.previousBinding.stockItemRef.resourceId),
          eq(
            inventoryObligationRequirements.exactSelectionMeaningKind,
            input.previousBinding.exactSelectionMeaning.kind,
          ),
          eq(inventoryObligationRequirements.exactSelectionMeaningId, input.previousBinding.exactSelectionMeaning.id),
        ),
      )
      .orderBy(
        asc(inventoryObligationRequirements.obligationId),
        asc(inventoryObligationRequirements.purchaseDemandOccurrenceId),
      )
      .for('update', { of: inventoryObligations })
      .pipe(Effect.mapError(unavailable));

    const loadLinkedOwnerState = Effect.fn('BindingCorrectionImpactPersistence.loadLinkedOwnerState')(
      function* loadLinkedOwnerState(
        requirement: AffectedRequirementRow,
      ): Effect.fn.Return<BindingCorrectionAffectedRequirement, CatalogToStockBindingUnavailable> {
        if (
          requirement.lifecycleMeaning !== 'PROVISIONAL_RESERVATION' &&
          requirement.lifecycleMeaning !== 'COMMITTED_OBLIGATION'
        ) {
          return yield* unavailable();
        }
        if (
          requirement.originKind !== 'ORDER_COMMITMENT_ATTEMPT' &&
          requirement.originKind !== 'IMPORTED_PROVEN_ORDER'
        ) {
          return yield* unavailable();
        }
        const common = {
          lifecycleMeaning: requirement.lifecycleMeaning,
          obligationId: requirement.obligationId,
          purchaseDemandOccurrenceId: requirement.purchaseDemandOccurrenceId,
          subjectResourceType:
            requirement.originKind === 'IMPORTED_PROVEN_ORDER'
              ? ('commerce.inventory.imported-committed-obligation' as const)
              : ('commerce.inventory.inventory-reservation' as const),
        } as const;
        if (requirement.attemptId === null) {
          return common;
        }
        const [confirmationRows, protectionRows] = yield* Effect.all(
          [
            transaction
              .select({ snapshot: inventoryReservationConfirmations.snapshot })
              .from(inventoryReservationConfirmations)
              .where(
                and(
                  eq(inventoryReservationConfirmations.tenantId, operationScope.tenantId),
                  eq(inventoryReservationConfirmations.reservationId, requirement.obligationId),
                  eq(inventoryReservationConfirmations.attemptId, requirement.attemptId),
                ),
              )
              .for('update')
              .limit(1)
              .pipe(Effect.mapError(unavailable)),
            transaction
              .select({ snapshot: inventoryCommitmentProtections.snapshot })
              .from(inventoryCommitmentProtections)
              .where(
                and(
                  eq(inventoryCommitmentProtections.tenantId, operationScope.tenantId),
                  eq(inventoryCommitmentProtections.reservationId, requirement.obligationId),
                  eq(inventoryCommitmentProtections.attemptId, requirement.attemptId),
                ),
              )
              .for('update')
              .limit(1)
              .pipe(Effect.mapError(unavailable)),
          ],
          { concurrency: 1 },
        );
        const [confirmationRow] = confirmationRows;
        const [protectionRow] = protectionRows;
        const confirmation =
          confirmationRow === undefined ? undefined : yield* decodeConfirmation(confirmationRow.snapshot);
        const protection = protectionRow === undefined ? undefined : yield* decodeProtection(protectionRow.snapshot);
        if (confirmation === undefined) {
          return protection === undefined ? common : { ...common, protection };
        }
        return protection === undefined ? { ...common, confirmation } : { ...common, confirmation, protection };
      },
    );
    return yield* Effect.forEach(requirements, loadLinkedOwnerState, { concurrency: 1 });
  });

  const persistence: BindingCorrectionImpactPersistence = {
    appendCommittedReconciliation: (debt) =>
      transaction
        .insert(inventoryBindingCorrectionReconciliations)
        .values({
          bindingId: debt.bindingId,
          bindingRevision: debt.bindingRevision,
          correctedAt: DateTime.toDateUtc(DateTime.makeUnsafe(debt.correctedAt)),
          correctionEvidenceRef: debt.correctionEvidenceRef,
          currentStockItemId: debt.currentStockItemId,
          historicalStockItemId: debt.historicalStockItemId,
          obligationId: debt.obligationId,
          purchaseDemandOccurrenceId: debt.purchaseDemandOccurrenceId,
          tenantId: debt.tenantId,
        })
        .onConflictDoNothing()
        .returning({ reconciliationId: inventoryBindingCorrectionReconciliations.reconciliationId })
        .pipe(
          Effect.mapError(unavailable),
          Effect.map(([inserted]) => (inserted === undefined ? 'EXACT_REPLAY' : 'APPENDED')),
        ),
    lockAffected,
    saveConfirmation: (current, next) =>
      confirmations.saveRevision({ current, next }).pipe(Effect.mapError(unavailable)),
    saveProtection: (current, next) => protections.saveRevision({ current, next }).pipe(Effect.mapError(unavailable)),
  };
  return Object.freeze(persistence);
};
