import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { InventoryEffectLedgerRecordSchema } from '../../shared/domain/inventory-effect-ledger.ts';
import { InventoryObligationSchema } from '../../shared/domain/inventory-obligation.ts';
import {
  ExternalOpeningStockSourceSchema,
  InventoryOpeningEvaluationInputSchema,
  InventoryOpeningLegacyHoldBlockerSchema,
  LegacyUncommittedHoldFactSchema,
  InventoryOpeningNotReadySchema,
  InventoryOpeningOnHandNotCurrentBlockerSchema,
  InventoryOpeningPositionFactSchema,
  InventoryOpeningPreCutoverReservationBlockerSchema,
  InventoryOpeningReadySchema,
  InventoryOpeningUnresolvedEffectBlockerSchema,
  evaluateInventoryOpeningPacket,
} from '../../shared/domain/inventory-opening-stock-and-open-obligations.ts';
import type { InventoryOpeningEvaluationInput } from '../../shared/domain/inventory-opening-stock-and-open-obligations.ts';
import { DeterminateInventorySourceAssertionEvaluationSchema } from '../../shared/domain/inventory-source-assertion.ts';
import { CurrentOnHandEvidenceSchema, StockPositionOnHandEvidenceSchema } from '../../shared/domain/stock-position.ts';
import type { StockPositionOnHandEvidence } from '../../shared/domain/stock-position.ts';
import { ExternalStockCorrelationRefSchema } from '../../shared/resources/external-stock-correlation.ts';
import type { ExternalStockCorrelationRef } from '../../shared/resources/external-stock-correlation.ts';
import type { StockPositionRef } from '../../shared/resources/stock-position.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const configurationId = '22222222-2222-4222-8222-222222222222';
const itemId = '33333333-3333-4333-8333-333333333333';
const locationId = '44444444-4444-4444-8444-444444444444';
const positionId = '55555555-5555-4555-8555-555555555555';
const unitId = '66666666-6666-4666-8666-666666666666';
const bindingId = '77777777-7777-4777-8777-777777777777';
const customerConfigurationId = 'customer-configuration-primary';
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
const configurationRef = {
  moduleId: 'commerce.inventory',
  resourceId: configurationId,
  resourceType: 'commerce.inventory.inventory-backend-configuration',
  tenantId,
} as const;
const selection = {
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: '88888888-8888-4888-8888-888888888888',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: '99999999-9999-4999-8999-999999999999',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
} as const;
const exactSelectionMeaning = { id: 'catalog-owner:selection-1', kind: 'PRODUCT_VARIANT' } as const;

const configuration = (backend: 'external_business_system' | 'ontos_wms', backendId: string) => ({
  configurationId,
  customerConfigurationId,
  revision: 1,
  selectedAt: '2026-09-24T09:00:00.000Z',
  selection: {
    backend,
    backendId,
    exactReservationCapability: 'SUPPORTED',
    stockCorrectionCapability: backend === 'ontos_wms' ? 'SUPPORTED' : 'UNSUPPORTED',
  },
  tenantId,
});

const stockItem = {
  createdAt: '2026-09-24T08:00:00.000Z',
  exactSelectionMeaning,
  lifecycle: 'CURRENT',
  retiredAt: null,
  revision: 1,
  stockItemRef: itemRef,
  unitRef,
} as const;
const binding = {
  bindingRef: {
    moduleId: 'commerce.inventory',
    resourceId: bindingId,
    resourceType: 'commerce.inventory.catalog-to-stock-binding',
    tenantId,
  },
  catalogSelection: selection,
  effectiveFrom: '2026-09-24T08:30:00.000Z',
  exactSelectionMeaning,
  revision: 1,
  stockItemRef: itemRef,
  unitRef,
} as const;

const position = (onHand: StockPositionOnHandEvidence, ref: StockPositionRef = positionRef) => ({
  createdAt: '2026-09-24T09:30:00.000Z',
  endedAt: null,
  lifecycle: 'CURRENT',
  onHand,
  ref,
  revision: 3,
  scope: { customerConfigurationId, stockItemRef: itemRef, stockLocationRef: locationRef, unitRef },
});

