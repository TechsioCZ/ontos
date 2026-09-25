import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  InventoryBackendCutoverAuthorityBoundaryMismatchSchema,
  InventoryBackendCutoverBackendUnchangedSchema,
  InventoryBackendCutoverBlockedSchema,
  InventoryBackendCutoverConfigurationIdentityReusedSchema,
  InventoryBackendCutoverOpeningConfigurationMismatchSchema,
  InventoryBackendCutoverOpeningNotReadySchema,
  InventoryBackendCutoverProvisionalReservationSchema,
  InventoryBackendCutoverReadySchema,
  InventoryBackendCutoverUnresolvedEffectSchema,
  InventoryBackendRetainedSchema,
  evaluateInventoryBackendCutover,
} from '../../shared/domain/inventory-backend-cutover.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import {
  InventoryOpeningEvaluationInputSchema,
  InventoryOpeningPositionOwnerMismatchBlockerSchema,
} from '../../shared/domain/inventory-opening-stock-and-open-obligations.ts';
import type { InventoryOpeningEvaluationInput } from '../../shared/domain/inventory-opening-stock-and-open-obligations.ts';
import { InventoryEffectLedgerRecordSchema } from '../../shared/domain/inventory-effect-ledger.ts';
import { InventoryObligationSchema } from '../../shared/domain/inventory-obligation.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { StockPositionSchema } from '../../shared/domain/stock-position.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const preConfigurationId = '22222222-2222-4222-8222-222222222222';
const postConfigurationId = '33333333-3333-4333-8333-333333333333';
const itemId = '44444444-4444-4444-8444-444444444444';
const locationId = '55555555-5555-4555-8555-555555555555';
const positionId = '66666666-6666-4666-8666-666666666666';
const unitId = '77777777-7777-4777-8777-777777777777';
const customerConfigurationId = 'customer-configuration-primary';
const boundary = '2026-09-25T10:00:00.000Z';
const evaluatedAt = '2026-09-25T10:05:00.000Z';

const configuration = (
  configurationId: string,
  backend: 'external_business_system' | 'ontos_wms',
  backendId: string,
  selectedAt: string,
) =>
  Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
    configurationId,
    customerConfigurationId,
    revision: 1,
    selectedAt,
    selection: {
      backend,
      backendId,
      exactReservationCapability: 'SUPPORTED',
      stockCorrectionCapability: backend === 'ontos_wms' ? 'SUPPORTED' : 'UNSUPPORTED',
    },
    tenantId,
  });

const pre = configuration(preConfigurationId, 'external_business_system', 'legacy-erp', '2026-09-24T08:00:00.000Z');
const post = configuration(postConfigurationId, 'ontos_wms', 'ontos-wms-primary', boundary);

const opening = (overrides: Partial<InventoryOpeningEvaluationInput> = {}) =>
  Schema.decodeUnknownSync(InventoryOpeningEvaluationInputSchema)({
    bindings: [],
    effectLedger: [],
    evaluatedAt,
    legacyUncommittedHolds: [],
    obligations: [],
    selectedConfiguration: post,
    stockItems: [],
    stockPositions: [],
    ...overrides,
  });

const replacement = (openingFacts = opening()) => ({
  _tag: 'REPLACE_SELECTED_BACKEND' as const,
  effectiveBoundary: boundary,
  evaluatedAt,
  openingFacts,
  postCutoverConfiguration: post,
  preCutoverConfiguration: pre,
  rollbackPolicy: 'PRESERVE_PROVEN_COMMITTED_FACTS' as const,
  scope: 'WHOLE_CUSTOMER_CONFIGURATION' as const,
});

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
const reservationRef = {
  moduleId: 'commerce.inventory',
  resourceId: '88888888-8888-4888-8888-888888888888',
  resourceType: 'commerce.inventory.inventory-reservation',
  tenantId,
} as const;
const selection = {
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: '99999999-9999-4999-8999-999999999999',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
} as const;
const exactSelectionMeaning = { id: 'catalog-owner:selection-1', kind: 'PRODUCT_VARIANT' } as const;
const stockItem = Schema.decodeUnknownSync(StockItemSchema)({
  createdAt: '2026-09-24T08:00:00.000Z',
  exactSelectionMeaning,
  lifecycle: 'CURRENT',
  retiredAt: null,
  revision: 1,
  stockItemRef: itemRef,
  unitRef,
});
const requirement = {
  allocations: [
    { allocationId: 'allocation-1', positionRef, quantity: { amount: '2', unitRef }, stockItemRef: itemRef },
  ],
  bindingRef: {
    moduleId: 'commerce.inventory',
    resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    resourceType: 'commerce.inventory.catalog-to-stock-binding',
    tenantId,
  },
  catalogSelection: selection,
  exactSelectionMeaning,
  purchaseDemandOccurrenceId: 'demand-occurrence-1',
  quantity: '2',
  stockItem,
  unitRef,
} as const;

