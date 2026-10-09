/* oxlint-disable effect-native/no-dependency-parameters, effect-native/no-wide-factory-signature -- This owner-local reconciliation factory binds already-scoped persistence, proof-transition, effect-read, and reduction ports once; expires: 2027-03-31. */
import { Effect, Option, Schema } from 'effect';

import { InventoryPostCommitReconciliationRejected } from '../../shared/domain/inventory-post-commit-reservation-reconciliation.ts';
import type {
  InventoryPostCommitBindingAssessmentInput,
  InventoryPostCommitPhysicalEffectReader,
  InventoryPostCommitReductionRequest,
  InventoryPostCommitReductionResult,
  InventoryPostCommitReductionWriter,
  InventoryPostCommitTransition,
  PostCommitInventoryObligation,
} from '../../shared/domain/inventory-post-commit-reservation-reconciliation.ts';
import {
  ImportedCommittedObligationSchema,
  ProvisionalInventoryReservationSchema,
  RuntimeCommittedInventoryObligationSchema,
} from '../../shared/domain/inventory-obligation.ts';
import type { RuntimeOrderCommitProofObservation } from '../../shared/domain/inventory-obligation.ts';
import { AppliedPhysicalStockEffectSchema } from '../../shared/domain/physical-stock-effect.ts';
import type { InventoryObligationPersistence } from '../persistence/inventory-obligation-repository.ts';
import { inventorySourceObligationReconciliationService } from './inventory-source-obligation-reconciliation.service.ts';

interface InventoryPostCommitReservationReconciliationDependencies {
  readonly commitTransition: InventoryPostCommitTransition;
  readonly obligationStore: Pick<InventoryObligationPersistence, 'commitReservation' | 'read'>;
  readonly physicalEffectReader: InventoryPostCommitPhysicalEffectReader;
  readonly reductionWriter: InventoryPostCommitReductionWriter;
}

interface ResourceIdentity {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}

const sameResource = (left: ResourceIdentity, right: ResourceIdentity): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const reject = (reason: InventoryPostCommitReconciliationRejected['reason']) =>
  new InventoryPostCommitReconciliationRejected({
    code: 'inventory_post_commit_reconciliation_rejected',
    reason,
  });

const sameRuntimeProof = (
  obligation: typeof RuntimeCommittedInventoryObligationSchema.Type,
  observation: RuntimeOrderCommitProofObservation,
): boolean =>
  obligation.orderProof.acceptedOrderId === observation.acceptedOrderId &&
  obligation.orderProof.attemptId === observation.attemptId &&
  obligation.orderProof.evidenceRef === observation.evidenceRef &&
  obligation.orderProof.observedAt === observation.observedAt &&
  obligation.orderProof.tenantId === observation.tenantId &&
  sameResource(obligation.orderProof.reservationRef, observation.reservationRef);

const committedOrderId = (obligation: PostCommitInventoryObligation): string => obligation.orderProof.acceptedOrderId;

const issueMatchesAllocation = (
  issue: typeof AppliedPhysicalStockEffectSchema.Type,
  obligation: PostCommitInventoryObligation,
  allocation: PostCommitInventoryObligation['requirements'][number]['allocations'][number],
): boolean => {
  const { evidence, request } = issue;
  return (
    evidence.effectId === request.effectId &&
    evidence.kind === request.kind &&
    evidence.backend === request.backend &&
    evidence.backendId === request.backendId &&
    sameResource(evidence.backendConfigurationRef, request.backendConfigurationRef) &&
    sameResource(evidence.positionRef, request.positionRef) &&
    evidence.quantity.amount === request.quantity.amount &&
    sameResource(evidence.quantity.unitRef, request.quantity.unitRef) &&
    sameResource(request.positionRef, allocation.positionRef) &&
    sameResource(request.stockItemRef, allocation.stockItemRef) &&
    request.quantity.amount === allocation.quantity.amount &&
    sameResource(request.quantity.unitRef, allocation.quantity.unitRef) &&
    request.customerConfigurationId === obligation.authority.customerConfigurationId &&
    request.backend === obligation.authority.selection.backend &&
    request.backendId === obligation.authority.selection.backendId &&
    request.backendConfigurationRef.resourceId === obligation.authority.configurationId &&
    request.backendConfigurationRef.tenantId === obligation.authority.tenantId &&
    request.reason.code === 'ORDER_FULFILLMENT' &&
    request.reason.reference === committedOrderId(obligation)
  );
};

const reductionEvidenceMatches = (
  result: InventoryPostCommitReductionResult,
  obligation: PostCommitInventoryObligation,
  allocation: PostCommitInventoryObligation['requirements'][number]['allocations'][number],
): boolean =>
  sameResource(result.evidence.obligationRef, obligation.ref) &&
  sameResource(result.evidence.positionRef, allocation.positionRef) &&
  sameResource(result.evidence.stockItemRef, allocation.stockItemRef) &&
  sameResource(result.evidence.remainingQuantity.unitRef, allocation.quantity.unitRef);