const currentOnHand = (amount = '0', evidenceRef = 'wms:on-hand:42') =>
  Schema.decodeUnknownSync(StockPositionOnHandEvidenceSchema)({
    _tag: 'CURRENT',
    evidenceRef,
    meaning: 'ON_HAND',
    observedAt,
    ownerConfigurationRef: configurationRef,
    quantity: { amount, unitRef },
  });

const decodeInput = Schema.decodeUnknownSync(InventoryOpeningEvaluationInputSchema, { onExcessProperty: 'error' });
const wmsInput = (overrides: Partial<InventoryOpeningEvaluationInput> = {}) =>
  decodeInput({
    bindings: [binding],
    effectLedger: [],
    evaluatedAt,
    legacyUncommittedHolds: [],
    obligations: [],
    selectedConfiguration: configuration('ontos_wms', 'ontos-wms-primary'),
    stockItems: [stockItem],
    stockPositions: [
      {
        position: position(currentOnHand()),
        source: { _tag: 'ONTOS_WMS_OWNER_EVIDENCE', ownerEvidenceRef: 'wms:on-hand:42' },
      },
    ],
    ...overrides,
  });

const requirement = {
  allocations: [
    {
      allocationId: 'allocation-1',
      positionRef,
      quantity: { amount: '5', unitRef },
      stockItemRef: itemRef,
    },
  ],
  bindingRef: binding.bindingRef,
  catalogSelection: selection,
  exactSelectionMeaning,
  purchaseDemandOccurrenceId: 'demand-occurrence-1',
  quantity: '5',
  stockItem,
  unitRef,
} as const;

const provisional = (authority = configuration('ontos_wms', 'ontos-wms-primary')) =>
  Schema.decodeUnknownSync(InventoryObligationSchema)({
    authority,
    establishedAt: observedAt,
    lifecycleMeaning: 'PROVISIONAL_RESERVATION',
    origin: { attemptId: 'attempt-1', kind: 'ORDER_COMMITMENT_ATTEMPT' },
    ref: {
      moduleId: 'commerce.inventory',
      resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      resourceType: 'commerce.inventory.inventory-reservation',
      tenantId,
    },
    requirements: [requirement],
  });

