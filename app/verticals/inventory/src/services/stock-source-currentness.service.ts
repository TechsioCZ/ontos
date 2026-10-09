import { DateTime, Effect, Schema } from 'effect';

import type {
  StockSourceCondition,
  StockSourceCurrentnessInput,
  StockSourceCurrentnessResult,
} from '../../shared/domain/stock-source-currentness.ts';
import {
  ConflictingSourceConditionSchema,
  MissingSourceConditionSchema,
  OmittedSourceConditionSchema,
  OwnerUnknownSourceConditionSchema,
  StockSourceCurrentnessInputSchema,
  StockSourceCurrentnessRejected,
  UnavailableSourceConditionSchema,
} from '../../shared/domain/stock-source-currentness.ts';
import {
  HistoricalInventorySourceAssertionEvaluationSchema,
  IndeterminateInventorySourceAssertionEvaluationSchema,
} from '../../shared/domain/inventory-source-assertion.ts';
import type { InventorySourceAssertion } from '../../shared/domain/inventory-source-assertion.ts';
import type { StockPosition, StockPositionOnHandEvidence } from '../../shared/domain/stock-position.ts';
import { CurrentOnHandEvidenceSchema, recordOnHandEvidence } from '../../shared/domain/stock-position.ts';

const rejected = (reason: StockSourceCurrentnessRejected['reason'], cause?: unknown) => {
  const failure = new StockSourceCurrentnessRejected({ code: 'stock_source_currentness_rejected', reason });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const sameRef = (
  left: { readonly resourceId: string; readonly tenantId: string },
  right: { readonly resourceId: string; readonly tenantId: string },
) => left.resourceId === right.resourceId && left.tenantId === right.tenantId;

const sameUnit = (left: StockPosition['scope']['unitRef'], right: StockPosition['scope']['unitRef']): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const exactAssertionScope = (
  assertion: InventorySourceAssertion,
  input: StockSourceCurrentnessInput,
): Effect.Effect<void, StockSourceCurrentnessRejected> => {
  if (
    !sameRef(assertion.positionRef, input.position.ref) ||
    !sameRef(assertion.stockItemRef, input.position.scope.stockItemRef) ||
    !sameRef(assertion.stockLocationRef, input.position.scope.stockLocationRef) ||
    assertion.customerConfigurationId !== input.position.scope.customerConfigurationId
  ) {
    return Effect.fail(rejected('ASSERTION_POSITION_MISMATCH'));
  }
  if (!sameUnit(assertion.quantity.unitRef, input.position.scope.unitRef)) {
    return Effect.fail(rejected('ASSERTION_QUANTITY_MISMATCH'));
  }
  if (
    assertion.authorityConfiguration.configurationId !== input.ownerConfigurationRef.resourceId ||
    assertion.authorityConfiguration.tenantId !== input.ownerConfigurationRef.tenantId
  ) {
    return Effect.fail(rejected('AUTHORITY_SCOPE_MISMATCH'));
  }
  return Effect.void;
};

const updateOnHand = (
  position: StockPosition,
  onHand: StockPositionOnHandEvidence,
): Effect.Effect<StockPosition, StockSourceCurrentnessRejected> =>
  recordOnHandEvidence(position, onHand).pipe(
    Effect.mapError((cause) => rejected('INVALID_POSITION_TRANSITION', cause)),
  );

const ownerBoundaryPassed = (evaluatedAt: string, ownerCurrentThrough: string): boolean =>
  DateTime.toEpochMillis(DateTime.makeUnsafe(evaluatedAt)) >
  DateTime.toEpochMillis(DateTime.makeUnsafe(ownerCurrentThrough));

const carryForwardUnderOwnerCurrentness = (
  input: StockSourceCurrentnessInput,
): Effect.Effect<StockPosition, StockSourceCurrentnessRejected> => {
  const { onHand } = input.position;
  if (!Schema.is(CurrentOnHandEvidenceSchema)(onHand)) {
    return Effect.succeed(input.position);
  }
  if (
    sameRef(onHand.ownerConfigurationRef, input.ownerConfigurationRef) &&
    !ownerBoundaryPassed(input.evaluatedAt, input.ownerCurrentThrough)
  ) {
    return Effect.succeed(input.position);
  }
  return updateOnHand(input.position, {
    _tag: 'STALE',
    evidenceRef: onHand.evidenceRef,
    lastKnownQuantity: onHand.quantity,
    lastObservedAt: onHand.observedAt,
    meaning: 'ON_HAND',
    ownerConfigurationRef: onHand.ownerConfigurationRef,
  });
};

const makeResult = (input: {
  readonly establishesCurrentStockGuarantee: boolean;
  readonly position: StockPosition;
  readonly reconciliationRequired: boolean;
  readonly sourceCondition: StockSourceCondition;
}): StockSourceCurrentnessResult => ({
  establishesCurrentStockGuarantee: input.establishesCurrentStockGuarantee,
  hasCurrentStockGuarantee: Schema.is(CurrentOnHandEvidenceSchema)(input.position.onHand),
  position: input.position,
  reconciliationRequired: input.reconciliationRequired,
  sourceCondition: input.sourceCondition,
});

/**
 * Applies owner-defined Currentness to one Stock Position without translating transport absence into Quantity.
 * OMITTED and UNAVAILABLE are retained as source conditions; only accepted numeric source evidence can establish
 * a new Current ON_HAND guarantee.
 */
export const evaluateStockSourceCurrentness = Effect.fn('StockSourceCurrentness.evaluate')(
  function* evaluateStockSourceCurrentness(rawInput: StockSourceCurrentnessInput) {
    const input = yield* Schema.decodeEffect(StockSourceCurrentnessInputSchema, {
      onExcessProperty: 'error',
    })(rawInput).pipe(Effect.mapError((cause) => rejected('INVALID_INPUT', cause)));
    if (input.position.lifecycle !== 'CURRENT') {
      return yield* rejected('POSITION_NOT_CURRENT');
    }
    if (input.ownerConfigurationRef.tenantId !== input.position.ref.tenantId) {
      return yield* rejected('AUTHORITY_SCOPE_MISMATCH');
    }

    const condition = input.sourceCondition;
    if (Schema.is(OmittedSourceConditionSchema)(condition) || Schema.is(UnavailableSourceConditionSchema)(condition)) {
      const position = yield* carryForwardUnderOwnerCurrentness(input);
      return makeResult({
        establishesCurrentStockGuarantee: false,
        position,
        reconciliationRequired: false,
        sourceCondition: condition,
      });
    }
    if (Schema.is(OwnerUnknownSourceConditionSchema)(condition)) {
      const position = yield* updateOnHand(input.position, {
        _tag: 'UNKNOWN',
        meaning: 'ON_HAND',
        ownerConfigurationRef: input.ownerConfigurationRef,
        unitRef: input.position.scope.unitRef,
      });
      return makeResult({
        establishesCurrentStockGuarantee: false,
        position,
        reconciliationRequired: false,
        sourceCondition: condition,
      });
    }
    if (Schema.is(MissingSourceConditionSchema)(condition)) {
      const position = yield* updateOnHand(input.position, {
        _tag: 'MISSING',
        meaning: 'ON_HAND',
        ownerConfigurationRef: input.ownerConfigurationRef,
        unitRef: input.position.scope.unitRef,
      });
      return makeResult({
        establishesCurrentStockGuarantee: false,
        position,
        reconciliationRequired: false,
        sourceCondition: condition,
      });
    }
    if (Schema.is(ConflictingSourceConditionSchema)(condition)) {
      const position = yield* updateOnHand(input.position, {
        _tag: 'INDETERMINATE',
        meaning: 'ON_HAND',
        ownerConfigurationRef: input.ownerConfigurationRef,
        unitRef: input.position.scope.unitRef,
      });
      return makeResult({
        establishesCurrentStockGuarantee: false,
        position,
        reconciliationRequired: true,
        sourceCondition: condition,
      });
    }

    const { evaluation } = condition;
    yield* exactAssertionScope(evaluation.assertion, input);
    if (Schema.is(HistoricalInventorySourceAssertionEvaluationSchema)(evaluation)) {
      const position = yield* carryForwardUnderOwnerCurrentness(input);
      return makeResult({
        establishesCurrentStockGuarantee: false,
        position,
        reconciliationRequired: false,
        sourceCondition: condition,
      });
    }
    if (Schema.is(IndeterminateInventorySourceAssertionEvaluationSchema)(evaluation)) {
      const position = yield* updateOnHand(input.position, {
        _tag: 'INDETERMINATE',
        meaning: 'ON_HAND',
        ownerConfigurationRef: input.ownerConfigurationRef,
        unitRef: input.position.scope.unitRef,
      });
      return makeResult({
        establishesCurrentStockGuarantee: false,
        position,
        reconciliationRequired: true,
        sourceCondition: condition,
      });
    }
    if (
      evaluation.postEffectOnHand.amount !== evaluation.assertion.quantity.amount ||
      !sameUnit(evaluation.postEffectOnHand.unitRef, evaluation.assertion.quantity.unitRef)
    ) {
      return yield* rejected('ASSERTION_QUANTITY_MISMATCH');
    }
    if (ownerBoundaryPassed(input.evaluatedAt, input.ownerCurrentThrough)) {
      const position = yield* updateOnHand(input.position, {
        _tag: 'STALE',
        evidenceRef: evaluation.assertion.ownerEvidenceRef,
        lastKnownQuantity: evaluation.postEffectOnHand,
        lastObservedAt: evaluation.assertion.businessObservedAt,
        meaning: 'ON_HAND',
        ownerConfigurationRef: input.ownerConfigurationRef,
      });
      return makeResult({
        establishesCurrentStockGuarantee: false,
        position,
        reconciliationRequired: false,
        sourceCondition: condition,
      });
    }
    const position = yield* updateOnHand(input.position, {
      _tag: 'CURRENT',
      evidenceRef: evaluation.assertion.ownerEvidenceRef,
      meaning: 'ON_HAND',
      observedAt: evaluation.assertion.businessObservedAt,
      ownerConfigurationRef: input.ownerConfigurationRef,
      quantity: evaluation.postEffectOnHand,
    });
    return makeResult({
      establishesCurrentStockGuarantee: true,
      position,
      reconciliationRequired: false,
      sourceCondition: condition,
    });
  },
);
