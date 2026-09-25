import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CatalogToStockBindingSchema } from '../../shared/domain/catalog-to-stock-binding.ts';
import {
  ExactUnresolvedReservationEffectConstraintSchema,
  ExternalStockSourceAssertionEvidenceSchema,
  IndeterminateUnresolvedReservationEffectConstraintSchema,
  MissingExternalStockSourceEvidenceSchema,
} from '../../shared/domain/current-stock-evidence-for-availability.ts';
import { CurrentStockEvidenceForAvailabilityUnavailable } from '../../shared/domain/current-stock-evidence-for-availability-unavailable.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import {
  InventoryObligationRequirementSchema,
  RuntimeCommittedInventoryObligationSchema,
} from '../../shared/domain/inventory-obligation.ts';
import {
  IndeterminateReservationCreateEffectSchema,
  InventoryReservationCreateRequestSchema,
  ReconciliationRequiredReservationCreateEffectSchema,
} from '../../shared/domain/inventory-reservation-create.ts';
import {
  IndeterminateInventorySourceAssertionEvaluationSchema,
  InventorySourceAssertionSchema,
} from '../../shared/domain/inventory-source-assertion.ts';
import { PhysicalStockEffectRecordSchema } from '../../shared/domain/physical-stock-effect.ts';
import {
  CurrentOnHandEvidenceSchema,
  CurrentSuccessfulAllocationQuantitySchema,
  StockPositionSchema,
} from '../../shared/domain/stock-position.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { StockLocationSchema } from '../../shared/domain/stock-location.ts';
import type { CurrentStockEvidenceForAvailabilityDependencies } from '../../src/services/current-stock-evidence-for-availability.service.ts';
import { makeCurrentStockEvidenceForAvailabilityService } from '../../src/services/current-stock-evidence-for-availability.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const positionId = '22222222-2222-4222-8222-222222222222';
const itemId = '33333333-3333-4333-8333-333333333333';
const locationId = '44444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';
const configurationId = '66666666-6666-4666-8666-666666666666';
const bindingId = '77777777-7777-4777-8777-777777777777';
const reservationId = '88888888-8888-4888-8888-888888888888';
const effectId = '99999999-9999-4999-8999-999999999999';
const assertionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const timestamp = '2026-09-24T10:00:00.000Z';
const customerConfigurationId = 'customer-configuration-primary';
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
const positionRef = {
  moduleId: 'commerce.inventory',
  resourceId: positionId,
  resourceType: 'commerce.inventory.stock-position',
  tenantId,
} as const;
const locationRef = {
  moduleId: 'commerce.inventory',
  resourceId: locationId,
  resourceType: 'commerce.inventory.stock-location',
  tenantId,
} as const;
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});
const meaning = { id: 'catalog:meaning:1', kind: 'PRODUCT_VARIANT' as const };
const stockItem = Schema.decodeUnknownSync(StockItemSchema)({
  createdAt: timestamp,
  exactSelectionMeaning: meaning,
  lifecycle: 'CURRENT',
  retiredAt: null,
  revision: 1,
  stockItemRef: itemRef,
  unitRef,
});
const stockLocation = Schema.decodeUnknownSync(StockLocationSchema)({
  displayName: 'Prague warehouse',
  lifecycle: { _tag: 'ACTIVE' },
  operationalScope: { _tag: 'PHYSICAL_SITE', physicalSiteKeys: ['site:prague'] },
  ref: locationRef,
  revision: 1,
});
const inactiveStockLocations = [
  Schema.decodeUnknownSync(StockLocationSchema)({
    ...stockLocation,
    lifecycle: { _tag: 'RETIRED', reason: 'Closed', transitionedAt: timestamp },
  }),
  Schema.decodeUnknownSync(StockLocationSchema)({
    ...stockLocation,
    lifecycle: {
      _tag: 'REPLACED',
      reason: 'Replaced',
      successorRef: { ...locationRef, resourceId: '16161616-1616-4616-8616-161616161616' },
      transitionedAt: timestamp,
    },
  }),
  Schema.decodeUnknownSync(StockLocationSchema)({
    ...stockLocation,
    lifecycle: {
      _tag: 'MERGED',
      reason: 'Merged',
      successorRef: { ...locationRef, resourceId: '17171717-1717-4717-8717-171717171717' },
      transitionedAt: timestamp,
    },
  }),
] as const;
const binding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
  bindingRef: {
    moduleId: 'commerce.inventory',
    resourceId: bindingId,
    resourceType: 'commerce.inventory.catalog-to-stock-binding',
    tenantId,
  },
  catalogSelection: selection,
  effectiveFrom: timestamp,
  exactSelectionMeaning: meaning,
  revision: 3,
  stockItemRef: itemRef,
  unitRef,
});
const authority = (backend: 'external_business_system' | 'ontos_wms' = 'ontos_wms') =>
  Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
    configurationId,
    customerConfigurationId,
    revision: 1,
    selectedAt: '2026-09-24T09:00:00.000Z',
    selection: {
      backend,
      backendId: backend === 'ontos_wms' ? 'ontos-wms-primary' : 'erp-primary',
      exactReservationCapability: 'SUPPORTED',
      stockCorrectionCapability: 'SUPPORTED',
    },
    tenantId,
  });