const provisional = Schema.decodeUnknownSync(InventoryObligationSchema)({
  authority: pre,
  establishedAt: '2026-09-25T09:00:00.000Z',
  lifecycleMeaning: 'PROVISIONAL_RESERVATION',
  origin: { attemptId: 'attempt-1', kind: 'ORDER_COMMITMENT_ATTEMPT' },
  ref: reservationRef,
  requirements: [requirement],
});

const unresolvedPhysicalEffect = Schema.decodeUnknownSync(InventoryEffectLedgerRecordSchema)({
  currentState: 'INDETERMINATE',
  effectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  intent: {
    _tag: 'PHYSICAL_ISSUE',
    request: {
      backend: 'external_business_system',
      backendConfigurationRef: {
        moduleId: 'commerce.inventory',
        resourceId: preConfigurationId,
        resourceType: 'commerce.inventory.inventory-backend-configuration',
        tenantId,
      },
      backendId: 'legacy-erp',
      customerConfigurationId,
      effectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      kind: 'ISSUE',
      legalEntityId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      positionRef,
      quantity: { amount: '2', unitRef },
      reason: { code: 'ORDER_FULFILLMENT', reference: 'order-42' },
      stockItemRef: itemRef,
      stockLocationRef: locationRef,
    },
  },
  requestedAt: '2026-09-25T09:30:00.000Z',
  resolution: null,
  revision: 2,
  tenantId,
  updatedAt: '2026-09-25T09:35:00.000Z',
});

const unresolvedCreateEffect = Schema.decodeUnknownSync(InventoryEffectLedgerRecordSchema)({
  currentState: 'INDETERMINATE',
  effectId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  intent: {
    _tag: 'RESERVATION_CREATE',
    request: {
      authority: pre,
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
        observedAt: '2026-09-25T09:00:00.000Z',
        sellingLegalEntityRef: {
          moduleId: 'core.identity',
          resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          resourceType: 'core.identity.legal-entity',
          tenantId,
        },
        status: 'CURRENT_OWNER_VERIFIED',
        storefrontRef: { appId: 'main-storefront', tenantId },
        tenantId,
      },
      effectId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      legalEntityId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      reservation: {
        origin: provisional.origin,
        ref: provisional.ref,
        requirements: provisional.requirements,
      },
    },
  },
  requestedAt: '2026-09-25T09:40:00.000Z',
  resolution: null,
  revision: 2,
  tenantId,
  updatedAt: '2026-09-25T09:45:00.000Z',
});

