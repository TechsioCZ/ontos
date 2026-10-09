import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  InventoryCommittedObligationStateEvidenceSchema,
  InventorySourceObligationReconciliationInputSchema,
  InventorySourceObligationReconciliationSchema,
} from '../../shared/domain/inventory-source-obligation-reconciliation.ts';
import {
  DeterminateInventorySourceAssertionEvaluationSchema,
  HistoricalInventorySourceAssertionEvaluationSchema,
  IndeterminateInventorySourceAssertionEvaluationSchema,
  InventorySourceAssertionSchema,
} from '../../shared/domain/inventory-source-assertion.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import { PhysicalStockEffectRecordSchema } from '../../shared/domain/physical-stock-effect.ts';
import { makeInventorySourceObligationReconciliationService } from '../../src/services/inventory-source-obligation-reconciliation.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const assertionId = '22222222-2222-4222-8222-222222222222';
const positionId = '33333333-3333-4333-8333-333333333333';
const itemId = '44444444-4444-4444-8444-444444444444';
const locationId = '55555555-5555-4555-8555-555555555555';
const unitId = '66666666-6666-4666-8666-666666666666';
const configurationId = '77777777-7777-4777-8777-777777777777';
const issueId = '88888888-8888-4888-8888-888888888888';
const receiptId = '99999999-9999-4999-8999-999999999999';
const obligationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const observedAt = '2026-09-24T10:00:00.000Z';

const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const positionRef = {
  moduleId: 'commerce.inventory',
  resourceId: positionId,
  resourceType: 'commerce.inventory.stock-position',
  tenantId,
} as const;
const stockItemRef = {
  moduleId: 'commerce.inventory',
  resourceId: itemId,
  resourceType: 'commerce.inventory.stock-item',
  tenantId,
} as const;
const stockLocationRef = {
  moduleId: 'commerce.inventory',
  resourceId: locationId,
  resourceType: 'commerce.inventory.stock-location',
  tenantId,
} as const;
const authorityConfiguration = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
  configurationId,
  customerConfigurationId: 'customer-configuration:primary',
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

const coverage = (effectId: string, relation: 'EXCLUDES' | 'INCLUDES' | 'PREDATES' | 'UNKNOWN') => ({
  assertionId,
  effectId,
  ownerEvidenceRef: `erp-a:coverage:${effectId}`,
  relation,
});

const assertion = (sourceCoverage: readonly ReturnType<typeof coverage>[]) =>
  Schema.decodeUnknownSync(InventorySourceAssertionSchema)({
    assertionId,
    authorityConfiguration,
    businessObservedAt: observedAt,
    coverage: sourceCoverage,
    customerConfigurationId: authorityConfiguration.customerConfigurationId,
    factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
    issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
    issuerAuthority: 'SELECTED_BACKEND',
    itemCorrelationRef: {
      moduleId: 'commerce.inventory',
      resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      resourceType: 'commerce.inventory.external-stock-correlation',
      tenantId,
    },
    itemExternalKey: {
      customerConfigurationId: authorityConfiguration.customerConfigurationId,
      externalScope: 'warehouse:prague',
      externalValue: 'ITEM-123',
      identifierKind: 'ITEM',
      issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
      namespace: 'inventory',
      tenantId,
    },
    locationCorrelationRef: {
      moduleId: 'commerce.inventory',
      resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      resourceType: 'commerce.inventory.external-stock-correlation',
      tenantId,
    },
    locationExternalKey: {
      customerConfigurationId: authorityConfiguration.customerConfigurationId,
      externalScope: 'warehouse:prague',
      externalValue: 'LOC-123',
      identifierKind: 'LOCATION',
      issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
      namespace: 'inventory',
      tenantId,
    },
    orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '42' },
    ownerEvidenceRef: 'erp-a:snapshot:42',
    positionRef,
    quantity: { amount: '10', unitRef },
    receivedAt: '2026-09-24T12:00:00.000Z',
    sourceReference: 'erp-a:warehouse:prague:snapshot:42',
    stockItemRef,
    stockLocationRef,
  });

const physicalEffect = (effectId: string, kind: 'ISSUE' | 'RECEIPT') =>
  Schema.decodeUnknownSync(PhysicalStockEffectRecordSchema)({
    _tag: 'APPLIED',
    evidence: {
      appliedAt: '2026-09-24T11:00:00.000Z',
      backend: 'external_business_system',
      backendConfigurationRef: {
        moduleId: 'commerce.inventory',
        resourceId: configurationId,
        resourceType: 'commerce.inventory.inventory-backend-configuration',
        tenantId,
      },
      backendEvidenceRef: `erp-a:${kind.toLowerCase()}:42`,
      backendId: 'erp-a',
      effectId,
      issuer: 'erp-a',
      kind,
      positionRef,
      quantity: { amount: '5', unitRef },
    },
    request: {
      actionInvocationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      backend: 'external_business_system',
      backendConfigurationRef: {
        moduleId: 'commerce.inventory',
        resourceId: configurationId,
        resourceType: 'commerce.inventory.inventory-backend-configuration',
        tenantId,
      },
      backendId: 'erp-a',
      customerConfigurationId: authorityConfiguration.customerConfigurationId,
      effectId,
      kind,
      legalEntityId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      positionRef,
      quantity: { amount: '5', unitRef },
      reason: { code: 'ORDER_FULFILLMENT', reference: 'order:42/line:1' },
      requestedAt: '2026-09-24T10:30:00.000Z',
      stockItemRef,
      stockLocationRef,
    },
  });