const position = (backend: 'external_business_system' | 'ontos_wms' = 'ontos_wms') =>
  Schema.decodeUnknownSync(StockPositionSchema)({
    createdAt: timestamp,
    endedAt: null,
    lifecycle: 'CURRENT',
    onHand: {
      _tag: 'CURRENT',
      evidenceRef: backend === 'ontos_wms' ? 'wms:position:42' : 'erp:snapshot:42',
      meaning: 'ON_HAND',
      observedAt: timestamp,
      ownerConfigurationRef: {
        moduleId: 'commerce.inventory',
        resourceId: configurationId,
        resourceType: 'commerce.inventory.inventory-backend-configuration',
        tenantId,
      },
      quantity: { amount: '10', unitRef },
    },
    ref: positionRef,
    revision: 4,
    scope: { customerConfigurationId, stockItemRef: itemRef, stockLocationRef: locationRef, unitRef },
  });
const allocation = Schema.decodeUnknownSync(CurrentSuccessfulAllocationQuantitySchema)({
  allocationId: 'allocation-provisional-1',
  positionRef,
  quantity: { amount: '3', unitRef },
  status: 'CURRENT_SUCCESSFUL',
});
const requirement = Schema.decodeUnknownSync(InventoryObligationRequirementSchema)({
  allocations: [
    {
      allocationId: 'allocation-committed-1',
      positionRef,
      quantity: { amount: '2', unitRef },
      stockItemRef: itemRef,
    },
  ],
  bindingRef: binding.bindingRef,
  catalogSelection: selection,
  exactSelectionMeaning: meaning,
  purchaseDemandOccurrenceId: 'demand-1',
  quantity: '2',
  stockItem,
  unitRef,
});
const committed = Schema.decodeUnknownSync(RuntimeCommittedInventoryObligationSchema)({
  authority: authority(),
  confirmationTerminationReleasesStock: false,
  establishedAt: timestamp,
  historicalBindingPolicy: 'PRESERVE_AND_RECONCILE',
  lifecycleMeaning: 'COMMITTED_OBLIGATION',
  obligationReductionCreatesOnHand: false,
  orderProof: {
    acceptedOrderId: 'accepted-order-1',
    attemptId: 'attempt-committed-1',
    authority: 'ORDER_COMMIT_PROOF_AUTHORITY',
    commitStatus: 'COMMITTED',
    evidenceRef: 'order-proof:1',
    observedAt: '2026-09-24T10:05:00.000Z',
    reservationRef: {
      moduleId: 'commerce.inventory',
      resourceId: reservationId,
      resourceType: 'commerce.inventory.inventory-reservation',
      tenantId,
    },
    tenantId,
  },
  origin: { attemptId: 'attempt-committed-1', kind: 'ORDER_COMMITMENT_ATTEMPT' },
  physicalIssueBoundary: 'SEPARATE_INVENTORY_TRANSITION',
  ref: {
    moduleId: 'commerce.inventory',
    resourceId: reservationId,
    resourceType: 'commerce.inventory.inventory-reservation',
    tenantId,
  },
  remainingQuantityConstraint: 'OWNER_GOVERNED_TRANSITION_REQUIRED',
  requirements: [requirement],
});

