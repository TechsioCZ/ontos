import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CatalogBindingCorrectionRejected,
  CatalogBindingCorrectionInputSchema,
  CatalogToStockBindingResolutionFailure,
  assessCatalogBindingCorrection,
  failCatalogToStockBindingResolution,
} from '../../shared/domain/catalog-to-stock-binding-resolution.ts';
import {
  CatalogStockDemandSchema,
  CatalogToStockBindingSchema,
  makeCatalogToStockBindingResolver,
} from '../../shared/domain/catalog-to-stock-binding.ts';
import { CommittedInventoryObligationSchema } from '../../shared/domain/inventory-authority.ts';
import {
  AuthoritativeReservationEvidenceSchema,
  ReservationAuthorityExactScopeSchema,
} from '../../shared/domain/reservation-authority.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const bindingId = '22222222-2222-4222-8222-222222222222';
const originalStockItemId = '33333333-3333-4333-8333-333333333333';
const correctedStockItemId = '44444444-4444-4444-8444-444444444444';
const positionId = '55555555-5555-4555-8555-555555555555';
const unitId = '66666666-6666-4666-8666-666666666666';
const timestamp = '2026-09-24T10:00:00.000Z';
const correctedAt = '2026-09-24T11:00:00.000Z';
const correctionEvidence = {
  authority: 'INVENTORY_BINDING_OWNER',
  ownerEvidenceRef: 'binding-correction-evidence-1',
} as const;
const exactSelectionMeaning = { id: 'catalog-owner:selection-meaning-1', kind: 'PRODUCT_VARIANT' } as const;
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: '77777777-7777-4777-8777-777777777777',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: '88888888-8888-4888-8888-888888888888',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});
const stockItem = (resourceId: string) =>
  Schema.decodeUnknownSync(StockItemSchema)({
    createdAt: timestamp,
    exactSelectionMeaning,
    lifecycle: 'CURRENT',
    retiredAt: null,
    revision: 1,
    stockItemRef: {
      moduleId: 'commerce.inventory',
      resourceId,
      resourceType: 'commerce.inventory.stock-item',
      tenantId,
    },
    unitRef,
  });
const originalItem = stockItem(originalStockItemId);
const correctedItem = stockItem(correctedStockItemId);
const binding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
  bindingRef: {
    moduleId: 'commerce.inventory',
    resourceId: bindingId,
    resourceType: 'commerce.inventory.catalog-to-stock-binding',
    tenantId,
  },
  catalogSelection: selection,
  effectiveFrom: timestamp,
  exactSelectionMeaning,
  revision: 1,
  stockItemRef: originalItem.stockItemRef,
  unitRef,
});
const correctedBinding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
  ...binding,
  effectiveFrom: correctedAt,
  revision: 2,
  stockItemRef: correctedItem.stockItemRef,
});
const demand = Schema.decodeUnknownSync(CatalogStockDemandSchema)({
  catalogSelection: selection,
  exactSelectionMeaning,
  purchaseDemandOccurrenceId: 'purchase-demand-occurrence-1',
  quantity: '2',
  unitRef,
});

