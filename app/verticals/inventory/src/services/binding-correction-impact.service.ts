import { DateTime, Effect, Match, Option, Schema } from 'effect';

import type { CatalogToStockBinding } from '../../shared/domain/catalog-to-stock-binding.ts';
import { CatalogToStockBindingUnavailable } from '../../shared/domain/catalog-to-stock-binding-unavailable.ts';
import type { CommitmentProtection } from '../../shared/domain/commitment-protection.ts';
import { markCommitmentProtectionAtRisk } from '../../shared/domain/commitment-protection.ts';
import type { ReservationConfirmation } from '../../shared/domain/reservation-confirmation.ts';
import { advanceReservationConfirmationHealth } from '../../shared/domain/reservation-confirmation.ts';

export interface BindingCorrectionAffectedRequirement {
  readonly confirmation?: ReservationConfirmation;
  readonly lifecycleMeaning: 'COMMITTED_OBLIGATION' | 'PROVISIONAL_RESERVATION';
  readonly obligationId: string;
  readonly protection?: CommitmentProtection;
  readonly purchaseDemandOccurrenceId: string;
  readonly subjectResourceType:
    | 'commerce.inventory.imported-committed-obligation'
    | 'commerce.inventory.inventory-reservation';
}

const BindingCorrectionDebtCorrectedAtSchema = Schema.toEncoded(Schema.DateTimeUtcFromString);

export interface BindingCorrectionReconciliationDebt {
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly correctedAt: typeof BindingCorrectionDebtCorrectedAtSchema.Type;
  readonly correctionEvidenceRef: string;
  readonly currentStockItemId: string;
  readonly historicalStockItemId: string;
  readonly obligationId: string;
  readonly purchaseDemandOccurrenceId: string;
  readonly subjectResourceType:
    | 'commerce.inventory.imported-committed-obligation'
    | 'commerce.inventory.inventory-reservation';
  readonly tenantId: string;
}

export interface BindingCorrectionImpactInput {
  readonly correctedBinding: CatalogToStockBinding;
  readonly correctionEvidenceRef: string;
  readonly previousBinding: CatalogToStockBinding;
}

export interface BindingCorrectionImpactResult {
  readonly affectedRequirements: number;
  readonly committedReconciliationChanges: readonly BindingCorrectionReconciliationDebt[];
  readonly committedReconciliations: number;
  readonly confirmationChanges: readonly ReservationConfirmation[];
  readonly confirmationsAtRisk: number;
  readonly protectionChanges: readonly CommitmentProtection[];
  readonly protectionsAtRisk: number;
}

export interface BindingCorrectionImpactPersistence {
  readonly appendCommittedReconciliation: (
    debt: BindingCorrectionReconciliationDebt,
  ) => Effect.Effect<'APPENDED' | 'EXACT_REPLAY', CatalogToStockBindingUnavailable>;
  readonly lockAffected: (
    input: BindingCorrectionImpactInput,
  ) => Effect.Effect<readonly BindingCorrectionAffectedRequirement[], CatalogToStockBindingUnavailable>;
  readonly saveConfirmation: (
    current: ReservationConfirmation,
    next: ReservationConfirmation,
  ) => Effect.Effect<ReservationConfirmation, CatalogToStockBindingUnavailable>;
  readonly saveProtection: (
    current: CommitmentProtection,
    next: CommitmentProtection,
  ) => Effect.Effect<CommitmentProtection, CatalogToStockBindingUnavailable>;
}

export interface BindingCorrectionImpactOperations {
  readonly apply: (
    input: BindingCorrectionImpactInput,
  ) => Effect.Effect<BindingCorrectionImpactResult, CatalogToStockBindingUnavailable>;
}