const createRequest = Schema.decodeUnknownSync(InventoryReservationCreateRequestSchema)({
  authority: authority(),
  commerceContext: {
    channel: 'B2C',
    commerceMarketRef: {
      moduleId: 'commerce.market-catalog',
      resourceId: 'market-primary',
      resourceType: 'commerce.market-catalog.market',
      tenantId,
    },
    customerConfigurationId,
    evidenceRef: 'commerce-context:1',
    observedAt: timestamp,
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
    status: 'CURRENT_OWNER_VERIFIED',
    storefrontRef: { appId: 'storefront-primary', tenantId },
    tenantId,
  },
  effectId: 'reservation-create-effect-1',
  legalEntityId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  mutationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  requestedAt: timestamp,
  reservation: {
    origin: { attemptId: 'attempt-create-1', kind: 'ORDER_COMMITMENT_ATTEMPT' },
    ref: {
      moduleId: 'commerce.inventory',
      resourceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      resourceType: 'commerce.inventory.inventory-reservation',
      tenantId,
    },
    requirements: [requirement],
  },
  sourceActionInvocationId: '12121212-1212-4212-8212-121212121212',
});
const exactConstraint = Schema.decodeUnknownSync(ReconciliationRequiredReservationCreateEffectSchema)({
  _tag: 'RECONCILIATION_REQUIRED',
  constrainedAllocations: [
    {
      allocationId: 'allocation-partial-1',
      quantity: { amount: '6', unitRef },
      stockItemRef: itemRef,
      stockPositionRef: positionRef,
    },
  ],
  observedAt: '2026-09-24T10:10:00.000Z',
  ownerEvidenceRef: 'erp:hold:partial-1',
  request: createRequest,
});
const indeterminateConstraint = Schema.decodeUnknownSync(IndeterminateReservationCreateEffectSchema)({
  _tag: 'INDETERMINATE',
  observedAt: '2026-09-24T10:11:00.000Z',
  possibleConstrainedAllocations: [
    {
      allocationId: 'allocation-possible-1',
      quantity: { amount: '4', unitRef },
      stockItemRef: itemRef,
      stockPositionRef: positionRef,
    },
  ],
  reason: 'BACKEND_OUTCOME_UNKNOWN',
  request: { ...createRequest, effectId: 'reservation-create-effect-2' },
});

const externalAuthority = authority('external_business_system');
const sourceAssertion = Schema.decodeUnknownSync(InventorySourceAssertionSchema)({
  assertionId,
  authorityConfiguration: externalAuthority,
  businessObservedAt: timestamp,
  coverage: [{ assertionId, effectId, ownerEvidenceRef: 'erp:coverage:issue-1', relation: 'UNKNOWN' }],
  customerConfigurationId,
  factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
  issuer: { backendId: 'erp-primary', backendKind: 'external_business_system' },
  issuerAuthority: 'SELECTED_BACKEND',
  itemCorrelationRef: {
    moduleId: 'commerce.inventory',
    resourceId: '13131313-1313-4313-8313-131313131313',
    resourceType: 'commerce.inventory.external-stock-correlation',
    tenantId,
  },
  itemExternalKey: {
    customerConfigurationId,
    externalScope: 'warehouse:prague',
    externalValue: 'ITEM-1',
    identifierKind: 'ITEM',
    issuer: { backendId: 'erp-primary', backendKind: 'external_business_system' },
    namespace: 'inventory',
    tenantId,
  },
  locationCorrelationRef: {
    moduleId: 'commerce.inventory',
    resourceId: '14141414-1414-4414-8414-141414141414',
    resourceType: 'commerce.inventory.external-stock-correlation',
    tenantId,
  },
  locationExternalKey: {
    customerConfigurationId,
    externalScope: 'warehouse:prague',
    externalValue: 'LOCATION-1',
    identifierKind: 'LOCATION',
    issuer: { backendId: 'erp-primary', backendKind: 'external_business_system' },
    namespace: 'inventory',
    tenantId,
  },
  orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '000042' },
  ownerEvidenceRef: 'erp:snapshot:42',
  positionRef,
  quantity: { amount: '10', unitRef },
  receivedAt: '2026-09-24T10:01:00.000Z',
  sourceReference: 'erp:warehouse:prague:snapshot:42',
  stockItemRef: itemRef,
  stockLocationRef: locationRef,
});
const materialIssue = Schema.decodeUnknownSync(PhysicalStockEffectRecordSchema)({
  _tag: 'APPLIED',
  evidence: {
    appliedAt: '2026-09-24T10:02:00.000Z',
    backend: 'external_business_system',
    backendConfigurationRef: {
      moduleId: 'commerce.inventory',
      resourceId: configurationId,
      resourceType: 'commerce.inventory.inventory-backend-configuration',
      tenantId,
    },
    backendEvidenceRef: 'erp:issue:1',
    backendId: 'erp-primary',
    effectId,
    issuer: 'erp-primary',
    kind: 'ISSUE',
    positionRef,
    quantity: { amount: '2', unitRef },
  },
  request: {
    actionInvocationId: '15151515-1515-4515-8515-151515151515',
    backend: 'external_business_system',
    backendConfigurationRef: {
      moduleId: 'commerce.inventory',
      resourceId: configurationId,
      resourceType: 'commerce.inventory.inventory-backend-configuration',
      tenantId,
    },
    backendId: 'erp-primary',
    customerConfigurationId,
    effectId,
    kind: 'ISSUE',
    legalEntityId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    positionRef,
    quantity: { amount: '2', unitRef },
    reason: { code: 'ORDER_FULFILLMENT', reference: 'order:1' },
    requestedAt: '2026-09-24T10:01:30.000Z',
    stockItemRef: itemRef,
    stockLocationRef: locationRef,
  },
});

