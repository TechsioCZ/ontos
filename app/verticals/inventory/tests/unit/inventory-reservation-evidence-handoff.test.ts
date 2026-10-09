import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  InventoryReservationEvidenceHandoffRejected,
  InventoryReservationEvidenceHandoffSchema,
  InventoryReservationRequirementBindingEvidenceSchema,
  OrderAcceptanceDecisionBundleBindingSchema,
  createInventoryReservationEvidenceHandoff,
} from '../../shared/domain/inventory-reservation-evidence-handoff.ts';
import {
  CatalogToStockBindingHistoryEntrySchema,
  CatalogToStockBindingSchema,
} from '../../shared/domain/catalog-to-stock-binding.ts';
import {
  establishCommitmentProtection,
  markCommitmentProtectionAtRisk,
} from '../../shared/domain/commitment-protection.ts';
import {
  EstablishInventoryReservationInputSchema,
  establishInventoryReservation,
} from '../../shared/domain/inventory-obligation.ts';
import {
  advanceReservationConfirmationHealth,
  establishReservationConfirmation,
} from '../../shared/domain/reservation-confirmation.ts';
import { AuthoritativeReservationEvidenceSchema } from '../../shared/domain/reservation-authority.ts';
import { ReservationAuthorityEffectIdSchema } from '../../shared/domain/reservation-issuer-failure-fields.ts';
import { InventoryBackendIdSchema } from '../../shared/domain/inventory-backend-identifiers.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { OrderCommitmentAttemptIdSchema } from '../../shared/inventory-launch-scope.ts';
import { CommitmentProtectionRefSchema } from '../../shared/resources/commitment-protection.ts';
import { ReservationConfirmationRefSchema } from '../../shared/resources/reservation-confirmation.ts';
import { StockItemRefSchema } from '../../shared/resources/stock-item.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const reservationId = '22222222-2222-4222-8222-222222222222';
const confirmationId = '33333333-3333-4333-8333-333333333333';
const protectionId = '44444444-4444-4444-8444-444444444444';
const itemId = '55555555-5555-4555-8555-555555555555';
const correctedItemId = '56555555-5555-4555-8555-555555555555';
const unitId = '66666666-6666-4666-8666-666666666666';
const positionId = '77777777-7777-4777-8777-777777777777';
const configurationId = '88888888-8888-4888-8888-888888888888';
const bindingId = '99999999-9999-4999-8999-999999999999';
const attemptId = 'attempt-checkout-1';
const issuedAt = '2026-09-24T10:00:00.000Z';
const establishedAt = '2026-09-24T10:05:00.000Z';
const expiresAt = '2026-09-24T10:15:00.000Z';

const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const itemRef = Schema.decodeUnknownSync(StockItemRefSchema)({
  moduleId: 'commerce.inventory',
  resourceId: itemId,
  resourceType: 'commerce.inventory.stock-item',
  tenantId,
});
const correctedItemRef = Schema.decodeUnknownSync(StockItemRefSchema)({
  ...itemRef,
  resourceId: correctedItemId,
});
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});
const exactSelectionMeaning = { id: 'catalog-owner:selection-meaning-1', kind: 'PRODUCT_VARIANT' } as const;
const stockItem = Schema.decodeUnknownSync(StockItemSchema)({
  createdAt: issuedAt,
  exactSelectionMeaning,
  lifecycle: 'CURRENT',
  retiredAt: null,
  revision: 1,
  stockItemRef: itemRef,
  unitRef,
});

const binding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
  bindingRef: {
    moduleId: 'commerce.inventory',
    resourceId: bindingId,
    resourceType: 'commerce.inventory.catalog-to-stock-binding',
    tenantId,
  },
  catalogSelection: selection,
  effectiveFrom: '2026-09-24T09:00:00.000Z',
  exactSelectionMeaning,
  revision: 1,
  stockItemRef: itemRef,
  unitRef,
});