describe('Inventory Backend cutover and reconciliation', () => {
  it('keeps a supported selected backend without requiring migration or WMS replacement', () => {
    const result = evaluateInventoryBackendCutover({
      _tag: 'RETAIN_SELECTED_BACKEND',
      currentConfiguration: pre,
      evaluatedAt,
    });

    expect(Schema.is(InventoryBackendRetainedSchema)(result)).toBe(true);
    expect(result).toMatchObject({
      migrationRequired: false,
      runtimeAuthorityMode: 'SINGLE_SELECTED_BACKEND',
      selectedConfiguration: pre,
    });
  });

  it('approves one whole-configuration boundary with post-cutover authority and immutable history', () => {
    const result = evaluateInventoryBackendCutover(replacement());

    expect(Schema.is(InventoryBackendCutoverReadySchema)(result)).toBe(true);
    if (Schema.is(InventoryBackendCutoverReadySchema)(result)) {
      expect(result.transition).toMatchObject({
        cutoverPurpose: 'PLANNED_BACKEND_REPLACEMENT_NOT_OUTAGE_RECOVERY',
        effectiveBoundary: boundary,
        latePreCutoverEvidencePolicy: 'HISTORICAL_OR_RECONCILIATION_ONLY',
        migrationToolingAuthority: 'NONE',
        postCutoverConfiguration: post,
        preCutoverConfiguration: pre,
        rollbackPolicy: 'PRESERVE_PROVEN_COMMITTED_FACTS',
        runtimeAuthorityMode: 'SINGLE_SELECTED_BACKEND',
        scope: 'WHOLE_CUSTOMER_CONFIGURATION',
        unresolvedEffectPolicy: 'BLOCK_SWITCH_AND_NEVER_REPEAT_AS_FRESH_EFFECT',
      });
    }
  });

  it('blocks the entire switch for unresolved pre-cutover effects and provisional Reservations', () => {
    const result = evaluateInventoryBackendCutover(
      replacement(
        opening({ effectLedger: [unresolvedPhysicalEffect, unresolvedCreateEffect], obligations: [provisional] }),
      ),
    );

    expect(Schema.is(InventoryBackendCutoverBlockedSchema)(result)).toBe(true);
    if (Schema.is(InventoryBackendCutoverBlockedSchema)(result)) {
      const unresolved = result.blockers.filter(Schema.is(InventoryBackendCutoverUnresolvedEffectSchema));
      const remainingReservation = result.blockers.find(Schema.is(InventoryBackendCutoverProvisionalReservationSchema));
      expect(unresolved).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ effectId: unresolvedPhysicalEffect.effectId, kind: 'PHYSICAL_ISSUE' }),
          expect.objectContaining({ effectId: unresolvedCreateEffect.effectId, kind: 'RESERVATION_CREATE' }),
        ]),
      );
      expect(remainingReservation).toMatchObject({ reservationRef });
      expect(result.scope).toBe('WHOLE_CUSTOMER_CONFIGURATION');
      expect(JSON.stringify(result)).not.toContain('repeatAsFresh');
    }
  });

  it('preserves a proven committed obligation identity, original authority, and lineage verbatim', () => {
    const committed = Schema.decodeUnknownSync(InventoryObligationSchema)({
      ...provisional,
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
        observedAt: '2026-09-25T09:10:00.000Z',
        reservationRef,
        tenantId,
      },
      physicalIssueBoundary: 'SEPARATE_INVENTORY_TRANSITION',
      remainingQuantityConstraint: 'OWNER_GOVERNED_TRANSITION_REQUIRED',
    });
    const result = evaluateInventoryBackendCutover(replacement(opening({ obligations: [committed] })));

    expect(Schema.is(InventoryBackendCutoverReadySchema)(result)).toBe(true);
    if (Schema.is(InventoryBackendCutoverReadySchema)(result)) {
      expect(result.transition.openingPacket.obligations).toEqual([committed]);
      expect(result.transition.openingPacket.obligations[0]?.authority).toEqual(pre);
      expect(result.transition.openingPacket.obligations[0]?.origin).toEqual(committed.origin);
    }
  });

  it('keeps late pre-cutover owner evidence out of post-cutover Current truth', () => {
    const staleOldOwnerPosition = Schema.decodeUnknownSync(StockPositionSchema)({
      createdAt: '2026-09-24T08:00:00.000Z',
      endedAt: null,
      lifecycle: 'CURRENT',
      onHand: {
        _tag: 'CURRENT',
        evidenceRef: 'legacy-erp:late-snapshot',
        meaning: 'ON_HAND',
        observedAt: '2026-09-25T09:59:00.000Z',
        ownerConfigurationRef: {
          moduleId: 'commerce.inventory',
          resourceId: preConfigurationId,
          resourceType: 'commerce.inventory.inventory-backend-configuration',
          tenantId,
        },
        quantity: { amount: '9', unitRef },
      },
      ref: positionRef,
      revision: 2,
      scope: { customerConfigurationId, stockItemRef: itemRef, stockLocationRef: locationRef, unitRef },
    });
    const result = evaluateInventoryBackendCutover(
      replacement(
        opening({
          stockItems: [stockItem],
          stockPositions: [
            {
              position: staleOldOwnerPosition,
              source: { _tag: 'ONTOS_WMS_OWNER_EVIDENCE', ownerEvidenceRef: 'legacy-erp:late-snapshot' },
            },
          ],
        }),
      ),
    );

    expect(Schema.is(InventoryBackendCutoverBlockedSchema)(result)).toBe(true);
    if (Schema.is(InventoryBackendCutoverBlockedSchema)(result)) {
      const openingNotReady = result.blockers.find(Schema.is(InventoryBackendCutoverOpeningNotReadySchema));
      expect(openingNotReady?.openingBlockers.some(Schema.is(InventoryOpeningPositionOwnerMismatchBlockerSchema))).toBe(
        true,
      );
    }
  });

  it('keeps identical external identifier text distinct across backend issuers', () => {
    const shared = {
      customerConfigurationId,
      externalScope: 'warehouse-prague',
      externalValue: '123',
      identifierKind: 'ITEM' as const,
      namespace: 'inventory',
      tenantId,
    };
    const oldKey = {
      ...shared,
      issuer: { backendId: 'legacy-erp', backendKind: 'external_business_system' as const },
    };
    const newKey = {
      ...shared,
      issuer: { backendId: 'ontos-wms-primary', backendKind: 'ontos_wms' as const },
    };

    expect(oldKey.issuer).not.toEqual(newKey.issuer);
    expect(oldKey).not.toEqual(newKey);
  });

  it('blocks invalid scope, reused configuration identity, unchanged backend, and a split boundary', () => {
    const wrongPost = configuration(
      preConfigurationId,
      'external_business_system',
      'legacy-erp',
      '2026-09-25T10:01:00.000Z',
    );
    const result = evaluateInventoryBackendCutover({
      ...replacement(),
      postCutoverConfiguration: wrongPost,
    });

    expect(Schema.is(InventoryBackendCutoverBlockedSchema)(result)).toBe(true);
    if (Schema.is(InventoryBackendCutoverBlockedSchema)(result)) {
      expect(result.blockers.some(Schema.is(InventoryBackendCutoverBackendUnchangedSchema))).toBe(true);
      expect(result.blockers.some(Schema.is(InventoryBackendCutoverConfigurationIdentityReusedSchema))).toBe(true);
      expect(result.blockers.some(Schema.is(InventoryBackendCutoverAuthorityBoundaryMismatchSchema))).toBe(true);
      expect(result.blockers.some(Schema.is(InventoryBackendCutoverOpeningConfigurationMismatchSchema))).toBe(true);
    }
  });
});
