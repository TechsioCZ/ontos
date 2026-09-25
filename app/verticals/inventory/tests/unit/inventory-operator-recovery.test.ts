import { Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CatalogStockDemandSchema } from '../../shared/domain/catalog-to-stock-binding.ts';
import { CatalogToStockBindingResolutionFailure } from '../../shared/domain/catalog-to-stock-binding-resolution.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import {
  InventoryBindingFailureFindingSchema,
  InventoryCanonicalOperationalFindingSchema,
  InventoryOperationalFindingSchema,
  InventoryOperationalSubjectSchema,
  InventoryPartialCreateDebtFindingSchema,
  InventoryPartialCreateDebtInputSchema,
  InventorySourceCoverageUncertaintyFindingSchema,
  InventorySourceCoverageUncertaintyInputSchema,
  inventoryOperationalProblemKinds,
  inventoryOperationalPolicyFor,
  inventoryOperationalSubjectTagFor,
  investigateInventoryBindingFailure,
  investigateInventoryPartialCreateDebt,
  investigateInventorySourceCoverageUncertainty,
  makeInventoryOperationalFinding,
} from '../../shared/domain/inventory-operator-recovery.ts';
import type {
  InventoryOperationalProblemKind,
  InventoryOperationalSubject,
} from '../../shared/domain/inventory-operator-recovery.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const configurationId = '22222222-2222-4222-8222-222222222222';
const itemId = '33333333-3333-4333-8333-333333333333';
const locationId = '44444444-4444-4444-8444-444444444444';
const positionId = '55555555-5555-4555-8555-555555555555';
const unitId = '66666666-6666-4666-8666-666666666666';
const effectId = 'reservation-create-effect-859';
const observedAt = '2026-09-25T10:00:00.000Z';
const receivedAt = '2026-09-25T10:05:00.000Z';

const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
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
const positionRef = {
  moduleId: 'commerce.inventory',
  resourceId: positionId,
  resourceType: 'commerce.inventory.stock-position',
  tenantId,
} as const;
const reservationRef = {
  moduleId: 'commerce.inventory',
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'commerce.inventory.inventory-reservation',
  tenantId,
} as const;
const bindingRef = {
  moduleId: 'commerce.inventory',
  resourceId: '10101010-1010-4010-8010-101010101010',
  resourceType: 'commerce.inventory.catalog-to-stock-binding',
  tenantId,
} as const;
const confirmationRef = {
  moduleId: 'commerce.inventory',
  resourceId: '12121212-1212-4121-8121-121212121212',
  resourceType: 'commerce.inventory.reservation-confirmation',
  tenantId,
} as const;
const protectionRef = {
  moduleId: 'commerce.inventory',
  resourceId: '13131313-1313-4131-8131-131313131313',
  resourceType: 'commerce.inventory.commitment-protection',
  tenantId,
} as const;
const importedObligationRef = {
  moduleId: 'commerce.inventory',
  resourceId: '14141414-1414-4141-8141-141414141414',
  resourceType: 'commerce.inventory.imported-committed-obligation',
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
const authority = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
  configurationId,
  customerConfigurationId: 'customer-configuration-primary',
  revision: 1,
  selectedAt: observedAt,
  selection: {
    backend: 'external_business_system',
    backendId: 'erp-primary',
    exactReservationCapability: 'SUPPORTED',
    stockCorrectionCapability: 'UNSUPPORTED',
  },
  tenantId,
});
const demand = Schema.decodeUnknownSync(CatalogStockDemandSchema)({
  catalogSelection: selection,
  exactSelectionMeaning: { id: 'catalog-owner:selection-859', kind: 'PRODUCT_VARIANT' },
  purchaseDemandOccurrenceId: 'demand-occurrence-859',
  quantity: '6',
  unitRef,
});
const { exactSelectionMeaning } = demand;
const stockItem = {
  createdAt: observedAt,
  exactSelectionMeaning,
  lifecycle: 'CURRENT',
  retiredAt: null,
  revision: 1,
  stockItemRef,
  unitRef,
} as const;
const plannedAllocation = {
  allocationId: 'allocation-859',
  positionRef,
  quantity: { amount: '6', unitRef },
  stockItemRef,
} as const;
const reservationCreateRequest = {
  authority,
  commerceContext: {
    channel: 'B2C',
    commerceMarketRef: {
      moduleId: 'commerce.market-catalog',
      resourceId: 'market-primary',
      resourceType: 'commerce.market-catalog.market',
      tenantId,
    },
    customerConfigurationId: authority.customerConfigurationId,
    evidenceRef: 'commerce-context:859',
    observedAt,
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: '15151515-1515-4151-8151-151515151515',
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
    status: 'CURRENT_OWNER_VERIFIED',
    storefrontRef: { appId: 'storefront-primary', tenantId },
    tenantId,
  },
  effectId,
  legalEntityId: '15151515-1515-4151-8151-151515151515',
  mutationId: '16161616-1616-4161-8161-161616161616',
  requestedAt: observedAt,
  reservation: {
    origin: { attemptId: 'attempt-859', kind: 'ORDER_COMMITMENT_ATTEMPT' },
    ref: reservationRef,
    requirements: [
      {
        allocations: [plannedAllocation],
        bindingRef,
        catalogSelection: selection,
        exactSelectionMeaning,
        purchaseDemandOccurrenceId: demand.purchaseDemandOccurrenceId,
        quantity: demand.quantity,
        stockItem,
        unitRef,
      },
    ],
  },
  sourceActionInvocationId: '17171717-1717-4171-8171-171717171717',
} as const;

