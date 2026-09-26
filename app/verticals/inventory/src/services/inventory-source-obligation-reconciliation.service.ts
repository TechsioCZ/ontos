import { Effect } from 'effect';

import type { InventorySourceObligationReconciliationInput } from '../../shared/domain/inventory-source-obligation-reconciliation.ts';
import { evaluateInventorySourceAssertionCoverage } from '../domain/inventory-source-assertion-evaluator.ts';

/**
 * Composes evidence without executing physical effects or turning obligation changes into stock.
 * Owner coverage alone decides whether an external absolute assertion can represent Current truth.
 */
export const makeInventorySourceObligationReconciliationService = () => ({
  reconcile: Effect.fn('InventorySourceObligationReconciliationService.reconcile')(function* reconcileSourceObligation(
    input: InventorySourceObligationReconciliationInput,
  ) {
    const evaluation = yield* evaluateInventorySourceAssertionCoverage(input.assertion, input.physicalEffects);
    return {
      committedObligationEvidence: input.committedObligationEvidence,
      committedObligationMeaning: 'SEPARATE_FROM_PHYSICAL_ON_HAND',
      customerFacingAvailabilityPublished: false,
      evaluation,
      obligationAdjustmentAppliedToOnHand: false,
      physicalEffects: input.physicalEffects,
      physicalEffectsExecuted: false,
      physicalQuantityMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
      reservedQuantityMeaning: 'DERIVED_PROVISIONAL_RESERVATION_AGGREGATE',
      sourceAssertion: input.assertion,
    };
  }),
});

export const inventorySourceObligationReconciliationService = makeInventorySourceObligationReconciliationService();
