import { Schema } from 'effect';

import { ImportedCommittedObligationRefSchema } from '../resources/imported-committed-obligation.ts';
import { InventoryReservationRefSchema } from '../resources/inventory-reservation.ts';
import { StockItemRefSchema } from '../resources/stock-item.ts';
import { StockPositionRefSchema } from '../resources/stock-position.ts';
import {
  InventorySourceAssertionEvaluationSchema,
  InventorySourceAssertionSchema,
} from './inventory-source-assertion.ts';
import { PhysicalStockEffectRecordSchema } from './physical-stock-effect.ts';
import { StockQuantitySchema } from './stock-position.ts';

const boundedEvidenceRef = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const observedInstant = Schema.toEncoded(Schema.DateTimeUtcFromString);

export const CommittedInventoryObligationRefSchema = Schema.Union([
  InventoryReservationRefSchema,
  ImportedCommittedObligationRefSchema,
]);

/**
 * An immutable owner observation of committed quantity. A history may contain several observations
 * for one obligation identity; none of them is a physical stock effect or a source of ON_HAND.
 */
export const InventoryCommittedObligationStateEvidenceSchema = Schema.Struct({
  obligationRef: CommittedInventoryObligationRefSchema,
  observedAt: observedInstant,
  ownerEvidenceRef: boundedEvidenceRef,
  positionRef: StockPositionRefSchema,
  remainingQuantity: StockQuantitySchema,
  stockItemRef: StockItemRefSchema,
}).check(
  Schema.makeFilter(({ obligationRef, positionRef, remainingQuantity, stockItemRef }) => {
    const { tenantId } = obligationRef;
    return positionRef.tenantId === tenantId &&
      remainingQuantity.unitRef.tenantId === tenantId &&
      stockItemRef.tenantId === tenantId
      ? undefined
      : 'Committed obligation evidence must preserve one exact Tenant scope';
  }),
);

export const InventorySourceObligationReconciliationInputSchema = Schema.Struct({
  assertion: InventorySourceAssertionSchema,
  committedObligationEvidence: Schema.Array(InventoryCommittedObligationStateEvidenceSchema),
  physicalEffects: Schema.Array(PhysicalStockEffectRecordSchema),
}).check(
  Schema.makeFilter(({ assertion, committedObligationEvidence }) =>
    committedObligationEvidence.every(
      ({ positionRef, remainingQuantity, stockItemRef }) =>
        positionRef.resourceId === assertion.positionRef.resourceId &&
        positionRef.tenantId === assertion.positionRef.tenantId &&
        stockItemRef.resourceId === assertion.stockItemRef.resourceId &&
        stockItemRef.tenantId === assertion.stockItemRef.tenantId &&
        remainingQuantity.unitRef.moduleId === assertion.quantity.unitRef.moduleId &&
        remainingQuantity.unitRef.resourceId === assertion.quantity.unitRef.resourceId &&
        remainingQuantity.unitRef.resourceType === assertion.quantity.unitRef.resourceType &&
        remainingQuantity.unitRef.tenantId === assertion.quantity.unitRef.tenantId,
    )
      ? undefined
      : 'Committed obligation evidence must match the exact source assertion stock scope',
  ),
);
export type InventorySourceObligationReconciliationInput =
  typeof InventorySourceObligationReconciliationInputSchema.Type;

export const InventorySourceObligationReconciliationSchema = Schema.Struct({
  committedObligationEvidence: Schema.Array(InventoryCommittedObligationStateEvidenceSchema),
  committedObligationMeaning: Schema.Literal('SEPARATE_FROM_PHYSICAL_ON_HAND'),
  customerFacingAvailabilityPublished: Schema.Literal(false),
  evaluation: InventorySourceAssertionEvaluationSchema,
  obligationAdjustmentAppliedToOnHand: Schema.Literal(false),
  physicalEffects: Schema.Array(PhysicalStockEffectRecordSchema),
  physicalEffectsExecuted: Schema.Literal(false),
  physicalQuantityMeaning: Schema.Literal('ABSOLUTE_PHYSICAL_ON_HAND'),
  reservedQuantityMeaning: Schema.Literal('DERIVED_PROVISIONAL_RESERVATION_AGGREGATE'),
  sourceAssertion: InventorySourceAssertionSchema,
}).check(
  Schema.makeFilter(({ evaluation, sourceAssertion }) =>
    evaluation.assertion.assertionId === sourceAssertion.assertionId
      ? undefined
      : 'Reconciliation evaluation must preserve the exact source assertion identity',
  ),
);