describe('Catalog-to-Stock Binding typed resolution outcomes', () => {
  it.effect('distinguishes MISSING, CONFLICTING, and INCOMPATIBLE without producing a stock success', () =>
    Effect.gen(function* resolveFailures() {
      const stockItems = { findById: () => Effect.succeed(Option.some(originalItem)) };
      const missing = yield* makeCatalogToStockBindingResolver(
        { findCurrentByExactSelectionMeaning: () => Effect.succeed([]) },
        stockItems,
      )
        .resolve(demand)
        .pipe(Effect.catchTag('CatalogToStockBindingRejected', failCatalogToStockBindingResolution), Effect.flip);
      const conflicting = yield* makeCatalogToStockBindingResolver(
        { findCurrentByExactSelectionMeaning: () => Effect.succeed([binding, binding]) },
        stockItems,
      )
        .resolve(demand)
        .pipe(Effect.catchTag('CatalogToStockBindingRejected', failCatalogToStockBindingResolution), Effect.flip);
      const incompatibleItem = Schema.decodeUnknownSync(StockItemSchema)({
        ...originalItem,
        exactSelectionMeaning: { id: 'catalog-owner:different-meaning', kind: 'PRODUCT_VARIANT' },
      });
      const incompatible = yield* makeCatalogToStockBindingResolver(
        { findCurrentByExactSelectionMeaning: () => Effect.succeed([binding]) },
        { findById: () => Effect.succeed(Option.some(incompatibleItem)) },
      )
        .resolve(demand)
        .pipe(Effect.catchTag('CatalogToStockBindingRejected', failCatalogToStockBindingResolution), Effect.flip);

      expect(missing).toBeInstanceOf(CatalogToStockBindingResolutionFailure);
      expect(missing).toMatchObject({ outcome: 'MISSING', reason: 'MISSING_BINDING' });
      expect(conflicting).toMatchObject({ outcome: 'CONFLICTING', reason: 'MULTIPLE_CURRENT_BINDINGS' });
      expect(incompatible).toMatchObject({ outcome: 'INCOMPATIBLE', reason: 'INTRINSIC_MEANING_MISMATCH' });
    }),
  );

  it.effect('classifies a requested Unit mismatch as INCOMPATIBLE without conversion', () =>
    Effect.gen(function* rejectConversion() {
      const millimeterDemand = Schema.decodeUnknownSync(CatalogStockDemandSchema)({
        ...demand,
        quantity: '1000',
        unitRef: { ...unitRef, resourceId: '99999999-9999-4999-8999-999999999999' },
      });
      const failure = yield* makeCatalogToStockBindingResolver(
        { findCurrentByExactSelectionMeaning: () => Effect.succeed([binding]) },
        { findById: () => Effect.succeed(Option.some(originalItem)) },
      )
        .resolve(millimeterDemand)
        .pipe(Effect.catchTag('CatalogToStockBindingRejected', failCatalogToStockBindingResolution), Effect.flip);

      expect(failure).toMatchObject({ outcome: 'INCOMPATIBLE', reason: 'STOCK_UNIT_MISMATCH' });
      expect(millimeterDemand.quantity).toBe('1000');
    }),
  );
});

const reservation = Schema.decodeUnknownSync(ReservationAuthorityExactScopeSchema)({
  allocations: [
    {
      allocationId: 'allocation-1',
      quantity: { amount: '2', unitRef },
      stockItemRef: originalItem.stockItemRef,
      stockPositionRef: {
        moduleId: 'commerce.inventory',
        resourceId: positionId,
        resourceType: 'commerce.inventory.stock-position',
        tenantId,
      },
    },
  ],
  attemptId: 'attempt-1',
  reservationId: '12121212-1212-4121-8121-121212121212',
  tenantId,
});
const evidence = (operation: 'RESERVATION_CONFIRMATION' | 'COMMITMENT_PROTECTION', ownerEvidenceRef: string) =>
  Schema.decodeUnknownSync(AuthoritativeReservationEvidenceSchema)({
    effectId: `${operation.toLowerCase()}-effect-1`,
    evidence: {
      ...reservation,
      customerConfigurationId: 'customer-configuration-1',
      ownerEvidenceRef,
      validFrom: timestamp,
      validUntil: '2026-09-24T12:00:00.000Z',
    },
    issuer: {
      backend: 'ontos_wms',
      backendId: 'inventory-backend-1',
      origin: 'ONTOS_WMS',
    },
    kind: 'AUTHORITATIVE_RESERVATION_EVIDENCE',
    operation,
  });
const confirmation = evidence('RESERVATION_CONFIRMATION', 'confirmation-1');
const protection = evidence('COMMITMENT_PROTECTION', 'protection-1');
const committedObligation = Schema.decodeUnknownSync(CommittedInventoryObligationSchema)({
  acceptedOrderEvidenceRef: 'accepted-order-evidence-1',
  acceptedOrderId: 'accepted-order-1',
  attemptId: reservation.attemptId,
  fulfillmentRole: 'EXECUTION_EVIDENCE_ONLY',
  lifecycleMeaning: 'COMMITTED_OBLIGATION',
  obligationOwner: 'INVENTORY',
  orderOwnerRole: 'ACCEPTED_PURCHASE',
  reservationObligationId: reservation.reservationId,
});