const itemExternalKey = {
  customerConfigurationId: authority.customerConfigurationId,
  externalScope: 'warehouse:prague',
  externalValue: 'ITEM-859',
  identifierKind: 'ITEM',
  issuer: { backendId: 'erp-primary', backendKind: 'external_business_system' },
  namespace: 'inventory',
  tenantId,
} as const;
const locationExternalKey = {
  ...itemExternalKey,
  externalValue: 'LOCATION-859',
  identifierKind: 'LOCATION',
} as const;
const sourceCoverageInput = () =>
  Schema.decodeUnknownSync(InventorySourceCoverageUncertaintyInputSchema)({
    _tag: 'INDETERMINATE',
    assertion: {
      assertionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      authorityConfiguration: authority,
      businessObservedAt: observedAt,
      coverage: [
        {
          assertionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          effectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          ownerEvidenceRef: 'erp-primary:coverage:859',
          relation: 'UNKNOWN',
        },
      ],
      customerConfigurationId: authority.customerConfigurationId,
      factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
      issuer: { backendId: 'erp-primary', backendKind: 'external_business_system' },
      issuerAuthority: 'SELECTED_BACKEND',
      itemCorrelationRef: {
        moduleId: 'commerce.inventory',
        resourceId: '18181818-1818-4181-8181-181818181818',
        resourceType: 'commerce.inventory.external-stock-correlation',
        tenantId,
      },
      itemExternalKey,
      locationCorrelationRef: {
        moduleId: 'commerce.inventory',
        resourceId: '19191919-1919-4191-8191-191919191919',
        resourceType: 'commerce.inventory.external-stock-correlation',
        tenantId,
      },
      locationExternalKey,
      orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '859' },
      ownerEvidenceRef: 'erp-primary:snapshot:859',
      positionRef,
      quantity: { amount: '10', unitRef },
      receivedAt,
      sourceReference: 'erp-primary:warehouse:prague:snapshot:859',
      stockItemRef,
      stockLocationRef,
    },
    materialEffectIds: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    postEffectOnHand: null,
    reason: 'MATERIAL_EFFECT_COVERAGE_UNKNOWN',
    reconciliationRequired: true,
  });