const bundleBinding = Schema.decodeUnknownSync(OrderAcceptanceDecisionBundleBindingSchema)({
  attemptId,
  bundleHash: 'sha256:exact-purchase-bundle-1',
  bundleSchemaVersion: 'order-acceptance-decision-bundle.v1',
  meaning: 'EXACT_PRE_ATTEMPT_PURCHASE',
  tenantId,
});

const buildLineage = () =>
  Effect.gen(function* build() {
    const reservation = yield* establishInventoryReservation(
      Schema.decodeUnknownSync(EstablishInventoryReservationInputSchema)({
        authority: {
          configurationId,
          customerConfigurationId: 'customer-configuration-primary',
          revision: 1,
          selectedAt: '2026-09-24T08:00:00.000Z',
          selection: {
            backend: 'external_business_system',
            backendId: 'erp-primary',
            exactReservationCapability: 'SUPPORTED',
            stockCorrectionCapability: 'UNSUPPORTED',
          },
          tenantId,
        },
        establishedAt: issuedAt,
        origin: { attemptId, kind: 'ORDER_COMMITMENT_ATTEMPT' },
        ref: {
          moduleId: 'commerce.inventory',
          resourceId: reservationId,
          resourceType: 'commerce.inventory.inventory-reservation',
          tenantId,
        },
        requirements: [
          {
            allocations: [
              {
                allocationId: 'allocation-1',
                positionRef: {
                  moduleId: 'commerce.inventory',
                  resourceId: positionId,
                  resourceType: 'commerce.inventory.stock-position',
                  tenantId,
                },
                quantity: { amount: '10', unitRef },
                stockItemRef: itemRef,
              },
            ],
            bindingRef: binding.bindingRef,
            catalogSelection: selection,
            exactSelectionMeaning,
            purchaseDemandOccurrenceId: 'demand-occurrence-1',
            quantity: '10',
            stockItem,
            unitRef,
          },
        ],
      }),
    );
    const confirmationEvidence = Schema.decodeUnknownSync(AuthoritativeReservationEvidenceSchema)({
      effectId: 'effect:confirmation:attempt-1',
      evidence: {
        allocations: reservation.requirements.flatMap(({ allocations }) =>
          allocations.map(({ allocationId, positionRef, quantity, stockItemRef }) => ({
            allocationId,
            quantity,
            stockItemRef,
            stockPositionRef: positionRef,
          })),
        ),
        attemptId,
        customerConfigurationId: reservation.authority.customerConfigurationId,
        ownerEvidenceRef: 'owner-proof:confirmation:1',
        reservationId,
        tenantId,
        validFrom: issuedAt,
        validUntil: expiresAt,
      },
      issuer: {
        backend: 'external_business_system',
        backendId: 'erp-primary',
        origin: 'EXTERNAL_BUSINESS_SYSTEM',
      },
      kind: 'AUTHORITATIVE_RESERVATION_EVIDENCE',
      operation: 'RESERVATION_CONFIRMATION',
    });
    const confirmation = yield* establishReservationConfirmation({
      authorityEvidence: confirmationEvidence,
      confirmationRef: Schema.decodeUnknownSync(ReservationConfirmationRefSchema)({
        moduleId: 'commerce.inventory',
        resourceId: confirmationId,
        resourceType: 'commerce.inventory.reservation-confirmation',
        tenantId,
      }),
      reservation,
    });
    const protectionEvidence = Schema.decodeUnknownSync(AuthoritativeReservationEvidenceSchema)({
      ...confirmationEvidence,
      effectId: 'effect:protection:attempt-1',
      evidence: {
        ...confirmationEvidence.evidence,
        ownerEvidenceRef: 'owner-proof:protection:1',
        validFrom: establishedAt,
      },
      operation: 'COMMITMENT_PROTECTION',
    });
    const protection = yield* establishCommitmentProtection({
      authorityEvidence: protectionEvidence,
      confirmation,
      protectionRef: Schema.decodeUnknownSync(CommitmentProtectionRefSchema)({
        moduleId: 'commerce.inventory',
        resourceId: protectionId,
        resourceType: 'commerce.inventory.commitment-protection',
        tenantId,
      }),
    });
    return { confirmation, protection, reservation };
  });

