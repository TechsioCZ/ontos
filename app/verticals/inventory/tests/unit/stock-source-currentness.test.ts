import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  InventorySourceAssertionEvaluationSchema,
  InventorySourceAssertionSchema,
} from '../../shared/domain/inventory-source-assertion.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import {
  OmittedSourceConditionSchema,
  SourceAssertionConditionSchema,
  StockSourceCurrentnessInputSchema,
  UnavailableSourceConditionSchema,
} from '../../shared/domain/stock-source-currentness.ts';
import type {
  StockSourceCondition,
  StockSourceCurrentnessInput,
} from '../../shared/domain/stock-source-currentness.ts';
import {
  CurrentOnHandEvidenceSchema,
  IndeterminateOnHandEvidenceSchema,
  MissingOnHandEvidenceSchema,
  StaleOnHandEvidenceSchema,
  StockPositionSchema,
  UnknownOnHandEvidenceSchema,
} from '../../shared/domain/stock-position.ts';
import { InventoryBackendConfigurationRefSchema } from '../../shared/resources/inventory-backend-configuration.ts';
import { evaluateStockSourceCurrentness } from '../../src/services/stock-source-currentness.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const assertionId = '22222222-2222-4222-8222-222222222222';
const positionId = '33333333-3333-4333-8333-333333333333';
const itemId = '44444444-4444-4444-8444-444444444444';
const locationId = '55555555-5555-4555-8555-555555555555';
const unitId = '66666666-6666-4666-8666-666666666666';
const configurationId = '77777777-7777-4777-8777-777777777777';
const itemCorrelationId = '88888888-8888-4888-8888-888888888888';
const locationCorrelationId = '99999999-9999-4999-8999-999999999999';
const effectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const customerConfigurationId = 'customer-configuration:primary';
const observedAt = '2026-09-24T10:00:00.000Z';
const evaluatedAt = '2026-09-24T12:00:00.000Z';

const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const itemRef = {
  moduleId: 'commerce.inventory',
  resourceId: itemId,
  resourceType: 'commerce.inventory.stock-item',
  tenantId,
} as const;
const locationRef = {
  moduleId: 'commerce.inventory',
  resourceId: locationId,
  resourceType: 'commerce.inventory.stock-location',
  tenantId,
} as const;
const positionRef = {
  moduleId: 'commerce.inventory',
  resourceId: positionId,
  resourceType: 'commerce.inventory.stock-position',
  tenantId,
} as const;
const ownerConfigurationRef = Schema.decodeUnknownSync(InventoryBackendConfigurationRefSchema)({
  moduleId: 'commerce.inventory',
  resourceId: configurationId,
  resourceType: 'commerce.inventory.inventory-backend-configuration',
  tenantId,
});

const configuration = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
  configurationId,
  customerConfigurationId,
  revision: 1,
  selectedAt: '2026-09-24T09:00:00.000Z',
  selection: {
    backend: 'external_business_system',
    backendId: 'erp-a',
    exactReservationCapability: 'SUPPORTED',
    stockCorrectionCapability: 'UNSUPPORTED',
  },
  tenantId,
});

const makePosition = (amount = '10') =>
  Schema.decodeUnknownSync(StockPositionSchema)({
    createdAt: observedAt,
    endedAt: null,
    lifecycle: 'CURRENT',
    onHand: {
      _tag: 'CURRENT',
      evidenceRef: 'erp-a:on-hand:41',
      meaning: 'ON_HAND',
      observedAt,
      ownerConfigurationRef,
      quantity: { amount, unitRef },
    },
    ref: positionRef,
    revision: 1,
    scope: { customerConfigurationId, stockItemRef: itemRef, stockLocationRef: locationRef, unitRef },
  });

const makeAssertion = (amount: string) =>
  Schema.decodeUnknownSync(InventorySourceAssertionSchema)({
    assertionId,
    authorityConfiguration: configuration,
    businessObservedAt: observedAt,
    coverage: [],
    customerConfigurationId,
    factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
    issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
    issuerAuthority: 'SELECTED_BACKEND',
    itemCorrelationRef: {
      moduleId: 'commerce.inventory',
      resourceId: itemCorrelationId,
      resourceType: 'commerce.inventory.external-stock-correlation',
      tenantId,
    },
    itemExternalKey: {
      customerConfigurationId,
      externalScope: 'warehouse:prague',
      externalValue: 'ITEM-123',
      identifierKind: 'ITEM',
      issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
      namespace: 'inventory',
      tenantId,
    },
    locationCorrelationRef: {
      moduleId: 'commerce.inventory',
      resourceId: locationCorrelationId,
      resourceType: 'commerce.inventory.external-stock-correlation',
      tenantId,
    },
    locationExternalKey: {
      customerConfigurationId,
      externalScope: 'warehouse:prague',
      externalValue: 'LOC-123',
      identifierKind: 'LOCATION',
      issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
      namespace: 'inventory',
      tenantId,
    },
    orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '000042' },
    ownerEvidenceRef: 'erp-a:snapshot:42',
    positionRef,
    quantity: { amount, unitRef },
    receivedAt: evaluatedAt,
    sourceReference: 'erp-a:warehouse:prague:snapshot:42',
    stockItemRef: itemRef,
    stockLocationRef: locationRef,
  });