const decodeOperationalSubject = Schema.decodeUnknownSync(InventoryOperationalSubjectSchema, {
  onExcessProperty: 'error',
});
const operationalSubjectFor = (problem: InventoryOperationalProblemKind): InventoryOperationalSubject => {
  const common = { customerConfigurationId: authority.customerConfigurationId, tenantId };
  return Match.value(inventoryOperationalSubjectTagFor(problem)).pipe(
    Match.when('BACKEND_CONFIGURATION', () =>
      decodeOperationalSubject({ _tag: 'BACKEND_CONFIGURATION', ...common, configurationId }),
    ),
    Match.when('CATALOG_DEMAND', () => decodeOperationalSubject({ _tag: 'CATALOG_DEMAND', ...common, demand })),
    Match.when('COMMITTED_OBLIGATION', () =>
      decodeOperationalSubject({ _tag: 'COMMITTED_OBLIGATION', ...common, obligationRef: reservationRef }),
    ),
    Match.when('CONFIRMATION', () =>
      decodeOperationalSubject({ _tag: 'CONFIRMATION', ...common, attemptId: 'attempt-859', confirmationRef }),
    ),
    Match.when('CUTOVER', () =>
      decodeOperationalSubject({
        _tag: 'CUTOVER',
        ...common,
        blocker: { _tag: 'BACKEND_UNCHANGED' },
        evaluatedAt: receivedAt,
        postCutoverConfigurationId: configurationId,
        preCutoverConfigurationId: '20202020-2020-4020-8020-202020202020',
      }),
    ),
    Match.when('DEMAND_INPUT', () => decodeOperationalSubject({ _tag: 'DEMAND_INPUT', ...common, demand })),
    Match.when('EXTERNAL_CORRELATION', () => {
      const item =
        problem === 'EXTERNAL_ITEM_CORRELATION_AMBIGUOUS' || problem === 'EXTERNAL_ITEM_CORRELATION_UNRESOLVED';
      const ambiguous =
        problem === 'EXTERNAL_ITEM_CORRELATION_AMBIGUOUS' || problem === 'EXTERNAL_LOCATION_CORRELATION_AMBIGUOUS';
      return decodeOperationalSubject({
        _tag: 'EXTERNAL_CORRELATION',
        ...common,
        externalKey: item ? itemExternalKey : locationExternalKey,
        resolution: ambiguous ? 'AMBIGUOUS' : 'UNRESOLVED',
      });
    }),
    Match.when('IMPORTED_OBLIGATION', () =>
      decodeOperationalSubject({ _tag: 'IMPORTED_OBLIGATION', ...common, obligationRef: importedObligationRef }),
    ),
    Match.when('LEGACY_HOLD', () =>
      decodeOperationalSubject({ _tag: 'LEGACY_HOLD', ...common, holdReference: 'legacy-hold-859' }),
    ),
    Match.when('PHYSICAL_EFFECT', () =>
      decodeOperationalSubject({
        _tag: 'PHYSICAL_EFFECT',
        ...common,
        effectId: '21212121-2121-4121-8121-212121212121',
        positionRef,
      }),
    ),
    Match.when('PROTECTION', () => {
      const fence = Match.value(problem).pipe(
        Match.when('PROTECTION_AT_RISK', () => 'AT_RISK' as const),
        Match.when('PROTECTION_ESTABLISHMENT_INDETERMINATE', () => 'PRESERVE_POSSIBLE_PROTECTION_FENCE' as const),
        Match.whenOr('PROTECTION_LATE_ESTABLISHMENT_PROVEN', 'PROTECTION_PROTECTED', () => 'ACTIVE' as const),
        Match.orElse(() => 'ACTIVE' as const),
      );
      return decodeOperationalSubject({
        _tag: 'PROTECTION',
        ...common,
        attemptId: 'attempt-859',
        effectId: 'protection-effect-859',
        fence,
        protectionRef,
      });
    }),
    Match.when('RESERVATION_EFFECT', () =>
      decodeOperationalSubject({
        _tag: 'RESERVATION_EFFECT',
        ...common,
        attemptId: 'attempt-859',
        effectId,
        reservationRef,
      }),
    ),
    Match.when('SOURCE_ASSERTION', () => {
      const evaluation = sourceCoverageInput();
      return decodeOperationalSubject({
        _tag: 'SOURCE_ASSERTION',
        ...common,
        assertionId: evaluation.assertion.assertionId,
        materialEffectIds: evaluation.materialEffectIds,
        positionRef,
      });
    }),
    Match.when('STOCK_POSITION', () => decodeOperationalSubject({ _tag: 'STOCK_POSITION', ...common, positionRef })),
    Match.exhaustive,
  );
};

