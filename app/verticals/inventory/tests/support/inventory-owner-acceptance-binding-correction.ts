import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Effect, Option, Ref, Schema } from 'effect';

import {
  CatalogToStockBindingSchema,
  PurchaseDemandOccurrenceIdSchema,
} from '../../shared/domain/catalog-to-stock-binding.ts';
import { establishCommitmentProtection } from '../../shared/domain/commitment-protection.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import type { InventoryBackendConfiguration } from '../../shared/domain/inventory-backend-configuration.ts';
import {
  EstablishInventoryReservationInputSchema,
  establishInventoryReservation,
} from '../../shared/domain/inventory-obligation.ts';
import { PhysicalStockEffectRecordSchema } from '../../shared/domain/physical-stock-effect.ts';
import type { PhysicalStockEffectRecord } from '../../shared/domain/physical-stock-effect.ts';
import { establishReservationConfirmation } from '../../shared/domain/reservation-confirmation.ts';
import { AuthoritativeReservationEvidenceSchema } from '../../shared/domain/reservation-authority.ts';
import {
  IndeterminateStockCorrectionSchema,
  OntosWmsStockCorrectionSourceEvidenceSchema,
  StockCorrectionPayloadSchema,
} from '../../shared/domain/stock-correction.ts';
import type {
  OntosWmsStockCorrectionSourceEvidence,
  StockCorrectionError,
  StockCorrectionPayload,
  StockCorrectionRecord,
  StockCorrectionResult,
} from '../../shared/domain/stock-correction.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { CurrentOnHandEvidenceSchema, StockPositionSchema } from '../../shared/domain/stock-position.ts';
import type { StockPosition } from '../../shared/domain/stock-position.ts';
import { CommitmentProtectionRefSchema } from '../../shared/resources/commitment-protection.ts';
import { ReservationConfirmationRefSchema } from '../../shared/resources/reservation-confirmation.ts';
import type { StockCorrectionPersistence } from '../../src/services/stock-correction.service.ts';

export interface InventoryOwnerAcceptanceStockCorrectionScenario {
  readonly authority: InventoryBackendConfiguration;
  readonly context: {
    readonly actionInvocationId: string;
    readonly principalId: string;
    readonly tenantId: string;
  };
  readonly corrections: StockCorrectionPersistence;
  readonly effects: readonly PhysicalStockEffectRecord[];
  readonly payload: StockCorrectionPayload;
  readonly position: Ref.Ref<StockPosition>;
  readonly sourceEvidence: OntosWmsStockCorrectionSourceEvidence;
}

export interface InventoryOwnerAcceptanceBindingCorrectionFactories {
  readonly correctStockPosition: (
    scenario: InventoryOwnerAcceptanceStockCorrectionScenario,
  ) => Effect.Effect<StockCorrectionResult, StockCorrectionError>;
}

const tenantId = '11111111-1111-4111-8111-111111111111';
const originalItemId = '22222222-2222-4222-8222-222222222222';
const correctedItemId = '33333333-3333-4333-8333-333333333333';
const unitId = '44444444-4444-4444-8444-444444444444';
const positionId = '55555555-5555-4555-8555-555555555555';
const locationId = '66666666-6666-4666-8666-666666666666';
const configurationId = '77777777-7777-4777-8777-777777777777';
const bindingId = '88888888-8888-4888-8888-888888888888';
const reservationId = '99999999-9999-4999-8999-999999999999';
const attemptId = 'owner-acceptance-attempt-1';
const countObservedAt = '2026-09-25T10:00:00.000Z';
const correctionObservedAt = '2026-09-25T10:05:00.000Z';
const issueAppliedAt = '2026-09-25T11:00:00.000Z';
const customerConfigurationId = 'customer-configuration-primary';
const catalogModuleId = 'commerce.catalog';
const inventoryModuleId = 'commerce.inventory';
const authoritySelectedAt = '2026-09-25T09:00:00.000Z';
const wmsBackendId = 'ontos-wms-primary';
const purchaseDemandOccurrenceId = PurchaseDemandOccurrenceIdSchema.make('owner-acceptance-demand-1');