const originalBindingEvidence = [
  Schema.decodeUnknownSync(InventoryReservationRequirementBindingEvidenceSchema)({
    acceptedBinding: binding,
    acceptedBindingOwnerEvidenceRef: 'binding-proof:original:1',
    purchaseDemandOccurrenceId: 'demand-occurrence-1',
  }),
];

describe('Inventory Reservation evidence handoff', () => {
  it.effect('hands one exact Reservation, Confirmation, and Protection lineage to the Order proof set', () =>
    Effect.gen(function* validHandoff() {
      const lineage = yield* buildLineage();
      const handoff = yield* createInventoryReservationEvidenceHandoff({
        ...lineage,
        bundleBinding,
        requirementBindingEvidence: originalBindingEvidence,
      });

      expect(Schema.is(InventoryReservationEvidenceHandoffSchema)(handoff)).toBe(true);
      expect(handoff).toMatchObject({
        backendFallbackApplied: false,
        proofSetPlacement: 'ORDER_COMMITMENT_PROOF_SET',
        reservationConfirmationRenewalSupported: false,
        safeOwnerReferences: {
          confirmationOwnerEvidenceRef: 'owner-proof:confirmation:1',
          protectionOwnerEvidenceRef: 'owner-proof:protection:1',
        },
      });
      expect(handoff.bundleBinding.attemptId).toBe(handoff.reservation.origin.attemptId);
      expect(handoff.protection.confirmationRef).toEqual(handoff.confirmation.ref);
      expect('confirmation' in handoff.protection).toBe(false);
      expect(handoff.reservation.requirements[0]?.allocations[0]?.positionRef.resourceId).toBe(positionId);
      expect(handoff.confirmation.issuanceRank).toEqual({
        issuedAt,
        ownerEvidenceRef: 'owner-proof:confirmation:1',
        source: 'RESERVATION_AUTHORITY_EVIDENCE',
      });
    }),
  );

  it.effect('rejects a proof from another backend without applying fallback', () =>
    Effect.gen(function* foreignBackend() {
      const lineage = yield* buildLineage();
      const validHandoff = yield* createInventoryReservationEvidenceHandoff({
        ...lineage,
        bundleBinding,
        requirementBindingEvidence: originalBindingEvidence,
      });
      const foreignProtection = {
        ...lineage.protection,
        authorityEvidence: {
          ...lineage.protection.authorityEvidence,
          issuer: {
            backend: 'external_business_system' as const,
            backendId: InventoryBackendIdSchema.make('erp-fallback'),
            origin: 'EXTERNAL_BUSINESS_SYSTEM' as const,
          },
        },
      };
      const result = yield* createInventoryReservationEvidenceHandoff({
        ...lineage,
        bundleBinding,
        protection: foreignProtection,
        requirementBindingEvidence: originalBindingEvidence,
      }).pipe(Effect.flip);

      expect(
        Schema.is(InventoryReservationEvidenceHandoffSchema)({
          ...validHandoff,
          protection: foreignProtection,
        }),
      ).toBe(false);
      expect(Schema.is(InventoryReservationEvidenceHandoffRejected)(result)).toBe(true);
      expect(result).toMatchObject({ fallbackApplied: false, reason: 'AUTHORITY_SCOPE_MISMATCH' });
    }),
  );

  it.effect('rejects a handoff bound to another Attempt or Bundle scope', () =>
    Effect.gen(function* wrongAttempt() {
      const lineage = yield* buildLineage();
      const result = yield* createInventoryReservationEvidenceHandoff({
        ...lineage,
        bundleBinding: { ...bundleBinding, attemptId: OrderCommitmentAttemptIdSchema.make('attempt-checkout-2') },
        requirementBindingEvidence: originalBindingEvidence,
      }).pipe(Effect.flip);

      expect(result).toMatchObject({ reason: 'ATTEMPT_BUNDLE_MISMATCH' });
    }),
  );

  it.effect('rejects conflicting Reservation establishment and nested Confirmation proof lineage', () =>
    Effect.gen(function* conflictingLineage() {
      const lineage = yield* buildLineage();
      const changedReservation = {
        ...lineage.reservation,
        establishedAt: '2026-09-24T09:59:00.000Z',
      };
      const reservationConflict = yield* createInventoryReservationEvidenceHandoff({
        ...lineage,
        bundleBinding,
        requirementBindingEvidence: originalBindingEvidence,
        reservation: changedReservation,
      }).pipe(Effect.flip);
      const confirmationEffectConflict = yield* createInventoryReservationEvidenceHandoff({
        ...lineage,
        bundleBinding,
        protection: {
          ...lineage.protection,
          confirmation: {
            ...lineage.protection.confirmation,
            authorityEvidence: {
              ...lineage.protection.confirmation.authorityEvidence,
              effectId: ReservationAuthorityEffectIdSchema.make('effect:confirmation:conflicting'),
            },
          },
        },
        requirementBindingEvidence: originalBindingEvidence,
      }).pipe(Effect.flip);
      const protectionScopeConflict = yield* createInventoryReservationEvidenceHandoff({
        ...lineage,
        bundleBinding,
        protection: {
          ...lineage.protection,
          authorityEvidence: {
            ...lineage.protection.authorityEvidence,
            evidence: {
              ...lineage.protection.authorityEvidence.evidence,
              attemptId: OrderCommitmentAttemptIdSchema.make('attempt-checkout-conflicting'),
            },
          },
        },
        requirementBindingEvidence: originalBindingEvidence,
      }).pipe(Effect.flip);

      expect(reservationConflict).toMatchObject({ reason: 'RESERVATION_CONFIRMATION_MISMATCH' });
      expect(confirmationEffectConflict).toMatchObject({ reason: 'CONFIRMATION_PROTECTION_MISMATCH' });
      expect(protectionScopeConflict).toMatchObject({ reason: 'CONFIRMATION_PROTECTION_MISMATCH' });
    }),
  );

  it.effect('preserves actual Item X beside an owner-valid Current correction to Y and exposes protected AT_RISK', () =>
    Effect.gen(function* correctedBindingHandoff() {
      const lineage = yield* buildLineage();
      const correctionEvidenceRef = 'binding-proof:correction:1';
      const confirmation = yield* advanceReservationConfirmationHealth(lineage.confirmation, {
        _tag: 'BINDING_CORRECTION',
        correctionEvidenceRef,
        effectiveAt: '2026-09-24T10:06:00.000Z',
      });
      const protection = yield* markCommitmentProtectionAtRisk(lineage.protection, {
        _tag: 'BINDING_CORRECTION',
        correctionEvidenceRef,
        effectiveAt: '2026-09-24T10:06:00.000Z',
      });
      const currentBinding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
        ...binding,
        effectiveFrom: '2026-09-24T10:06:00.000Z',
        revision: 2,
        stockItemRef: correctedItemRef,
      });
      const historyEntry = Schema.decodeUnknownSync(CatalogToStockBindingHistoryEntrySchema)({
        binding,
        endedAt: currentBinding.effectiveFrom,
        ownerEvidenceRef: correctionEvidenceRef,
        transition: 'CORRECTED',
      });
      const handoff = yield* createInventoryReservationEvidenceHandoff({
        ...lineage,
        bundleBinding,
        confirmation,
        protection,
        requirementBindingEvidence: [
          {
            ...originalBindingEvidence[0],
            currentCorrection: { currentBinding, historyEntry },
          },
        ],
      });

      expect(handoff.reservation.requirements[0]?.stockItem.stockItemRef).toEqual(itemRef);
      expect(handoff.requirementBindingEvidence[0]?.currentCorrection?.currentBinding.stockItemRef).toEqual(
        correctedItemRef,
      );
      expect(handoff.confirmation.health.state).toBe('AT_RISK');
      expect(handoff.protection.health).toMatchObject({ reconciliationRequired: true, state: 'AT_RISK' });
    }),
  );

  it.effect('rejects missing per-Requirement binding lineage', () =>
    Effect.gen(function* missingBindingLineage() {
      const lineage = yield* buildLineage();
      const result = yield* createInventoryReservationEvidenceHandoff({
        ...lineage,
        bundleBinding,
        requirementBindingEvidence: [],
      }).pipe(Effect.flip);

      expect(result).toMatchObject({ reason: 'BINDING_EVIDENCE_MISSING' });
    }),
  );

  it.effect('rejects correction evidence that retargets historical Item X in place', () =>
    Effect.gen(function* rewrittenHistory() {
      const lineage = yield* buildLineage();
      const result = yield* createInventoryReservationEvidenceHandoff({
        ...lineage,
        bundleBinding,
        requirementBindingEvidence: [
          {
            ...originalBindingEvidence[0],
            acceptedBinding: { ...binding, stockItemRef: correctedItemRef },
          },
        ],
      }).pipe(Effect.flip);

      expect(result).toMatchObject({ reason: 'BINDING_EVIDENCE_MISMATCH' });
    }),
  );

  it.effect('rejects correction lineage unless the protected obligation exposes AT_RISK', () =>
    Effect.gen(function* hiddenRisk() {
      const lineage = yield* buildLineage();
      const correctionEvidenceRef = 'binding-proof:correction:1';
      const correctedAt = '2026-09-24T10:06:00.000Z';
      const currentBinding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
        ...binding,
        effectiveFrom: correctedAt,
        revision: 2,
        stockItemRef: correctedItemRef,
      });
      const historyEntry = Schema.decodeUnknownSync(CatalogToStockBindingHistoryEntrySchema)({
        binding,
        endedAt: currentBinding.effectiveFrom,
        ownerEvidenceRef: correctionEvidenceRef,
        transition: 'CORRECTED',
      });
      const result = yield* createInventoryReservationEvidenceHandoff({
        ...lineage,
        bundleBinding,
        confirmation: {
          ...lineage.confirmation,
          health: {
            observation: { _tag: 'BINDING_CORRECTION', correctionEvidenceRef, effectiveAt: correctedAt },
            state: 'VALID',
          },
          revision: 2,
        },
        protection: {
          ...lineage.protection,
          health: {
            observation: { _tag: 'BINDING_CORRECTION', correctionEvidenceRef, effectiveAt: correctedAt },
            reconciliationRequired: false,
            state: 'PROTECTED',
          },
          revision: 2,
        },
        requirementBindingEvidence: [
          {
            ...originalBindingEvidence[0],
            currentCorrection: { currentBinding, historyEntry },
          },
        ],
      }).pipe(Effect.flip);

      expect(result).toMatchObject({ reason: 'CORRECTION_HEALTH_MISMATCH' });
    }),
  );

  it.effect('rejects correction lineage with unrelated proof observations, evidence, or effective time', () =>
    Effect.gen(function* invalidCorrectionProvenance() {
      const lineage = yield* buildLineage();
      const correctionEvidenceRef = 'binding-proof:correction:1';
      const correctedAt = '2026-09-24T10:06:00.000Z';
      const currentBinding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
        ...binding,
        effectiveFrom: correctedAt,
        revision: 2,
        stockItemRef: correctedItemRef,
      });
      const historyEntry = Schema.decodeUnknownSync(CatalogToStockBindingHistoryEntrySchema)({
        binding,
        endedAt: correctedAt,
        ownerEvidenceRef: correctionEvidenceRef,
        transition: 'CORRECTED',
      });
      const correctionLineage = [
        {
          ...originalBindingEvidence[0],
          currentCorrection: { currentBinding, historyEntry },
        },
      ];
      const impairmentConfirmation = yield* advanceReservationConfirmationHealth(lineage.confirmation, {
        _tag: 'MATERIAL_IMPAIRMENT',
        effectiveAt: correctedAt,
        ownerEvidenceRef: correctionEvidenceRef,
      });
      const correctionConfirmation = yield* advanceReservationConfirmationHealth(lineage.confirmation, {
        _tag: 'BINDING_CORRECTION',
        correctionEvidenceRef,
        effectiveAt: correctedAt,
      });
      const correctionProtection = yield* markCommitmentProtectionAtRisk(lineage.protection, {
        _tag: 'BINDING_CORRECTION',
        correctionEvidenceRef,
        effectiveAt: correctedAt,
      });
      const unrelatedProtection = yield* markCommitmentProtectionAtRisk(lineage.protection, {
        _tag: 'BINDING_CORRECTION',
        correctionEvidenceRef: 'binding-proof:correction:other',
        effectiveAt: correctedAt,
      });
      const wrongTimeProtection = yield* markCommitmentProtectionAtRisk(lineage.protection, {
        _tag: 'BINDING_CORRECTION',
        correctionEvidenceRef,
        effectiveAt: '2026-09-24T10:07:00.000Z',
      });
      const impairment = yield* createInventoryReservationEvidenceHandoff({
        ...lineage,
        bundleBinding,
        confirmation: impairmentConfirmation,
        protection: correctionProtection,
        requirementBindingEvidence: correctionLineage,
      }).pipe(Effect.flip);
      const unrelatedEvidence = yield* createInventoryReservationEvidenceHandoff({
        ...lineage,
        bundleBinding,
        confirmation: correctionConfirmation,
        protection: unrelatedProtection,
        requirementBindingEvidence: correctionLineage,
      }).pipe(Effect.flip);
      const timeMismatch = yield* createInventoryReservationEvidenceHandoff({
        ...lineage,
        bundleBinding,
        confirmation: correctionConfirmation,
        protection: wrongTimeProtection,
        requirementBindingEvidence: correctionLineage,
      }).pipe(Effect.flip);

      expect(impairment).toMatchObject({ reason: 'CORRECTION_PROVENANCE_MISMATCH' });
      expect(unrelatedEvidence).toMatchObject({ reason: 'CORRECTION_PROVENANCE_MISMATCH' });
      expect(timeMismatch).toMatchObject({ reason: 'CORRECTION_PROVENANCE_MISMATCH' });
    }),
  );

  it.effect('rejects correction effective time that does not follow the accepted binding', () =>
    Effect.gen(function* invalidCorrectionTime() {
      const lineage = yield* buildLineage();
      const correctionEvidenceRef = 'binding-proof:correction:1';
      const invalidTime = binding.effectiveFrom;
      const currentBinding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
        ...binding,
        effectiveFrom: invalidTime,
        revision: 2,
        stockItemRef: correctedItemRef,
      });
      const historyEntry = Schema.decodeUnknownSync(CatalogToStockBindingHistoryEntrySchema)({
        binding,
        endedAt: invalidTime,
        ownerEvidenceRef: correctionEvidenceRef,
        transition: 'CORRECTED',
      });
      const result = yield* createInventoryReservationEvidenceHandoff({
        ...lineage,
        bundleBinding,
        confirmation: {
          ...lineage.confirmation,
          health: {
            observation: { _tag: 'BINDING_CORRECTION', correctionEvidenceRef, effectiveAt: invalidTime },
            state: 'AT_RISK',
          },
          revision: 2,
        },
        protection: {
          ...lineage.protection,
          health: {
            observation: { _tag: 'BINDING_CORRECTION', correctionEvidenceRef, effectiveAt: invalidTime },
            reconciliationRequired: true,
            state: 'AT_RISK',
          },
          revision: 2,
        },
        requirementBindingEvidence: [
          {
            ...originalBindingEvidence[0],
            currentCorrection: { currentBinding, historyEntry },
          },
        ],
      }).pipe(Effect.flip);

      expect(result).toMatchObject({ reason: 'CORRECTION_EVIDENCE_MISMATCH' });
    }),
  );
});