const externalInput = () => {
  const selectedConfiguration = configuration('external_business_system', 'erp-primary');
  const itemCorrelationRef = Schema.decodeUnknownSync(ExternalStockCorrelationRefSchema)({
    moduleId: 'commerce.inventory',
    resourceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    resourceType: 'commerce.inventory.external-stock-correlation',
    tenantId,
  });
  const locationCorrelationRef = Schema.decodeUnknownSync(ExternalStockCorrelationRefSchema)({
    ...itemCorrelationRef,
    resourceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  });
  const itemExternalKey = {
    customerConfigurationId,
    externalScope: 'warehouse:prague',
    externalValue: 'ITEM-42',
    identifierKind: 'ITEM',
    issuer: { backendId: 'erp-primary', backendKind: 'external_business_system' },
    namespace: 'inventory',
    tenantId,
  } as const;
  const locationExternalKey = {
    ...itemExternalKey,
    externalValue: 'LOCATION-PRG',
    identifierKind: 'LOCATION',
  } as const;
  const assertion = {
    assertionId: '12121212-1212-4121-8121-121212121212',
    authorityConfiguration: selectedConfiguration,
    businessObservedAt: observedAt,
    coverage: [],
    customerConfigurationId,
    factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
    issuer: { backendId: 'erp-primary', backendKind: 'external_business_system' },
    issuerAuthority: 'SELECTED_BACKEND',
    itemCorrelationRef,
    itemExternalKey,
    locationCorrelationRef,
    locationExternalKey,
    orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '42' },
    ownerEvidenceRef: 'erp-primary:snapshot:42',
    positionRef,
    quantity: { amount: '7', unitRef },
    receivedAt: evaluatedAt,
    sourceReference: 'erp-primary:warehouse:prague:snapshot:42',
    stockItemRef: itemRef,
    stockLocationRef: locationRef,
  } as const;
  const correlation = (
    correlationRef: ExternalStockCorrelationRef,
    externalKey: typeof itemExternalKey | typeof locationExternalKey,
    target: { readonly _tag: 'STOCK_ITEM' | 'STOCK_LOCATION'; readonly ref: typeof itemRef | typeof locationRef },
  ) => ({
    confirmedAt: observedAt,
    correlationRef,
    effectivePeriod: { from: '2026-09-24T08:00:00.000Z', to: null },
    externalKey,
    lifecycle: 'CURRENT',
    ownerEvidenceRef: `correlation:${externalKey.externalValue}`,
    revision: 1,
    target,
  });
  return decodeInput({
    bindings: [binding],
    effectLedger: [],
    evaluatedAt,
    legacyUncommittedHolds: [],
    obligations: [],
    selectedConfiguration,
    stockItems: [stockItem],
    stockPositions: [
      {
        position: position(currentOnHand('7', assertion.ownerEvidenceRef)),
        source: {
          _tag: 'EXTERNAL_SOURCE_ASSERTION',
          evaluation: {
            _tag: 'DETERMINATE',
            assertion,
            postEffectOnHand: { amount: '7', unitRef },
            reconciliationRequired: false,
          },
          itemCorrelation: correlation(itemCorrelationRef, itemExternalKey, { _tag: 'STOCK_ITEM', ref: itemRef }),
          locationCorrelation: correlation(locationCorrelationRef, locationExternalKey, {
            _tag: 'STOCK_LOCATION',
            ref: locationRef,
          }),
        },
      },
    ],
  });
};