const unitRef = {
  moduleId: catalogModuleId,
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const originalItemRef = {
  moduleId: inventoryModuleId,
  resourceId: originalItemId,
  resourceType: 'commerce.inventory.stock-item',
  tenantId,
} as const;
const correctedItemRef = { ...originalItemRef, resourceId: correctedItemId };
const positionRef = {
  moduleId: inventoryModuleId,
  resourceId: positionId,
  resourceType: 'commerce.inventory.stock-position',
  tenantId,
} as const;
const stockLocationRef = {
  moduleId: inventoryModuleId,
  resourceId: locationId,
  resourceType: 'commerce.inventory.stock-location',
  tenantId,
} as const;
const configurationRef = {
  moduleId: inventoryModuleId,
  resourceId: configurationId,
  resourceType: 'commerce.inventory.inventory-backend-configuration',
  tenantId,
} as const;

const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: {
    moduleId: catalogModuleId,
    resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: catalogModuleId,
    resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});
const exactSelectionMeaning = { id: 'catalog-owner:selection-meaning-1', kind: 'PRODUCT_VARIANT' as const };
const originalStockItem = Schema.decodeUnknownSync(StockItemSchema)({
  createdAt: countObservedAt,
  exactSelectionMeaning,
  lifecycle: 'CURRENT',
  retiredAt: null,
  revision: 1,
  stockItemRef: originalItemRef,
  unitRef,
});
const correctedStockItem = Schema.decodeUnknownSync(StockItemSchema)({
  ...originalStockItem,
  createdAt: correctionObservedAt,
  stockItemRef: correctedItemRef,
});
const originalBinding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
  bindingRef: {
    moduleId: inventoryModuleId,
    resourceId: bindingId,
    resourceType: 'commerce.inventory.catalog-to-stock-binding',
    tenantId,
  },
  catalogSelection: selection,
  effectiveFrom: authoritySelectedAt,
  exactSelectionMeaning,
  revision: 1,
  stockItemRef: originalItemRef,
  unitRef,
});
const correctedBinding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
  ...originalBinding,
  effectiveFrom: correctionObservedAt,
  revision: 2,
  stockItemRef: correctedItemRef,
});
const authority = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
  configurationId,
  customerConfigurationId,
  revision: 1,
  selectedAt: authoritySelectedAt,
  selection: {
    backend: 'ontos_wms',
    backendId: wmsBackendId,
    exactReservationCapability: 'SUPPORTED',
    stockCorrectionCapability: 'SUPPORTED',
  },
  tenantId,
});