describe('Catalog-to-Stock Binding correction consequences', () => {
  it.effect('keeps a pre-Protection Reservation on X and marks its Confirmation AT_RISK', () =>
    Effect.gen(function* preserveReservationLineage() {
      const input = Schema.decodeUnknownSync(CatalogBindingCorrectionInputSchema)({
        correctedBinding,
        correctionEvidence,
        obligations: [
          {
            affectedAllocationIds: ['allocation-1'],
            confirmation,
            reservation,
            stage: 'BEFORE_PROTECTION',
          },
        ],
        previousBinding: binding,
      });

      const result = yield* assessCatalogBindingCorrection(input);
      const [consequence] = result.consequences;

      expect(result.futureResolution.stockItemRef).toEqual(correctedItem.stockItemRef);
      expect(consequence).toMatchObject({
        confirmationState: 'AT_RISK',
        newProtectionAllowed: false,
        orderRolledBack: false,
        reconciliation: 'REQUIRED',
        reservationReleased: false,
        reservationRevoked: false,
        retargeted: false,
      });
      expect(consequence?.preservedReservation.allocations[0]?.stockItemRef).toEqual(originalItem.stockItemRef);
    }),
  );

  it.effect('keeps established Protection fenced over X and requires reconciliation without releasing X', () =>
    Effect.gen(function* preserveProtectionLineage() {
      const input = Schema.decodeUnknownSync(CatalogBindingCorrectionInputSchema)({
        correctedBinding,
        correctionEvidence,
        obligations: [
          {
            affectedAllocationIds: ['allocation-1'],
            confirmation,
            protection,
            reservation,
            stage: 'PROTECTED',
          },
        ],
        previousBinding: binding,
      });

      const result = yield* assessCatalogBindingCorrection(input);
      const [consequence] = result.consequences;

      expect(consequence).toMatchObject({
        confirmationState: 'AT_RISK',
        preservedProtection: protection,
        reconciliation: 'REQUIRED',
        reservationReleased: false,
        retargeted: false,
      });
      expect(consequence?.preservedReservation.allocations[0]?.stockItemRef).toEqual(originalItem.stockItemRef);
    }),
  );

  it.effect('preserves committed X lineage and never rewrites or rolls back the Accepted Order', () =>
    Effect.gen(function* preserveCommittedLineage() {
      const input = Schema.decodeUnknownSync(CatalogBindingCorrectionInputSchema)({
        correctedBinding,
        correctionEvidence,
        obligations: [
          {
            affectedAllocationIds: ['allocation-1'],
            committedObligation,
            protection,
            reservation,
            stage: 'COMMITTED',
          },
        ],
        previousBinding: binding,
      });

      const result = yield* assessCatalogBindingCorrection(input);
      const [consequence] = result.consequences;

      expect(consequence).toMatchObject({
        committedObligation,
        exception: 'POST_COMMIT_BINDING_MISMATCH',
        orderRolledBack: false,
        reconciliation: 'REQUIRED',
        reservationReleased: false,
        retargeted: false,
      });
      expect(consequence?.preservedReservation.allocations[0]?.stockItemRef).toEqual(originalItem.stockItemRef);
    }),
  );

  it.effect('rejects proof that retargets an existing Allocation while reusing its Reservation identity', () =>
    Effect.gen(function* rejectRetargetedProof() {
      const retargetedProtection = Schema.decodeUnknownSync(AuthoritativeReservationEvidenceSchema)({
        ...protection,
        evidence: {
          ...protection.evidence,
          allocations: protection.evidence.allocations.map((allocation) => ({
            ...allocation,
            stockItemRef: correctedItem.stockItemRef,
          })),
        },
      });
      const input = Schema.decodeUnknownSync(CatalogBindingCorrectionInputSchema)({
        correctedBinding,
        correctionEvidence,
        obligations: [
          {
            affectedAllocationIds: ['allocation-1'],
            confirmation,
            protection: retargetedProtection,
            reservation,
            stage: 'PROTECTED',
          },
        ],
        previousBinding: binding,
      });

      const failure = yield* assessCatalogBindingCorrection(input).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(CatalogBindingCorrectionRejected);
      expect(failure.reason).toBe('PROTECTION_SCOPE_MISMATCH');
    }),
  );
});