const determinateEvaluation = (amount: string) =>
  Schema.decodeUnknownSync(InventorySourceAssertionEvaluationSchema)({
    _tag: 'DETERMINATE',
    assertion: makeAssertion(amount),
    postEffectOnHand: { amount, unitRef },
    reconciliationRequired: false,
  });

const input = (
  sourceCondition: StockSourceCondition,
  ownerCurrentThrough = '2026-09-24T13:00:00.000Z',
): StockSourceCurrentnessInput =>
  Schema.decodeUnknownSync(StockSourceCurrentnessInputSchema)({
    evaluatedAt,
    ownerConfigurationRef,
    ownerCurrentThrough,
    position: makePosition(),
    sourceCondition,
  });

describe('Inventory source absence, zero, and Currentness', () => {
  it.effect('treats only an authoritative Current numeric zero as known zero', () =>
    Effect.gen(function* explicitZero() {
      const result = yield* evaluateStockSourceCurrentness(
        input({ _tag: 'SOURCE_ASSERTION', evaluation: determinateEvaluation('0') }),
      );

      expect(Schema.is(CurrentOnHandEvidenceSchema)(result.position.onHand)).toBe(true);
      if (Schema.is(CurrentOnHandEvidenceSchema)(result.position.onHand)) {
        expect(result.position.onHand.evidenceRef).toBe('erp-a:snapshot:42');
        expect(result.position.onHand.quantity).toEqual({ amount: '0', unitRef });
      }
      expect(result.establishesCurrentStockGuarantee).toBe(true);
      expect(result.hasCurrentStockGuarantee).toBe(true);
      expect(result.reconciliationRequired).toBe(false);
    }),
  );

  it.effect('keeps OMITTED separate and leaves still-Current prior evidence unchanged', () =>
    Effect.gen(function* omitted() {
      const prior = makePosition();
      const result = yield* evaluateStockSourceCurrentness({
        ...input({ _tag: 'OMITTED', batchRef: 'erp-a:batch:43', observedAt: evaluatedAt }),
        position: prior,
      });

      expect(Schema.is(OmittedSourceConditionSchema)(result.sourceCondition)).toBe(true);
      expect(result.position).toEqual(prior);
      expect(result.establishesCurrentStockGuarantee).toBe(false);
      expect(result.hasCurrentStockGuarantee).toBe(true);
    }),
  );

  it.effect('keeps UNAVAILABLE separate and does not invalidate still-Current evidence', () =>
    Effect.gen(function* unavailable() {
      const prior = makePosition();
      const result = yield* evaluateStockSourceCurrentness({
        ...input({ _tag: 'UNAVAILABLE', observedAt: evaluatedAt, sourceReference: 'erp-a:warehouse:prague' }),
        position: prior,
      });

      expect(Schema.is(UnavailableSourceConditionSchema)(result.sourceCondition)).toBe(true);
      expect(result.position).toEqual(prior);
      expect(result.establishesCurrentStockGuarantee).toBe(false);
      expect(result.hasCurrentStockGuarantee).toBe(true);
    }),
  );

  it.effect('does not carry Current evidence across an owner configuration change', () =>
    Effect.gen(function* ownerChanged() {
      const replacementOwner = Schema.decodeUnknownSync(InventoryBackendConfigurationRefSchema)({
        ...ownerConfigurationRef,
        resourceId: 'abababab-abab-4bab-8bab-abababababab',
      });
      const result = yield* evaluateStockSourceCurrentness({
        ...input({ _tag: 'UNAVAILABLE', observedAt: evaluatedAt, sourceReference: 'erp-b:warehouse:prague' }),
        ownerConfigurationRef: replacementOwner,
      });

      expect(Schema.is(StaleOnHandEvidenceSchema)(result.position.onHand)).toBe(true);
      if (Schema.is(StaleOnHandEvidenceSchema)(result.position.onHand)) {
        expect(result.position.onHand.ownerConfigurationRef).toEqual(ownerConfigurationRef);
        expect(result.position.onHand.lastKnownQuantity).toEqual({ amount: '10', unitRef });
      }
      expect(result.hasCurrentStockGuarantee).toBe(false);
    }),
  );

  it.effect('expires prior Current evidence to STALE while retaining exact last-known provenance', () =>
    Effect.gen(function* stale() {
      const result = yield* evaluateStockSourceCurrentness(
        input({ _tag: 'OMITTED', batchRef: 'erp-a:batch:43', observedAt: evaluatedAt }, '2026-09-24T11:59:59.999Z'),
      );

      expect(Schema.is(StaleOnHandEvidenceSchema)(result.position.onHand)).toBe(true);
      if (Schema.is(StaleOnHandEvidenceSchema)(result.position.onHand)) {
        expect(result.position.onHand.evidenceRef).toBe('erp-a:on-hand:41');
        expect(result.position.onHand.lastKnownQuantity).toEqual({ amount: '10', unitRef });
        expect(result.position.onHand.lastObservedAt).toBe(observedAt);
        expect(result.position.onHand.ownerConfigurationRef).toEqual(ownerConfigurationRef);
      }
      expect(result.position.revision).toBe(2);
      expect(result.establishesCurrentStockGuarantee).toBe(false);
      expect(result.hasCurrentStockGuarantee).toBe(false);
    }),
  );

  it.effect('never re-qualifies an assertion whose owner-defined Currentness boundary has passed', () =>
    Effect.gen(function* expiredAssertion() {
      const result = yield* evaluateStockSourceCurrentness(
        input({ _tag: 'SOURCE_ASSERTION', evaluation: determinateEvaluation('7') }, '2026-09-24T11:59:59.999Z'),
      );

      expect(Schema.is(StaleOnHandEvidenceSchema)(result.position.onHand)).toBe(true);
      if (Schema.is(StaleOnHandEvidenceSchema)(result.position.onHand)) {
        expect(result.position.onHand.evidenceRef).toBe('erp-a:snapshot:42');
        expect(result.position.onHand.lastKnownQuantity).toEqual({ amount: '7', unitRef });
      }
      expect(result.establishesCurrentStockGuarantee).toBe(false);
      expect(result.hasCurrentStockGuarantee).toBe(false);
    }),
  );

  it.effect('keeps UNKNOWN, MISSING, and conflicting evidence distinct without a zero fallback', () =>
    Effect.gen(function* unavailableStates() {
      const unknown = yield* evaluateStockSourceCurrentness(
        input({ _tag: 'OWNER_UNKNOWN', observedAt: evaluatedAt, ownerEvidenceRef: 'erp-a:unknown:43' }),
      );
      const missing = yield* evaluateStockSourceCurrentness(
        input({ _tag: 'MISSING', observedAt: evaluatedAt, reason: 'CORRELATION_NOT_FOUND' }),
      );
      const indeterminate = yield* evaluateStockSourceCurrentness(
        input({
          _tag: 'CONFLICTING',
          evidenceRefs: ['erp-a:snapshot:42', 'erp-a:snapshot:43'],
          observedAt: evaluatedAt,
        }),
      );

      expect(Schema.is(UnknownOnHandEvidenceSchema)(unknown.position.onHand)).toBe(true);
      expect(Schema.is(MissingOnHandEvidenceSchema)(missing.position.onHand)).toBe(true);
      expect(Schema.is(IndeterminateOnHandEvidenceSchema)(indeterminate.position.onHand)).toBe(true);
      expect(unknown.hasCurrentStockGuarantee).toBe(false);
      expect(missing.hasCurrentStockGuarantee).toBe(false);
      expect(indeterminate.hasCurrentStockGuarantee).toBe(false);
      expect(indeterminate.reconciliationRequired).toBe(true);
      expect(JSON.stringify([unknown, missing, indeterminate])).not.toContain('"amount":"0"');
    }),
  );

  it.effect('maps #833 material-coverage uncertainty to INDETERMINATE and retains exact assertion evidence', () =>
    Effect.gen(function* materialCoverageUnknown() {
      const assertion = makeAssertion('7');
      const evaluation = Schema.decodeUnknownSync(InventorySourceAssertionEvaluationSchema)({
        _tag: 'INDETERMINATE',
        assertion,
        materialEffectIds: [effectId],
        postEffectOnHand: null,
        reason: 'MATERIAL_EFFECT_COVERAGE_UNKNOWN',
        reconciliationRequired: true,
      });
      const result = yield* evaluateStockSourceCurrentness(input({ _tag: 'SOURCE_ASSERTION', evaluation }));

      expect(Schema.is(IndeterminateOnHandEvidenceSchema)(result.position.onHand)).toBe(true);
      expect(Schema.is(SourceAssertionConditionSchema)(result.sourceCondition)).toBe(true);
      if (Schema.is(SourceAssertionConditionSchema)(result.sourceCondition)) {
        expect(result.sourceCondition.evaluation).toEqual(evaluation);
      }
      expect(result.hasCurrentStockGuarantee).toBe(false);
      expect(result.reconciliationRequired).toBe(true);
      expect('quantity' in result.position.onHand).toBe(false);
      expect('lastKnownQuantity' in result.position.onHand).toBe(false);
    }),
  );

  it.effect('does not let historical source evidence replace a still-Current prior value', () =>
    Effect.gen(function* historical() {
      const assertion = makeAssertion('3');
      const evaluation = Schema.decodeUnknownSync(InventorySourceAssertionEvaluationSchema)({
        _tag: 'HISTORICAL',
        assertion,
        postEffectOnHand: null,
        reason: 'MATERIAL_EFFECT_EXCLUDED_OR_PREDATED',
        reconciliationRequired: false,
      });
      const prior = makePosition();
      const result = yield* evaluateStockSourceCurrentness({
        ...input({ _tag: 'SOURCE_ASSERTION', evaluation }),
        position: prior,
      });

      expect(result.position).toEqual(prior);
      expect(Schema.is(SourceAssertionConditionSchema)(result.sourceCondition)).toBe(true);
      if (Schema.is(SourceAssertionConditionSchema)(result.sourceCondition)) {
        expect(result.sourceCondition.evaluation).toEqual(evaluation);
      }
      expect(result.establishesCurrentStockGuarantee).toBe(false);
    }),
  );

  it.effect('fails typed on malformed or excess input at the runtime boundary', () =>
    Effect.gen(function* invalidInput() {
      const malformedInput = {
        ...input({ _tag: 'OMITTED', batchRef: 'erp-a:batch:43', observedAt: evaluatedAt }),
        unexpected: 'must fail closed',
      };
      const error = yield* Effect.flip(evaluateStockSourceCurrentness(malformedInput));

      expect(error.code).toBe('stock_source_currentness_rejected');
      expect(error.reason).toBe('INVALID_INPUT');
    }),
  );

  it.effect('fails typed when owner or assertion Position scope differs', () =>
    Effect.gen(function* scopeMismatch() {
      const replacementOwner = Schema.decodeUnknownSync(InventoryBackendConfigurationRefSchema)({
        ...ownerConfigurationRef,
        resourceId: 'abababab-abab-4bab-8bab-abababababab',
      });
      const ownerError = yield* Effect.flip(
        evaluateStockSourceCurrentness({
          ...input({ _tag: 'SOURCE_ASSERTION', evaluation: determinateEvaluation('5') }),
          ownerConfigurationRef: replacementOwner,
        }),
      );

      const wrongPositionAssertion = Schema.decodeUnknownSync(InventorySourceAssertionSchema)({
        ...makeAssertion('5'),
        positionRef: { ...positionRef, resourceId: 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc' },
      });
      const wrongPositionEvaluation = Schema.decodeUnknownSync(InventorySourceAssertionEvaluationSchema)({
        _tag: 'DETERMINATE',
        assertion: wrongPositionAssertion,
        postEffectOnHand: { amount: '5', unitRef },
        reconciliationRequired: false,
      });
      const positionError = yield* Effect.flip(
        evaluateStockSourceCurrentness(input({ _tag: 'SOURCE_ASSERTION', evaluation: wrongPositionEvaluation })),
      );

      expect(ownerError.reason).toBe('AUTHORITY_SCOPE_MISMATCH');
      expect(positionError.reason).toBe('ASSERTION_POSITION_MISMATCH');
    }),
  );

  it.effect('fails typed on assertion quantity mismatch and a historical Position', () =>
    Effect.gen(function* invalidPositionOrQuantity() {
      const assertion = makeAssertion('5');
      const mismatchedEvaluation = Schema.decodeUnknownSync(InventorySourceAssertionEvaluationSchema)({
        _tag: 'DETERMINATE',
        assertion,
        postEffectOnHand: { amount: '6', unitRef },
        reconciliationRequired: false,
      });
      const quantityError = yield* Effect.flip(
        evaluateStockSourceCurrentness(input({ _tag: 'SOURCE_ASSERTION', evaluation: mismatchedEvaluation })),
      );

      const current = makePosition();
      const historical = Schema.decodeUnknownSync(StockPositionSchema)({
        ...current,
        endedAt: evaluatedAt,
        lifecycle: 'HISTORICAL',
        onHand: {
          _tag: 'STALE',
          evidenceRef: 'erp-a:on-hand:41',
          lastKnownQuantity: { amount: '10', unitRef },
          lastObservedAt: observedAt,
          meaning: 'ON_HAND',
          ownerConfigurationRef,
        },
      });
      const positionError = yield* Effect.flip(
        evaluateStockSourceCurrentness({
          ...input({ _tag: 'OMITTED', batchRef: 'erp-a:batch:43', observedAt: evaluatedAt }),
          position: historical,
        }),
      );

      expect(quantityError.reason).toBe('ASSERTION_QUANTITY_MISMATCH');
      expect(positionError.reason).toBe('POSITION_NOT_CURRENT');
    }),
  );
});