export const buildInventoryOwnerAcceptanceBindingCorrectionLineage = Effect.gen(function* buildReservationLineage() {
  const reservation = yield* establishInventoryReservation(
    Schema.decodeUnknownSync(EstablishInventoryReservationInputSchema)({
      authority,
      establishedAt: countObservedAt,
      origin: { attemptId, kind: 'ORDER_COMMITMENT_ATTEMPT' },
      ref: {
        moduleId: inventoryModuleId,
        resourceId: reservationId,
        resourceType: 'commerce.inventory.inventory-reservation',
        tenantId,
      },
      requirements: [
        {
          allocations: [
            {
              allocationId: 'owner-acceptance-allocation-1',
              positionRef,
              quantity: { amount: '4', unitRef },
              stockItemRef: originalItemRef,
            },
          ],
          bindingRef: originalBinding.bindingRef,
          catalogSelection: selection,
          exactSelectionMeaning,
          purchaseDemandOccurrenceId,
          quantity: '4',
          stockItem: originalStockItem,
          unitRef,
        },
      ],
    }),
  );
  const confirmationEvidence = Schema.decodeUnknownSync(AuthoritativeReservationEvidenceSchema)({
    effectId: 'owner-acceptance-confirmation-effect-1',
    evidence: {
      allocations: reservation.requirements.flatMap(({ allocations }) =>
        allocations.map(({ allocationId, positionRef: allocationPositionRef, quantity, stockItemRef }) => ({
          allocationId,
          quantity,
          stockItemRef,
          stockPositionRef: allocationPositionRef,
        })),
      ),
      attemptId,
      customerConfigurationId,
      ownerEvidenceRef: 'owner-acceptance-confirmation-proof-1',
      reservationId,
      tenantId,
      validFrom: countObservedAt,
      validUntil: '2026-09-25T12:00:00.000Z',
    },
    issuer: { backend: 'ontos_wms', backendId: wmsBackendId, origin: 'ONTOS_WMS' },
    kind: 'AUTHORITATIVE_RESERVATION_EVIDENCE',
    operation: 'RESERVATION_CONFIRMATION',
  });
  const confirmation = yield* establishReservationConfirmation({
    authorityEvidence: confirmationEvidence,
    confirmationRef: Schema.decodeUnknownSync(ReservationConfirmationRefSchema)({
      moduleId: inventoryModuleId,
      resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      resourceType: 'commerce.inventory.reservation-confirmation',
      tenantId,
    }),
    reservation,
  });
  const protection = yield* establishCommitmentProtection({
    authorityEvidence: Schema.decodeUnknownSync(AuthoritativeReservationEvidenceSchema)({
      ...confirmationEvidence,
      effectId: 'owner-acceptance-protection-effect-1',
      evidence: {
        ...confirmationEvidence.evidence,
        ownerEvidenceRef: 'owner-acceptance-protection-proof-1',
        validFrom: '2026-09-25T10:01:00.000Z',
      },
      operation: 'COMMITMENT_PROTECTION',
    }),
    confirmation,
    protectionRef: Schema.decodeUnknownSync(CommitmentProtectionRefSchema)({
      moduleId: inventoryModuleId,
      resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      resourceType: 'commerce.inventory.commitment-protection',
      tenantId,
    }),
  });
  return { confirmation, protection, reservation };
});

export const inventoryOwnerAcceptanceBindingCorrectionFixture = {
  authority,
  correctedBinding,
  correctedStockItem,
  originalBinding,
  originalStockItem,
  purchaseDemandOccurrenceId,
  selection,
} as const;

// Binding correction acceptance runs against the production PostgreSQL factory in integration tests.