const unavailable = (cause: unknown) => {
  const failure = new CatalogToStockBindingUnavailable({
    code: 'catalog_to_stock_binding_unavailable',
    reason: 'Binding correction impact propagation is temporarily unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const sameCorrectionObservation = (
  current: ReservationConfirmation | CommitmentProtection,
  input: BindingCorrectionImpactInput,
) =>
  Match.value(current.health.observation).pipe(
    Match.tag(
      'BINDING_CORRECTION',
      (observation) =>
        observation.correctionEvidenceRef === input.correctionEvidenceRef &&
        observation.effectiveAt === input.correctedBinding.effectiveFrom,
    ),
    Match.orElse(() => false),
  );

const confirmationIsLiveAt = (confirmation: ReservationConfirmation, correctedAt: string) =>
  confirmation.health.state !== 'REVOKED' &&
  confirmation.health.state !== 'EXPIRED' &&
  DateTime.toEpochMillis(DateTime.makeUnsafe(correctedAt)) <
    DateTime.toEpochMillis(DateTime.makeUnsafe(confirmation.expiresAt));

export const makeBindingCorrectionImpactService = (
  persistence: BindingCorrectionImpactPersistence,
): BindingCorrectionImpactOperations => ({
  apply: Effect.fn('BindingCorrectionImpactService.apply')(function* applyBindingCorrectionImpact(input) {
    const affected = yield* persistence.lockAffected(input);
    const confirmations = new Map<string, ReservationConfirmation>();
    const protections = new Map<string, CommitmentProtection>();
    for (const requirement of affected) {
      if (requirement.confirmation !== undefined) {
        confirmations.set(requirement.confirmation.ref.resourceId, requirement.confirmation);
      }
      if (requirement.protection !== undefined) {
        protections.set(requirement.protection.ref.resourceId, requirement.protection);
      }
    }

    const confirmationOutcomes = yield* Effect.forEach(
      confirmations.values(),
      (confirmation) => {
        if (
          sameCorrectionObservation(confirmation, input) ||
          !confirmationIsLiveAt(confirmation, input.correctedBinding.effectiveFrom)
        ) {
          return Effect.succeed(Option.none<ReservationConfirmation>());
        }
        return advanceReservationConfirmationHealth(confirmation, {
          _tag: 'BINDING_CORRECTION',
          correctionEvidenceRef: input.correctionEvidenceRef,
          effectiveAt: input.correctedBinding.effectiveFrom,
        }).pipe(
          Effect.mapError(unavailable),
          Effect.flatMap((next) => persistence.saveConfirmation(confirmation, next)),
          Effect.asSome,
        );
      },
      { concurrency: 1 },
    );
    const protectionOutcomes = yield* Effect.forEach(
      protections.values(),
      (protection) => {
        if (sameCorrectionObservation(protection, input)) {
          return Effect.succeed(Option.none<CommitmentProtection>());
        }
        return markCommitmentProtectionAtRisk(protection, {
          _tag: 'BINDING_CORRECTION',
          correctionEvidenceRef: input.correctionEvidenceRef,
          effectiveAt: input.correctedBinding.effectiveFrom,
        }).pipe(
          Effect.mapError(unavailable),
          Effect.flatMap((next) => persistence.saveProtection(protection, next)),
          Effect.asSome,
        );
      },
      { concurrency: 1 },
    );
    const reconciliationOutcomes = yield* Effect.forEach(
      affected,
      (requirement) => {
        if (requirement.lifecycleMeaning !== 'COMMITTED_OBLIGATION') {
          return Effect.succeed(Option.none<BindingCorrectionReconciliationDebt>());
        }
        const debt: BindingCorrectionReconciliationDebt = {
          bindingId: input.correctedBinding.bindingRef.resourceId,
          bindingRevision: input.correctedBinding.revision,
          correctedAt: input.correctedBinding.effectiveFrom,
          correctionEvidenceRef: input.correctionEvidenceRef,
          currentStockItemId: input.correctedBinding.stockItemRef.resourceId,
          historicalStockItemId: input.previousBinding.stockItemRef.resourceId,
          obligationId: requirement.obligationId,
          purchaseDemandOccurrenceId: requirement.purchaseDemandOccurrenceId,
          subjectResourceType: requirement.subjectResourceType,
          tenantId: input.correctedBinding.bindingRef.tenantId,
        };
        return persistence
          .appendCommittedReconciliation(debt)
          .pipe(Effect.map((outcome) => (outcome === 'APPENDED' ? Option.some(debt) : Option.none())));
      },
      { concurrency: 1 },
    );
    const confirmationChanges = confirmationOutcomes.flatMap(Option.toArray);
    const protectionChanges = protectionOutcomes.flatMap(Option.toArray);
    const committedReconciliationChanges = reconciliationOutcomes.flatMap(Option.toArray);

    return {
      affectedRequirements: affected.length,
      committedReconciliationChanges,
      committedReconciliations: committedReconciliationChanges.length,
      confirmationChanges,
      confirmationsAtRisk: confirmationChanges.length,
      protectionChanges,
      protectionsAtRisk: protectionChanges.length,
    };
  }),
});