export const makeInventoryPostCommitReservationReconciliationService = (
  dependencies: InventoryPostCommitReservationReconciliationDependencies,
) => {
  const recoverCommitTransition = Effect.fn(
    'InventoryPostCommitReservationReconciliationService.recoverCommitTransition',
  )(function* recoverCommit(observation: RuntimeOrderCommitProofObservation) {
    if (observation.tenantId !== observation.reservationRef.tenantId) {
      return yield* reject('TENANT_SCOPE_MISMATCH');
    }
    const current = yield* dependencies.obligationStore.read(observation.reservationRef);
    if (Option.isNone(current)) {
      return yield* reject('OBLIGATION_NOT_FOUND');
    }
    const obligation = current.value;
    if (Schema.is(RuntimeCommittedInventoryObligationSchema)(obligation)) {
      if (!sameRuntimeProof(obligation, observation)) {
        return yield* reject('ORDER_COMMIT_PROOF_MISMATCH');
      }
      return {
        duplicateObligationCreated: false as const,
        obligation,
        orderRolledBack: false as const,
        outcome: 'EXACT_REPLAY' as const,
      };
    }
    if (!Schema.is(ProvisionalInventoryReservationSchema)(obligation)) {
      return yield* reject('OBLIGATION_NOT_COMMITTED');
    }
    const committed = yield* dependencies.commitTransition.transition(obligation, observation);
    const persisted = yield* dependencies.obligationStore.commitReservation(committed);
    return {
      duplicateObligationCreated: false as const,
      obligation: persisted.obligation,
      orderRolledBack: false as const,
      outcome: persisted.outcome,
    };
  });

  const recoverObligationReduction = Effect.fn(
    'InventoryPostCommitReservationReconciliationService.recoverObligationReduction',
  )(function* recoverReduction(request: InventoryPostCommitReductionRequest) {
    const current = yield* dependencies.obligationStore.read(request.obligationRef);
    if (Option.isNone(current)) {
      return yield* reject('OBLIGATION_NOT_FOUND');
    }
    const obligation = current.value;
    if (
      !Schema.is(RuntimeCommittedInventoryObligationSchema)(obligation) &&
      !Schema.is(ImportedCommittedObligationSchema)(obligation)
    ) {
      return yield* reject('OBLIGATION_NOT_COMMITTED');
    }
    const requirement = obligation.requirements.find(
      ({ purchaseDemandOccurrenceId }) => purchaseDemandOccurrenceId === request.purchaseDemandOccurrenceId,
    );
    if (requirement === undefined) {
      return yield* reject('OBLIGATION_REQUIREMENT_NOT_FOUND');
    }
    const allocation = requirement.allocations.find(({ allocationId }) => allocationId === request.allocationId);
    if (allocation === undefined) {
      return yield* reject('ALLOCATION_NOT_FOUND');
    }
    const effect = yield* dependencies.physicalEffectReader.read(request.issueEffectId);
    if (Option.isNone(effect)) {
      return yield* reject('PHYSICAL_EFFECT_NOT_FOUND');
    }
    if (!Schema.is(AppliedPhysicalStockEffectSchema)(effect.value) || effect.value.request.kind !== 'ISSUE') {
      return yield* reject('PHYSICAL_ISSUE_NOT_APPLIED');
    }
    if (
      effect.value.request.effectId !== request.issueEffectId ||
      !sameResource(obligation.ref, request.obligationRef) ||
      !issueMatchesAllocation(effect.value, obligation, allocation)
    ) {
      return yield* reject('PHYSICAL_ISSUE_SCOPE_MISMATCH');
    }
    const reduction = yield* dependencies.reductionWriter.reduceAfterAppliedIssue({
      allocation,
      issue: effect.value,
      obligation,
      requirement,
    });
    if (!reductionEvidenceMatches(reduction, obligation, allocation)) {
      return yield* reject('REDUCTION_EVIDENCE_SCOPE_MISMATCH');
    }
    return {
      obligationReduction: reduction,
      orderRolledBack: false as const,
      physicalEffectExecuted: false as const,
    };
  });

  const assessCurrentBinding = Effect.fn('InventoryPostCommitReservationReconciliationService.assessCurrentBinding')(
    function* assessBinding(input: InventoryPostCommitBindingAssessmentInput) {
      const requirement = input.obligation.requirements.find(
        ({ purchaseDemandOccurrenceId }) => purchaseDemandOccurrenceId === input.purchaseDemandOccurrenceId,
      );
      if (requirement === undefined) {
        return yield* reject('OBLIGATION_REQUIREMENT_NOT_FOUND');
      }
      if (
        !sameResource(requirement.bindingRef, input.currentBinding.bindingRef) ||
        requirement.exactSelectionMeaning.id !== input.currentBinding.exactSelectionMeaning.id ||
        requirement.exactSelectionMeaning.kind !== input.currentBinding.exactSelectionMeaning.kind ||
        !sameResource(requirement.unitRef, input.currentBinding.unitRef)
      ) {
        return yield* reject('BINDING_SCOPE_MISMATCH');
      }
      return {
        currentBinding: input.currentBinding,
        currentStockItemRef: input.currentBinding.stockItemRef,
        exception: sameResource(requirement.stockItem.stockItemRef, input.currentBinding.stockItemRef)
          ? ('NONE' as const)
          : ('POST_COMMIT_BINDING_MISMATCH' as const),
        historicalStockItemRef: requirement.stockItem.stockItemRef,
        obligation: input.obligation,
        orderRolledBack: false as const,
        replacementObligationCreated: false as const,
        retargeted: false as const,
      };
    },
  );

  return {
    assessCurrentBinding,
    reconcilePhysicalStock: inventorySourceObligationReconciliationService.reconcile,
    recoverCommitTransition,
    recoverObligationReduction,
  };
};