const currentPosition = Schema.decodeUnknownSync(StockPositionSchema)({
  createdAt: authoritySelectedAt,
  endedAt: null,
  lifecycle: 'CURRENT',
  onHand: {
    _tag: 'CURRENT',
    evidenceRef: 'ontos-wms:on-hand:before-count',
    meaning: 'ON_HAND',
    observedAt: '2026-09-25T09:30:00.000Z',
    ownerConfigurationRef: configurationRef,
    quantity: { amount: '10', unitRef },
  },
  ref: positionRef,
  revision: 3,
  scope: { customerConfigurationId, stockItemRef: originalItemRef, stockLocationRef, unitRef },
});
const correctionEvidence = Schema.decodeUnknownSync(OntosWmsStockCorrectionSourceEvidenceSchema)({
  authorityConfiguration: authority,
  businessObservedAt: countObservedAt,
  coverage: [],
  customerConfigurationId,
  evidenceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
  issuer: { backendId: wmsBackendId, backendKind: 'ontos_wms' },
  orderingEvidence: { _tag: 'OWNER_ORDER_KEY', key: 'owner-count:t0' },
  ownerEvidenceRef: 'ontos-wms:count:t0',
  positionRef,
  quantity: { amount: '8', unitRef },
  receivedAt: '2026-09-25T10:00:01.000Z',
  sourceReference: 'ontos-wms:count:t0',
  stockItemRef: originalItemRef,
  stockLocationRef,
});
const laterIssue = Schema.decodeUnknownSync(PhysicalStockEffectRecordSchema)({
  _tag: 'APPLIED',
  evidence: {
    appliedAt: issueAppliedAt,
    backend: 'ontos_wms',
    backendConfigurationRef: configurationRef,
    backendEvidenceRef: 'ontos-wms:issue:after-t0',
    backendId: wmsBackendId,
    effectId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    issuer: wmsBackendId,
    kind: 'ISSUE',
    positionRef,
    quantity: { amount: '2', unitRef },
  },
  request: {
    actionInvocationId: '12121212-1212-4121-8121-121212121212',
    backend: 'ontos_wms',
    backendConfigurationRef: configurationRef,
    backendId: wmsBackendId,
    customerConfigurationId,
    effectId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    kind: 'ISSUE',
    legalEntityId: '13131313-1313-4131-8131-131313131313',
    positionRef,
    quantity: { amount: '2', unitRef },
    reason: { code: 'ORDER_FULFILLMENT', reference: 'owner-acceptance-order-1' },
    requestedAt: '2026-09-25T10:30:00.000Z',
    stockItemRef: originalItemRef,
    stockLocationRef,
  },
});
const correctionPayload = Schema.decodeUnknownSync(StockCorrectionPayloadSchema)({
  correctionId: '14141414-1414-4141-8141-141414141414',
  customerConfigurationId,
  evidence: { _tag: 'ONTOS_WMS_OWNER_EVIDENCE', evidenceId: correctionEvidence.evidenceId },
  expectedPositionRevision: currentPosition.revision,
  positionRef,
  reason: { code: 'AUTHORITATIVE_COUNT', reference: 'owner-count:t0' },
});

const runLateIssueCorrectionScenario = (factories: InventoryOwnerAcceptanceBindingCorrectionFactories) =>
  Effect.gen(function* executeLateIssueCorrectionScenario() {
    const position = yield* Ref.make(currentPosition);
    const records = yield* Ref.make<readonly StockCorrectionRecord[]>([]);
    const corrections: StockCorrectionPersistence = {
      apply: (record, nextPosition) =>
        Ref.update(records, (current) => [...current, record]).pipe(
          Effect.andThen(Ref.set(position, nextPosition)),
          Effect.as({ correction: record, outcome: 'INSERTED' as const, position: nextPosition }),
        ),
      findOpenIndeterminate: () => Effect.succeed(Option.none()),
      listAppliedEffectsForPosition: () => Effect.succeed([laterIssue]),
      read: () => Effect.succeed(Option.none()),
    };
    const result = yield* factories.correctStockPosition({
      authority,
      context: {
        actionInvocationId: '15151515-1515-4151-8151-151515151515',
        principalId: '16161616-1616-4161-8161-161616161616',
        tenantId,
      },
      corrections,
      effects: [laterIssue],
      payload: correctionPayload,
      position,
      sourceEvidence: correctionEvidence,
    });
    const reasonCode = Schema.is(IndeterminateStockCorrectionSchema)(result.correction)
      ? result.correction.reasonCode
      : 'NOT_INDETERMINATE';
    const materialEffectIds = Schema.is(IndeterminateStockCorrectionSchema)(result.correction)
      ? result.correction.materialEffectIds
      : [];

    return {
      correctionTag: result.correction._tag,
      currentOnHandEstablished: Schema.is(CurrentOnHandEvidenceSchema)(result.position.onHand),
      materialEffectIds,
      onHandTag: result.position.onHand._tag,
      outcome: result.outcome,
      reasonCode,
    } as const;
  });

export const runInventoryOwnerAcceptanceLateIssueCorrectionScenario = Effect.fn(
  'InventoryOwnerAcceptanceLateIssueCorrectionScenario.run',
)(function* runInventoryOwnerAcceptanceLateIssueCorrectionScenario(
  factories: InventoryOwnerAcceptanceBindingCorrectionFactories,
) {
  return yield* runLateIssueCorrectionScenario(factories);
});