describe('Inventory operator recovery and monitoring meanings', () => {
  it('shows a missing exact binding as a binding-owner failure without inferring a Stock Item', () => {
    const failure = new CatalogToStockBindingResolutionFailure({
      code: 'catalog_to_stock_binding_resolution_failure',
      outcome: 'MISSING',
      reason: 'MISSING_BINDING',
    });

    const finding = investigateInventoryBindingFailure({ authority, demand, failure });

    expect(Schema.is(InventoryOperationalFindingSchema)(finding)).toBe(true);
    expect(Schema.is(InventoryBindingFailureFindingSchema)(finding)).toBe(true);
    expect(finding).toMatchObject({
      inferredStockItemRef: null,
      problem: 'BINDING_MISSING',
      scope: { demand },
    });
    expect(finding.policy).toMatchObject({
      actualOwner: 'CATALOG_TO_STOCK_BINDING_OWNER',
      supportedSafeNextAction: 'RUN_BINDING_OWNER_LIFECYCLE',
    });
    expect(finding.policy.prohibitedActions).toContain('INFER_STOCK_ITEM');
  });

  it('shows unknown Receipt/Issue coverage as uncertainty and never treats manual arithmetic as authoritative', () => {
    const input = sourceCoverageInput();
    const finding = investigateInventorySourceCoverageUncertainty(input);

    expect(Schema.is(InventoryOperationalFindingSchema)(finding)).toBe(true);
    expect(Schema.is(InventorySourceCoverageUncertaintyFindingSchema)(finding)).toBe(true);
    expect(finding).toMatchObject({
      manualArithmeticAuthoritative: false,
      materialEffectIds: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
      problem: 'SOURCE_COVERAGE_UNCERTAIN',
      provenPostEffectOnHand: null,
    });
    expect(finding.policy).toMatchObject({
      actualOwner: 'SELECTED_INVENTORY_BACKEND',
      supportedSafeNextAction: 'RECONCILE_SOURCE_COVERAGE',
      truth: 'UNKNOWN',
    });
  });

  it('keeps a failed partial create hold visible as non-reusable debt of its original Attempt and Effect', () => {
    const input = Schema.decodeUnknownSync(InventoryPartialCreateDebtInputSchema)({
      _tag: 'RECONCILIATION_REQUIRED',
      constrainedAllocations: [
        {
          allocationId: 'allocation-859',
          quantity: { amount: '6', unitRef },
          stockItemRef,
          stockPositionRef: positionRef,
        },
      ],
      observedAt,
      ownerEvidenceRef: 'erp-primary:partial-hold:859',
      request: reservationCreateRequest,
    });
    const finding = investigateInventoryPartialCreateDebt(input);

    expect(Schema.is(InventoryOperationalFindingSchema)(finding)).toBe(true);
    expect(Schema.is(InventoryPartialCreateDebtFindingSchema)(finding)).toBe(true);
    expect(finding).toMatchObject({
      attemptId: 'attempt-859',
      effectId,
      problem: 'PARTIAL_CREATE_HOLD',
      requestedReservationRef: reservationRef,
      safelyReusable: false,
      successfulReservationEstablished: false,
    });
    expect(finding.heldAllocations[0]?.quantity.amount).toBe('6');
    expect(finding.policy).toMatchObject({
      impact: 'PRESERVES_EXACT_CONSTRAINED_EFFECT',
      supportedSafeNextAction: 'RESOLVE_PRE_COMMIT_DEBT',
      truth: 'PROVEN',
    });
    expect(finding.policy.prohibitedActions).toContain('REUSE_UNRESOLVED_HOLD');
  });

  it('keeps every operational meaning under the same fail-closed recovery fences', () => {
    const problemKinds = inventoryOperationalProblemKinds;

    expect(problemKinds).toContain('CONFIRMATION_EXPIRED');
    expect(problemKinds).toContain('PROTECTION_AT_RISK');
    expect(problemKinds).toContain('PROTECTION_LATE_ESTABLISHMENT_PROVEN');
    expect(problemKinds).toContain('STOCK_CORRECTION_EVIDENCE_REQUIRED');
    expect(problemKinds).toContain('POST_COMMIT_OBLIGATION_DEBT');
    expect(problemKinds).toContain('CUTOVER_BLOCKER');
    expect(problemKinds).toContain('UNRESOLVED_LEGACY_HOLD');

    for (const problem of problemKinds) {
      const policy = inventoryOperationalPolicyFor(problem);
      expect(policy.backendSwitchingAllowed).toBe(false);
      expect(policy.permissionTransfersFactOwnership).toBe(false);
      expect(policy.unresolvedEffectMayBeReplayedAsFresh).toBe(false);
    }
  });

  it('emits an exact owner identity, scope, reason, and safe policy for every operational kind', () => {
    expect(inventoryOperationalProblemKinds.length).toBe(35);

    for (const problem of inventoryOperationalProblemKinds) {
      const finding = makeInventoryOperationalFinding({
        problem,
        scope: operationalSubjectFor(problem),
        selectedConfiguration: authority,
      });

      expect(Schema.is(InventoryCanonicalOperationalFindingSchema)(finding)).toBe(true);
      expect(Schema.is(InventoryOperationalFindingSchema)(finding)).toBe(true);
      expect(finding.reason).toBe(problem);
      expect(finding.policy).toEqual(inventoryOperationalPolicyFor(problem));
      expect(finding.selectedConfiguration).toEqual(authority);
    }
  });

  it('keeps ambiguous correlation and Protection fence meanings structurally exact', () => {
    const ambiguousItem = makeInventoryOperationalFinding({
      problem: 'EXTERNAL_ITEM_CORRELATION_AMBIGUOUS',
      scope: operationalSubjectFor('EXTERNAL_ITEM_CORRELATION_AMBIGUOUS'),
      selectedConfiguration: authority,
    });
    const wrongCorrelationMeaning = {
      ...ambiguousItem,
      scope: operationalSubjectFor('EXTERNAL_ITEM_CORRELATION_UNRESOLVED'),
    };
    const indeterminateProtection = makeInventoryOperationalFinding({
      problem: 'PROTECTION_ESTABLISHMENT_INDETERMINATE',
      scope: operationalSubjectFor('PROTECTION_ESTABLISHMENT_INDETERMINATE'),
      selectedConfiguration: authority,
    });

    expect(Schema.is(InventoryCanonicalOperationalFindingSchema)(ambiguousItem)).toBe(true);
    expect(Schema.is(InventoryCanonicalOperationalFindingSchema)(wrongCorrelationMeaning)).toBe(false);
    expect(indeterminateProtection.policy).toMatchObject({
      impact: 'PRESERVES_POSSIBLE_PROTECTION_FENCE',
      supportedSafeNextAction: 'RECOVER_ORIGINAL_EFFECT',
      truth: 'UNKNOWN',
    });
    expect(indeterminateProtection.policy.prohibitedActions).toContain('RELEASE_AT_RISK_PROTECTION');
  });

  it('retains full owner-valid source scope and rejects selected-backend issuer mismatch', () => {
    const input = sourceCoverageInput();
    const finding = investigateInventorySourceCoverageUncertainty(input);
    const wrongIssuer = {
      ...input,
      assertion: {
        ...input.assertion,
        issuer: { ...input.assertion.issuer, backendId: 'another-backend' },
      },
    };
    const mismatchedOuterAuthority = {
      ...finding,
      authority: {
        ...finding.authority,
        revision: finding.authority.revision + 1,
        selectedAt: receivedAt,
        selection: {
          ...finding.authority.selection,
          backendId: 'another-backend',
          exactReservationCapability: 'UNSUPPORTED' as const,
        },
      },
    };

    expect(finding.evaluation).toEqual(input);
    expect(Schema.is(InventorySourceCoverageUncertaintyInputSchema)(wrongIssuer)).toBe(false);
    expect(Schema.is(InventorySourceCoverageUncertaintyFindingSchema)(mismatchedOuterAuthority)).toBe(false);
  });

  it('rejects partial-create debt detached from its original effect request or planned allocation', () => {
    const input = Schema.decodeUnknownSync(InventoryPartialCreateDebtInputSchema)({
      _tag: 'RECONCILIATION_REQUIRED',
      constrainedAllocations: [
        {
          allocationId: 'allocation-859',
          quantity: { amount: '6', unitRef },
          stockItemRef,
          stockPositionRef: positionRef,
        },
      ],
      observedAt,
      ownerEvidenceRef: 'erp-primary:partial-hold:859',
      request: reservationCreateRequest,
    });
    const finding = investigateInventoryPartialCreateDebt(input);
    const detachedEffect = { ...finding, effectId: 'another-create-effect' };
    const detachedAllocation = {
      ...finding,
      heldAllocations: [{ ...finding.heldAllocations[0], allocationId: 'another-allocation' }],
    };
    const otherTenantId = '23232323-2323-4232-8232-232323232323';
    const crossTenantSameUuid = {
      ...finding,
      heldAllocations: finding.heldAllocations.map((allocation) => ({
        ...allocation,
        quantity: { ...allocation.quantity, unitRef: { ...allocation.quantity.unitRef, tenantId: otherTenantId } },
        stockItemRef: { ...allocation.stockItemRef, tenantId: otherTenantId },
        stockPositionRef: { ...allocation.stockPositionRef, tenantId: otherTenantId },
      })),
    };
    const duplicateAllocation = {
      ...finding,
      heldAllocations: [finding.heldAllocations[0], finding.heldAllocations[0]],
    };
    const possibleInput = Schema.decodeUnknownSync(InventoryPartialCreateDebtInputSchema)({
      _tag: 'INDETERMINATE',
      observedAt,
      possibleConstrainedAllocations: [
        {
          allocationId: 'allocation-859',
          quantity: { amount: '6', unitRef },
          stockItemRef,
          stockPositionRef: positionRef,
        },
      ],
      reason: 'BACKEND_OUTCOME_UNKNOWN',
      request: reservationCreateRequest,
    });
    const possibleFinding = investigateInventoryPartialCreateDebt(possibleInput);

    expect(Schema.is(InventoryPartialCreateDebtFindingSchema)(detachedEffect)).toBe(false);
    expect(Schema.is(InventoryPartialCreateDebtFindingSchema)(detachedAllocation)).toBe(false);
    expect(Schema.is(InventoryPartialCreateDebtFindingSchema)(crossTenantSameUuid)).toBe(false);
    expect(Schema.is(InventoryPartialCreateDebtFindingSchema)(duplicateAllocation)).toBe(false);
    expect(possibleFinding).toMatchObject({
      evidenceState: 'POSSIBLE_PARTIAL_HOLD',
      problem: 'POSSIBLE_PARTIAL_CREATE_HOLD',
    });
    expect(possibleFinding.policy).toMatchObject({
      impact: 'PRESERVES_POSSIBLE_STOCK_EFFECT',
      truth: 'UNKNOWN',
    });
  });

  it('preserves protection and committed-Order fences in the supported next action', () => {
    const protection = inventoryOperationalPolicyFor('PROTECTION_AT_RISK');
    const committed = inventoryOperationalPolicyFor('POST_COMMIT_OBLIGATION_DEBT');
    const expired = inventoryOperationalPolicyFor('CONFIRMATION_EXPIRED');
    const correction = inventoryOperationalPolicyFor('STOCK_CORRECTION_EVIDENCE_REQUIRED');
    const protectedReservation = inventoryOperationalPolicyFor('PROTECTION_PROTECTED');
    const lateProtection = inventoryOperationalPolicyFor('PROTECTION_LATE_ESTABLISHMENT_PROVEN');

    expect(protection.supportedSafeNextAction).toBe('RECONCILE_WITHOUT_RELEASE');
    expect(protection.prohibitedActions).toContain('RELEASE_AT_RISK_PROTECTION');
    expect(committed.supportedSafeNextAction).toBe('REPAIR_OBLIGATION_WITHOUT_ORDER_ROLLBACK');
    expect(committed.prohibitedActions).toContain('ROLLBACK_COMMITTED_ORDER');
    expect(expired.supportedSafeNextAction).toBe('START_NEW_ATTEMPT_AFTER_SAFE_PREDECESSOR_RESOLUTION');
    expect(correction.supportedSafeNextAction).toBe('CORRECT_WITH_CURRENT_OWNER_EVIDENCE');
    expect(protectedReservation).toMatchObject({
      impact: 'PRESERVES_PROTECTION_FENCE',
      supportedSafeNextAction: 'PRESERVE_PROTECTION_FENCE',
      truth: 'PROVEN',
    });
    expect(lateProtection).toEqual(protectedReservation);
  });
});