describe('Inventory opening stock and open obligations', () => {
  it('assembles exact Current absolute ON_HAND, including explicit zero, without deriving Availability', () => {
    const input = wmsInput();
    const result = evaluateInventoryOpeningPacket(input);

    expect(Schema.is(InventoryOpeningReadySchema)(result)).toBe(true);
    if (Schema.is(InventoryOpeningReadySchema)(result)) {
      expect(result.packet.selectedConfiguration).toEqual(input.selectedConfiguration);
      expect(result.packet.stock).toEqual([
        {
          binding: input.bindings[0],
          item: input.stockItems[0],
          position: input.stockPositions[0]?.position,
          source: input.stockPositions[0]?.source,
        },
      ]);
      const onHand = result.packet.stock[0]?.position.onHand;
      expect(onHand !== undefined && Schema.is(CurrentOnHandEvidenceSchema)(onHand)).toBe(true);
      if (onHand !== undefined && Schema.is(CurrentOnHandEvidenceSchema)(onHand)) {
        expect(onHand.meaning).toBe('ON_HAND');
        expect(onHand.quantity.amount).toBe('0');
      }
      expect(result.packet).not.toHaveProperty('availability');
    }
  });

  it('preserves runtime and imported committed obligation identities and their historical authorities verbatim', () => {
    const runtime = Schema.decodeUnknownSync(InventoryObligationSchema)({
      ...provisional(),
      confirmationTerminationReleasesStock: false,
      historicalBindingPolicy: 'PRESERVE_AND_RECONCILE',
      lifecycleMeaning: 'COMMITTED_OBLIGATION',
      obligationReductionCreatesOnHand: false,
      orderProof: {
        acceptedOrderId: 'order-1',
        attemptId: 'attempt-1',
        authority: 'ORDER_COMMIT_PROOF_AUTHORITY',
        commitStatus: 'COMMITTED',
        evidenceRef: 'order-proof-1',
        observedAt,
        reservationRef: provisional().ref,
        tenantId,
      },
      physicalIssueBoundary: 'SEPARATE_INVENTORY_TRANSITION',
      remainingQuantityConstraint: 'OWNER_GOVERNED_TRANSITION_REQUIRED',
    });
    const imported = Schema.decodeUnknownSync(InventoryObligationSchema)({
      authority: { ...configuration('external_business_system', 'legacy-erp'), configurationId },
      importedAt: observedAt,
      lifecycleMeaning: 'COMMITTED_OBLIGATION',
      orderProof: {
        acceptedOrderId: 'legacy-order',
        authority: 'ORDER_MIGRATION_PROOF_AUTHORITY',
        commitStatus: 'COMMITTED',
        evidenceRef: 'legacy-order-proof',
        observedAt,
        sourceOrderId: 'legacy-order-42',
        sourceSystem: 'legacy-erp',
      },
      origin: {
        kind: 'IMPORTED_PROVEN_ORDER',
        sourceObligationId: 'legacy-obligation-42',
        sourceOrderId: 'legacy-order-42',
        sourceSystem: 'legacy-erp',
      },
      ref: {
        moduleId: 'commerce.inventory',
        resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        resourceType: 'commerce.inventory.imported-committed-obligation',
        tenantId,
      },
      requirements: [requirement],
      runtimeAttemptId: null,
    });
    const input = wmsInput({ obligations: [runtime, imported] });
    const result = evaluateInventoryOpeningPacket(input);

    expect(Schema.is(InventoryOpeningReadySchema)(result)).toBe(true);
    if (Schema.is(InventoryOpeningReadySchema)(result)) {
      expect(result.packet.obligations).toEqual([runtime, imported]);
      expect(result.packet.obligations[1]).toMatchObject({
        authority: { selection: { backendId: 'legacy-erp' } },
        origin: { kind: 'IMPORTED_PROVEN_ORDER', sourceObligationId: 'legacy-obligation-42' },
        runtimeAttemptId: null,
      });
    }
  });

  it('retains external source revision, business time, issuer origin, and exact correlation qualification', () => {
    const input = externalInput();
    const result = evaluateInventoryOpeningPacket(input);

    expect(Schema.is(InventoryOpeningReadySchema)(result)).toBe(true);
    if (Schema.is(InventoryOpeningReadySchema)(result)) {
      const source = result.packet.stock[0]?.source;
      expect(source !== undefined && Schema.is(ExternalOpeningStockSourceSchema)(source)).toBe(true);
      if (
        source !== undefined &&
        Schema.is(ExternalOpeningStockSourceSchema)(source) &&
        Schema.is(DeterminateInventorySourceAssertionEvaluationSchema)(source.evaluation)
      ) {
        expect(source.evaluation.assertion.businessObservedAt).toBe(observedAt);
        expect(source.evaluation.assertion.issuer).toEqual({
          backendId: 'erp-primary',
          backendKind: 'external_business_system',
        });
        expect(source.evaluation.assertion.orderingEvidence).toMatchObject({ revision: '42' });
        expect(source.itemCorrelation.externalKey).toMatchObject({
          externalScope: 'warehouse:prague',
          externalValue: 'ITEM-42',
          identifierKind: 'ITEM',
          namespace: 'inventory',
        });
      }
    }
  });

  it('keeps UNKNOWN, MISSING, STALE, and INDETERMINATE distinct instead of guessing numeric stock', () => {
    const facts = (
      [
        { _tag: 'UNKNOWN', meaning: 'ON_HAND', ownerConfigurationRef: configurationRef, unitRef },
        { _tag: 'MISSING', meaning: 'ON_HAND', ownerConfigurationRef: configurationRef, unitRef },
        {
          _tag: 'STALE',
          evidenceRef: 'wms:on-hand:old',
          lastKnownQuantity: { amount: '8', unitRef },
          lastObservedAt: observedAt,
          meaning: 'ON_HAND',
          ownerConfigurationRef: configurationRef,
        },
        { _tag: 'INDETERMINATE', meaning: 'ON_HAND', ownerConfigurationRef: configurationRef, unitRef },
      ] as const
    ).map((onHand, index) =>
      Schema.decodeUnknownSync(InventoryOpeningPositionFactSchema)({
        position: position(Schema.decodeUnknownSync(StockPositionOnHandEvidenceSchema)(onHand), {
          ...positionRef,
          resourceId: `${index + 1}5555555-5555-4555-8555-555555555555`,
        }),
        source: { _tag: 'ONTOS_WMS_OWNER_EVIDENCE', ownerEvidenceRef: `wms:state:${index}` },
      }),
    );
    const input = wmsInput({ stockPositions: facts });
    const result = evaluateInventoryOpeningPacket(input);

    expect(Schema.is(InventoryOpeningNotReadySchema)(result)).toBe(true);
    if (Schema.is(InventoryOpeningNotReadySchema)(result)) {
      expect(result.blockers.filter(Schema.is(InventoryOpeningOnHandNotCurrentBlockerSchema))).toEqual([
        expect.objectContaining({ evidenceState: 'UNKNOWN' }),
        expect.objectContaining({ evidenceState: 'MISSING' }),
        expect.objectContaining({ evidenceState: 'STALE' }),
        expect.objectContaining({ evidenceState: 'INDETERMINATE' }),
      ]);
      expect(result.evaluatedFacts.stockPositions).toEqual(facts);
    }
  });

  it('globally blocks a pre-cutover provisional Reservation, unresolved effect, and unproven legacy hold', () => {
    const oldAuthority = {
      ...configuration('external_business_system', 'legacy-erp'),
      configurationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    };
    const unresolved = Schema.decodeUnknownSync(InventoryEffectLedgerRecordSchema)({
      currentState: 'INDETERMINATE',
      effectId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      intent: {
        _tag: 'RESERVATION_CREATE',
        request: {
          authority: oldAuthority,
          commerceContext: {
            channel: 'B2C',
            commerceMarketRef: {
              moduleId: 'commerce.market-catalog',
              resourceId: 'market-cz',
              resourceType: 'commerce.market-catalog.market',
              tenantId,
            },
            customerConfigurationId,
            evidenceRef: 'commerce-context-proof',
            observedAt,
            sellingLegalEntityRef: {
              moduleId: 'core.identity',
              resourceId: 'abababab-abab-4bab-8bab-abababababab',
              resourceType: 'core.identity.legal-entity',
              tenantId,
            },
            status: 'CURRENT_OWNER_VERIFIED',
            storefrontRef: { appId: 'main-storefront', tenantId },
            tenantId,
          },
          effectId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          legalEntityId: 'abababab-abab-4bab-8bab-abababababab',
          reservation: {
            origin: provisional(oldAuthority).origin,
            ref: provisional(oldAuthority).ref,
            requirements: provisional(oldAuthority).requirements,
          },
        },
      },
      requestedAt: observedAt,
      resolution: null,
      revision: 2,
      tenantId,
      updatedAt: evaluatedAt,
    });
    const input = wmsInput({
      effectLedger: [unresolved],
      legacyUncommittedHolds: [
        Schema.decodeUnknownSync(LegacyUncommittedHoldFactSchema)({
          customerConfigurationId,
          holdReference: 'legacy-hold-42',
          state: { _tag: 'POSSIBLY_ACTIVE', observedAt, reason: 'OWNER_OUTCOME_UNKNOWN' },
          tenantId,
        }),
      ],
      obligations: [provisional(oldAuthority)],
    });
    const result = evaluateInventoryOpeningPacket(input);

    expect(Schema.is(InventoryOpeningNotReadySchema)(result)).toBe(true);
    if (Schema.is(InventoryOpeningNotReadySchema)(result)) {
      expect(result.blockers.some(Schema.is(InventoryOpeningPreCutoverReservationBlockerSchema))).toBe(true);
      expect(result.blockers.some(Schema.is(InventoryOpeningUnresolvedEffectBlockerSchema))).toBe(true);
      expect(result.blockers.some(Schema.is(InventoryOpeningLegacyHoldBlockerSchema))).toBe(true);
    }
  });
});