const obligationState = (remainingAmount: string, observed: string, evidenceSuffix: string) =>
  Schema.decodeUnknownSync(InventoryCommittedObligationStateEvidenceSchema)({
    obligationRef: {
      moduleId: 'commerce.inventory',
      resourceId: obligationId,
      resourceType: 'commerce.inventory.inventory-reservation',
      tenantId,
    },
    observedAt: observed,
    ownerEvidenceRef: `erp-a:obligation:${evidenceSuffix}`,
    positionRef,
    remainingQuantity: { amount: remainingAmount, unitRef },
    stockItemRef,
  });

const obligationHistory = [
  obligationState('5', '2026-09-24T10:05:00.000Z', 'committed'),
  obligationState('0', '2026-09-24T11:05:00.000Z', 'reduced'),
];
const service = makeInventorySourceObligationReconciliationService();

const reconcile = (
  sourceCoverage: readonly ReturnType<typeof coverage>[],
  physicalEffects: readonly ReturnType<typeof physicalEffect>[],
) =>
  service.reconcile(
    Schema.decodeUnknownSync(InventorySourceObligationReconciliationInputSchema)({
      assertion: assertion(sourceCoverage),
      committedObligationEvidence: obligationHistory,
      physicalEffects,
    }),
  );

describe('Inventory Source, obligation, and physical-effect reconciliation', () => {
  it.effect('preserves an absolute assertion that includes an Issue without applying the Issue twice', () =>
    Effect.gen(function* includedIssue() {
      const issue = physicalEffect(issueId, 'ISSUE');
      const result = yield* reconcile([coverage(issueId, 'INCLUDES')], [issue]);

      expect(Schema.is(DeterminateInventorySourceAssertionEvaluationSchema)(result.evaluation)).toBe(true);
      expect(result.evaluation).toMatchObject({
        postEffectOnHand: { amount: '10', unitRef },
        reconciliationRequired: false,
      });
      expect(result.sourceAssertion.assertionId).toBe(assertionId);
      expect(result.physicalEffects).toEqual([issue]);
      expect(result.committedObligationEvidence).toEqual(obligationHistory);
      expect(Schema.is(InventorySourceObligationReconciliationSchema)(result)).toBe(true);
      expect(result.obligationAdjustmentAppliedToOnHand).toBe(false);
      expect(result.physicalEffectsExecuted).toBe(false);
      expect(result).not.toHaveProperty('availability');
    }),
  );

  it.effect('does not turn a snapshot excluding an Issue into Current truth after obligation reduction', () =>
    Effect.gen(function* excludedIssue() {
      const result = yield* reconcile([coverage(issueId, 'EXCLUDES')], [physicalEffect(issueId, 'ISSUE')]);

      expect(Schema.is(HistoricalInventorySourceAssertionEvaluationSchema)(result.evaluation)).toBe(true);
      expect(result.evaluation).toMatchObject({
        postEffectOnHand: null,
        reason: 'MATERIAL_EFFECT_EXCLUDED_OR_PREDATED',
      });
      expect(result.evaluation.assertion.quantity.amount).toBe('10');
      expect(result.committedObligationEvidence.at(-1)?.remainingQuantity.amount).toBe('0');
      expect(result).not.toHaveProperty('guessedOnHand');
    }),
  );

  it.effect('does not add a Receipt twice when the absolute assertion already includes it', () =>
    Effect.gen(function* includedReceipt() {
      const result = yield* reconcile([coverage(receiptId, 'INCLUDES')], [physicalEffect(receiptId, 'RECEIPT')]);

      expect(Schema.is(DeterminateInventorySourceAssertionEvaluationSchema)(result.evaluation)).toBe(true);
      expect(result.evaluation).toMatchObject({
        postEffectOnHand: { amount: '10', unitRef },
      });
      expect(result.physicalEffectsExecuted).toBe(false);
    }),
  );

  it.effect('returns typed INDETERMINATE for missing or UNKNOWN material coverage without guessed arithmetic', () =>
    Effect.gen(function* unknownCoverage() {
      const issue = physicalEffect(issueId, 'ISSUE');
      const missing = yield* reconcile([], [issue]);
      const unknown = yield* reconcile([coverage(issueId, 'UNKNOWN')], [issue]);

      expect(Schema.is(IndeterminateInventorySourceAssertionEvaluationSchema)(missing.evaluation)).toBe(true);
      expect(Schema.is(IndeterminateInventorySourceAssertionEvaluationSchema)(unknown.evaluation)).toBe(true);
      expect(missing.evaluation).toMatchObject({
        materialEffectIds: [issueId],
        postEffectOnHand: null,
        reason: 'MATERIAL_EFFECT_COVERAGE_MISSING',
        reconciliationRequired: true,
      });
      expect(unknown.evaluation).toMatchObject({
        materialEffectIds: [issueId],
        postEffectOnHand: null,
        reason: 'MATERIAL_EFFECT_COVERAGE_UNKNOWN',
        reconciliationRequired: true,
      });
      expect(missing).not.toHaveProperty('guessedOnHand');
      expect(unknown).not.toHaveProperty('guessedOnHand');
    }),
  );
});