const makeDependencies = (
  overrides: Partial<CurrentStockEvidenceForAvailabilityDependencies> = {},
): CurrentStockEvidenceForAvailabilityDependencies => ({
  findAuthority: () => Effect.succeed(Option.some(authority())),
  findBinding: () => Effect.succeed(Option.some(binding)),
  findStockItem: () => Effect.succeed(Option.some(stockItem)),
  findStockLocation: () => Effect.succeed(Option.some(stockLocation)),
  listCommittedObligations: () => Effect.succeed([committed]),
  listCurrentSuccessfulAllocations: () => Effect.succeed([allocation]),
  listMaterialEffects: () => Effect.succeed([]),
  readLatestSourceAssertion: () => Effect.succeed(Option.none()),
  readPosition: () => Effect.succeed(Option.some(position())),
  unresolvedCreateEffects: Effect.succeed([exactConstraint, indeterminateConstraint]),
  ...overrides,
});

describe('Current Stock Evidence for Availability', () => {
  it.effect('fails closed when the durable Stock Position does not exist', () =>
    Effect.gen(function* missingPosition() {
      const service = makeCurrentStockEvidenceForAvailabilityService(
        makeDependencies({ readPosition: () => Effect.succeed(Option.none()) }),
      );
      const failure = yield* service.read(positionRef).pipe(Effect.flip);
      expect(failure).toMatchObject({ reason: 'POSITION_NOT_FOUND' });
    }),
  );

  it.effect('keeps physical ON_HAND, derived provisional RESERVED, and committed obligations distinct', () =>
    Effect.gen(function* distinctMeanings() {
      const evidence = yield* makeCurrentStockEvidenceForAvailabilityService(makeDependencies()).read(positionRef);
      expect(Schema.is(CurrentOnHandEvidenceSchema)(evidence.position.onHand)).toBe(true);
      expect(evidence.position.onHand).toMatchObject({ quantity: { amount: '10', unitRef } });
      expect(evidence.provisionalReserved).toMatchObject({
        allocationCount: 1,
        derivation: 'CURRENT_SUCCESSFUL_RESERVATION_ALLOCATIONS',
        meaning: 'RESERVED',
        quantity: { amount: '3', unitRef },
      });
      expect(evidence.committedObligations).toHaveLength(1);
      expect(evidence.committedObligations[0]?.requirements[0]?.allocations[0]?.quantity.amount).toBe('2');
      expect(evidence.customerFacingAvailabilityPublished).toBe(false);
      expect(evidence).not.toHaveProperty('available');
      expect(evidence).not.toHaveProperty('sellable');
    }),
  );

  it.effect('retains exact owner-proven and indeterminate unresolved create-effect constraints outside RESERVED', () =>
    Effect.gen(function* unresolvedConstraints() {
      const evidence = yield* makeCurrentStockEvidenceForAvailabilityService(makeDependencies()).read(positionRef);
      const [exact, indeterminate] = evidence.unresolvedReservationEffectConstraints;
      expect(Schema.is(ExactUnresolvedReservationEffectConstraintSchema)(exact)).toBe(true);
      expect(exact).toMatchObject({
        constrainedAllocations: [{ quantity: { amount: '6', unitRef } }],
        countsTowardReserved: false,
        effectId: 'reservation-create-effect-1',
        ownerEvidenceRef: 'erp:hold:partial-1',
        provesReusableOnHand: false,
      });
      expect(Schema.is(IndeterminateUnresolvedReservationEffectConstraintSchema)(indeterminate)).toBe(true);
      expect(indeterminate).toMatchObject({
        countsTowardReserved: false,
        effectId: 'reservation-create-effect-2',
        possibleAllocations: [{ quantity: { amount: '4', unitRef } }],
        provesReusableOnHand: false,
        reason: 'BACKEND_OUTCOME_UNKNOWN',
      });
      expect(evidence.provisionalReserved).toMatchObject({ quantity: { amount: '3' } });
    }),
  );

  it.effect('exposes unknown external material coverage as INDETERMINATE without guessed ON_HAND arithmetic', () =>
    Effect.gen(function* unknownCoverage() {
      const evidence = yield* makeCurrentStockEvidenceForAvailabilityService(
        makeDependencies({
          findAuthority: () => Effect.succeed(Option.some(externalAuthority)),
          listMaterialEffects: () => Effect.succeed([materialIssue]),
          readLatestSourceAssertion: () => Effect.succeed(Option.some(sourceAssertion)),
          readPosition: () => Effect.succeed(Option.some(position('external_business_system'))),
          unresolvedCreateEffects: Effect.succeed([]),
        }),
      ).read(positionRef);
      expect(Schema.is(ExternalStockSourceAssertionEvidenceSchema)(evidence.sourceEvidence)).toBe(true);
      if (!Schema.is(ExternalStockSourceAssertionEvidenceSchema)(evidence.sourceEvidence)) {
        return;
      }
      expect(Schema.is(IndeterminateInventorySourceAssertionEvaluationSchema)(evidence.sourceEvidence.evaluation)).toBe(
        true,
      );
      expect(evidence.sourceEvidence).toMatchObject({
        evaluation: {
          assertion: {
            businessObservedAt: timestamp,
            orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '000042' },
          },
          materialEffectIds: [effectId],
          postEffectOnHand: null,
          reason: 'MATERIAL_EFFECT_COVERAGE_UNKNOWN',
        },
        physicalOnHandReusableProof: 'NOT_PROVIDED',
      });
      expect(Schema.is(CurrentOnHandEvidenceSchema)(evidence.position.onHand)).toBe(true);
      expect(evidence.position.onHand).toMatchObject({ quantity: { amount: '10' } });
      expect(JSON.stringify(evidence)).not.toContain('"amount":"8"');
    }),
  );

  it.effect('uses typed MISSING instead of fabricating zero when external assertion evidence is absent', () =>
    Effect.gen(function* missingExternalEvidence() {
      const evidence = yield* makeCurrentStockEvidenceForAvailabilityService(
        makeDependencies({
          findAuthority: () => Effect.succeed(Option.some(externalAuthority)),
          readPosition: () => Effect.succeed(Option.some(position('external_business_system'))),
          unresolvedCreateEffects: Effect.succeed([]),
        }),
      ).read(positionRef);
      expect(Schema.is(MissingExternalStockSourceEvidenceSchema)(evidence.sourceEvidence)).toBe(true);
      expect(evidence.sourceEvidence).toMatchObject({
        meaning: 'EXTERNAL_SOURCE_ASSERTION',
        physicalOnHandReusableProof: 'NOT_PROVIDED',
      });
      expect(evidence.sourceEvidence).not.toHaveProperty('quantity');
    }),
  );

  it.effect('rejects a Position returned for a different exact Resource identity', () =>
    Effect.gen(function* wrongPositionIdentity() {
      const wrongPosition = Schema.decodeUnknownSync(StockPositionSchema)({
        ...position(),
        ref: { ...positionRef, resourceId: '18181818-1818-4818-8818-181818181818' },
      });
      const failure = yield* makeCurrentStockEvidenceForAvailabilityService(
        makeDependencies({ readPosition: () => Effect.succeed(Option.some(wrongPosition)) }),
      )
        .read(positionRef)
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ reason: 'EVIDENCE_SCOPE_MISMATCH' });
    }),
  );

  it.effect('rejects every terminal Stock Location lifecycle', () =>
    Effect.gen(function* inactiveLocations() {
      const failures = yield* Effect.forEach(
        inactiveStockLocations,
        (location) =>
          makeCurrentStockEvidenceForAvailabilityService(
            makeDependencies({ findStockLocation: () => Effect.succeed(Option.some(location)) }),
          )
            .read(positionRef)
            .pipe(Effect.flip),
        { concurrency: 'unbounded' },
      );
      expect(failures).toHaveLength(3);
      expect(failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reason: 'STOCK_LOCATION_NOT_ACTIVE' }),
          expect.objectContaining({ reason: 'STOCK_LOCATION_NOT_ACTIVE' }),
          expect.objectContaining({ reason: 'STOCK_LOCATION_NOT_ACTIVE' }),
        ]),
      );
    }),
  );

  it.effect('rejects authority, binding Unit, and binding meaning scope mismatches', () =>
    Effect.gen(function* exactCrossFieldScope() {
      const wrongAuthority = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
        ...authority(),
        customerConfigurationId: 'customer-configuration-other',
      });
      const wrongUnitBinding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
        ...binding,
        unitRef: { ...unitRef, resourceId: '19191919-1919-4919-8919-191919191919' },
      });
      const wrongMeaningBinding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
        ...binding,
        exactSelectionMeaning: { id: 'catalog:meaning:other', kind: 'PRODUCT_VARIANT' },
      });
      const failures = yield* Effect.all(
        [
          makeCurrentStockEvidenceForAvailabilityService(
            makeDependencies({ findAuthority: () => Effect.succeed(Option.some(wrongAuthority)) }),
          )
            .read(positionRef)
            .pipe(Effect.flip),
          makeCurrentStockEvidenceForAvailabilityService(
            makeDependencies({ findBinding: () => Effect.succeed(Option.some(wrongUnitBinding)) }),
          )
            .read(positionRef)
            .pipe(Effect.flip),
          makeCurrentStockEvidenceForAvailabilityService(
            makeDependencies({ findBinding: () => Effect.succeed(Option.some(wrongMeaningBinding)) }),
          )
            .read(positionRef)
            .pipe(Effect.flip),
        ] as const,
        { concurrency: 3 },
      );
      expect(failures.every((failure) => failure.reason === 'EVIDENCE_SCOPE_MISMATCH')).toBe(true);
    }),
  );

  it.effect('rejects external assertion evidence bound to a different exact Location', () =>
    Effect.gen(function* externalAssertionScope() {
      const mismatchedAssertion = Schema.decodeUnknownSync(InventorySourceAssertionSchema)({
        ...sourceAssertion,
        stockLocationRef: { ...locationRef, resourceId: '20202020-2020-4020-8020-202020202020' },
      });
      const failure = yield* makeCurrentStockEvidenceForAvailabilityService(
        makeDependencies({
          findAuthority: () => Effect.succeed(Option.some(externalAuthority)),
          readLatestSourceAssertion: () => Effect.succeed(Option.some(mismatchedAssertion)),
          readPosition: () => Effect.succeed(Option.some(position('external_business_system'))),
          unresolvedCreateEffects: Effect.succeed([]),
        }),
      )
        .read(positionRef)
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ reason: 'EVIDENCE_SCOPE_MISMATCH' });
    }),
  );

  it.effect('rejects an unresolved create allocation with a mismatched Stock Item', () =>
    Effect.gen(function* unresolvedAllocationScope() {
      const mismatchedEffect = Schema.decodeUnknownSync(ReconciliationRequiredReservationCreateEffectSchema)({
        ...exactConstraint,
        constrainedAllocations: [
          {
            ...exactConstraint.constrainedAllocations[0],
            stockItemRef: { ...itemRef, resourceId: '21212121-2121-4121-8121-212121212121' },
          },
        ],
      });
      const failure = yield* makeCurrentStockEvidenceForAvailabilityService(
        makeDependencies({ unresolvedCreateEffects: Effect.succeed([mismatchedEffect]) }),
      )
        .read(positionRef)
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ reason: 'EVIDENCE_SCOPE_MISMATCH' });
    }),
  );

  it.effect('keeps missing and unavailable Stock Location reads typed and non-successful', () =>
    Effect.gen(function* typedLocationFailures() {
      const unavailable = new CurrentStockEvidenceForAvailabilityUnavailable({
        code: 'current_stock_evidence_for_availability_unavailable',
        reason: 'stock location storage unavailable',
        retryable: true,
      });
      const [missing, unavailableFailure] = yield* Effect.all(
        [
          makeCurrentStockEvidenceForAvailabilityService(
            makeDependencies({ findStockLocation: () => Effect.succeed(Option.none()) }),
          )
            .read(positionRef)
            .pipe(Effect.flip),
          makeCurrentStockEvidenceForAvailabilityService(
            makeDependencies({ findStockLocation: () => Effect.fail(unavailable) }),
          )
            .read(positionRef)
            .pipe(Effect.flip),
        ] as const,
        { concurrency: 2 },
      );
      expect(missing).toMatchObject({ reason: 'STOCK_LOCATION_NOT_FOUND' });
      expect(unavailableFailure).toBe(unavailable);
    }),
  );
});
