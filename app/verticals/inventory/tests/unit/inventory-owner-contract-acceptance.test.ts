import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { DateTime, Effect, Option, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import {
  CatalogToStockBindingSchema,
  ResolvedCatalogStockDemandSchema,
} from '../../shared/domain/catalog-to-stock-binding.ts';
import type { ResolvedCatalogStockDemand } from '../../shared/domain/catalog-to-stock-binding.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import { HistoricalInventorySourceAssertionEvaluationSchema } from '../../shared/domain/inventory-source-assertion.ts';
import {
  ExactUnresolvedReservationEffectConstraintSchema,
  IndeterminateUnresolvedReservationEffectConstraintSchema,
} from '../../shared/domain/current-stock-evidence-for-availability.ts';
import { StockAllocationIdSchema } from '../../shared/domain/inventory-obligation.ts';
import type { ProvisionalInventoryReservation } from '../../shared/domain/inventory-obligation.ts';
import { AuthoritativeReservationEvidenceSchema } from '../../shared/domain/reservation-authority.ts';
import { ReservationConfirmationRejected } from '../../shared/domain/reservation-confirmation.ts';
import type {
  ReservationConfirmation,
  ReservationConfirmationPersistence,
} from '../../shared/domain/reservation-confirmation.ts';
import {
  CreateInventoryReservationPayloadSchema,
  EstablishedReservationCreateEffectSchema,
  IndeterminateReservationCreateEffectSchema,
  InventoryReservationCreateMutationIdSchema,
  ReconciliationRequiredReservationCreateEffectSchema,
} from '../../shared/domain/inventory-reservation-create.ts';
import type {
  InventoryReservationCreateRequest,
  ReservationCreateAllocation,
  ReservationCreateBackendObservation,
  ReservationCreateEffect,
} from '../../shared/domain/inventory-reservation-create.ts';
import { ActionInvocationIdSchema, LegalEntityIdSchema } from '../../shared/domain/physical-stock-effect.ts';
import { ReservationAuthorityEffectIdSchema } from '../../shared/domain/reservation-issuer-failure-fields.ts';
import {
  ReleasedReservationEffectSchema,
  ReservationReleaseBackendObservationSchema,
  ReservationReleaseEffectIdSchema,
  ReservationReleaseMutationIdSchema,
} from '../../shared/domain/inventory-reservation-release.ts';
import type { ReservationReleaseEffect } from '../../shared/domain/inventory-reservation-release.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { StockLocationSchema } from '../../shared/domain/stock-location.ts';
import {
  ExactStockQuantityAmountSchema,
  StockPositionSchema,
  UnknownOnHandEvidenceSchema,
} from '../../shared/domain/stock-position.ts';
import { ReservationConfirmationRefSchema } from '../../shared/resources/reservation-confirmation.ts';
import { makeCurrentStockEvidenceForAvailabilityService } from '../../src/services/current-stock-evidence-for-availability.service.ts';
import type {
  InventoryReservationCreateBackend,
  ReservationCreateEffectPersistence,
} from '../../src/services/inventory-reservation-create.service.ts';
import {
  makeInventoryReservationCreateExecutionService,
  makeInventoryReservationCreateService,
} from '../../src/services/inventory-reservation-create.service.ts';
import type {
  InventoryReservationReleaseBackend,
  ReservationReleaseEffectPersistence,
} from '../../src/services/inventory-reservation-release.service.ts';
import {
  makeInventoryReservationReleaseExecutionService,
  makeInventoryReservationReleaseService,
} from '../../src/services/inventory-reservation-release.service.ts';
import type { ReservationConfirmationIssuer } from '../../src/services/reservation-confirmation.service.ts';
import { makeReservationConfirmationService } from '../../src/services/reservation-confirmation.service.ts';
import { makeStockCorrectionService } from '../../src/services/stock-correction.service.ts';
import { makeInMemoryInventoryEffectLedger } from '../support/inventory-effect-ledger.ts';
import { runInventoryOwnerAcceptanceLateIssueCorrectionScenario } from '../support/inventory-owner-acceptance-binding-correction.ts';
import {
  runBindingCorrectionMeaningAcceptance,
  runExternalIssuerCutoverAcceptance,
  runStockSharingLifecycleAcceptance,
} from '../support/inventory-owner-acceptance-relations.ts';
import { evaluateInventoryOwnerAcceptanceShortage } from '../support/inventory-owner-acceptance-shortage.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = LegalEntityIdSchema.make('22222222-2222-4222-8222-222222222222');
const reservationId = '33333333-3333-4333-8333-333333333333';
const itemId = '44444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';
const firstPositionId = '66666666-6666-4666-8666-666666666666';
const secondPositionId = '77777777-7777-4777-8777-777777777777';
const configurationId = '88888888-8888-4888-8888-888888888888';
const bindingId = '99999999-9999-4999-8999-999999999999';
const firstLocationId = 'aaaaaaaa-0000-4000-8000-000000000001';
const secondLocationId = 'aaaaaaaa-0000-4000-8000-000000000002';
const timestamp = '2026-09-24T10:00:00.000Z';
const customerConfigurationId = 'customer-configuration-primary';
const effectId = ReservationAuthorityEffectIdSchema.make('reservation-create-effect-1');
const secondEffectId = ReservationAuthorityEffectIdSchema.make('reservation-create-effect-2');
const confirmationEffectId = ReservationAuthorityEffectIdSchema.make('reservation-confirmation-effect-1');
const actionInvocationId = ActionInvocationIdSchema.make('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
const mutationId = InventoryReservationCreateMutationIdSchema.make('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1');
const releaseEffectId = ReservationReleaseEffectIdSchema.make('reservation-release-effect-1');
const releaseMutationId = ReservationReleaseMutationIdSchema.make('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
const confirmationRef = Schema.decodeUnknownSync(ReservationConfirmationRefSchema)({
  moduleId: 'commerce.inventory',
  resourceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  resourceType: 'commerce.inventory.reservation-confirmation',
  tenantId,
});

const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  packageRef: {
    moduleId: 'commerce.catalog',
    resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    resourceType: 'commerce.catalog.package',
    tenantId,
  },
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
const exactSelectionMeaning = { id: 'catalog:package:meaning-1', kind: 'PACKAGE_OPTION' as const };
const stockItem = Schema.decodeUnknownSync(StockItemSchema)({
  createdAt: timestamp,
  exactSelectionMeaning,
  lifecycle: 'CURRENT',
  retiredAt: null,
  revision: 1,
  stockItemRef: {
    moduleId: 'commerce.inventory',
    resourceId: itemId,
    resourceType: 'commerce.inventory.stock-item',
    tenantId,
  },
  unitRef,
});
const authority = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
  configurationId,
  customerConfigurationId,
  revision: 1,
  selectedAt: '2026-09-24T09:00:00.000Z',
  selection: {
    backend: 'ontos_wms',
    backendId: 'ontos-wms-primary',
    exactReservationCapability: 'SUPPORTED',
    stockCorrectionCapability: 'SUPPORTED',
  },
  tenantId,
});
const position = (resourceId: string, locationId: string, onHand: string) =>
  Schema.decodeUnknownSync(StockPositionSchema)({
    createdAt: timestamp,
    endedAt: null,
    lifecycle: 'CURRENT',
    onHand: {
      _tag: 'CURRENT',
      evidenceRef: `wms:position:${resourceId}`,
      meaning: 'ON_HAND',
      observedAt: timestamp,
      ownerConfigurationRef: {
        moduleId: 'commerce.inventory',
        resourceId: configurationId,
        resourceType: 'commerce.inventory.inventory-backend-configuration',
        tenantId,
      },
      quantity: { amount: onHand, unitRef },
    },
    ref: {
      moduleId: 'commerce.inventory',
      resourceId,
      resourceType: 'commerce.inventory.stock-position',
      tenantId,
    },
    revision: 1,
    scope: {
      customerConfigurationId,
      stockItemRef: stockItem.stockItemRef,
      stockLocationRef: {
        moduleId: 'commerce.inventory',
        resourceId: locationId,
        resourceType: 'commerce.inventory.stock-location',
        tenantId,
      },
      unitRef,
    },
  });
const positions = [position(firstPositionId, firstLocationId, '6'), position(secondPositionId, secondLocationId, '4')];
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
  stockItemRef: stockItem.stockItemRef,
  unitRef,
});
const firstPosition = Option.getOrThrow(Option.fromNullishOr(positions[0]));
const firstStockLocation = Schema.decodeUnknownSync(StockLocationSchema)({
  displayName: 'Prague warehouse',
  lifecycle: { _tag: 'ACTIVE' },
  operationalScope: { _tag: 'PHYSICAL_SITE', physicalSiteKeys: ['site:prague'] },
  ref: firstPosition.scope.stockLocationRef,
  revision: 1,
});

const resolved = (purchaseDemandOccurrenceId: string, quantity: string): ResolvedCatalogStockDemand =>
  Schema.decodeUnknownSync(ResolvedCatalogStockDemandSchema)({
    bindingRef: binding.bindingRef,
    catalogSelection: selection,
    exactSelectionMeaning,
    purchaseDemandOccurrenceId,
    quantity,
    stockItem,
    unitRef,
  });

const actionContext = {
  actionInvocationId,
  legalEntityId,
  tenantId,
  trustedStorefrontId: 'storefront-primary',
} as const;
const decodePayload = Schema.decodeUnknownSync(CreateInventoryReservationPayloadSchema, { onExcessProperty: 'error' });
const payload = (
  demands: readonly ResolvedCatalogStockDemand[] = [resolved('occurrence-1', '10')],
  overrides: Partial<typeof CreateInventoryReservationPayloadSchema.Encoded> = {},
) =>
  decodePayload({
    attemptId: 'attempt-1',
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
        resourceId: legalEntityId,
        resourceType: 'core.identity.legal-entity',
        tenantId,
      },
      status: 'CURRENT_OWNER_VERIFIED',
      storefrontRef: { appId: 'storefront-primary', tenantId },
      tenantId,
    },
    customerConfigurationId,
    demands: demands.map(({ bindingRef: _bindingRef, stockItem: _stockItem, ...demand }) => demand),
    effectId,
    reservationRef: {
      moduleId: 'commerce.inventory',
      resourceId: reservationId,
      resourceType: 'commerce.inventory.inventory-reservation',
      tenantId,
    },
    ...overrides,
  });

const makeEffects = Effect.gen(function* makeEffects() {
  const records = yield* Ref.make(new Map<string, ReservationCreateEffect>());
  const obligations = yield* Ref.make(new Map<string, ProvisionalInventoryReservation>());
  const persistence: ReservationCreateEffectPersistence = {
    createOrRead: (request) =>
      Effect.gen(function* createOrRead() {
        const current = yield* Ref.get(records);
        const existing = current.get(request.effectId);
        if (existing !== undefined) {
          return { effect: existing, outcome: 'EXISTING' as const };
        }
        const next: ReservationCreateEffect = { _tag: 'REQUESTED', request };
        yield* Ref.set(records, new Map(current).set(request.effectId, next));
        return { effect: next, outcome: 'INSERTED' as const };
      }),
    findByAttempt: (attemptId) =>
      Ref.get(records).pipe(
        Effect.map((current) =>
          Option.fromNullishOr(
            [...current.values()].find((record) => record.request.reservation.origin.attemptId === attemptId),
          ),
        ),
      ),
    read: (id) => Ref.get(records).pipe(Effect.map((current) => Option.fromNullishOr(current.get(id)))),
    save: (_expected, next) =>
      Effect.gen(function* saveTerminal() {
        yield* Ref.update(records, (current) => new Map(current).set(next.request.effectId, next));
        if (Schema.is(EstablishedReservationCreateEffectSchema)(next)) {
          yield* Ref.update(obligations, (current) =>
            new Map(current).set(next.reservation.origin.attemptId, next.reservation),
          );
        }
        return next;
      }),
  };
  return { obligations, persistence };
});

const plannedAllocations = (request: InventoryReservationCreateRequest): readonly ReservationCreateAllocation[] =>
  request.reservation.requirements.flatMap(({ allocations }) =>
    allocations.map(({ positionRef, ...allocation }) => ({ ...allocation, stockPositionRef: positionRef })),
  );
const successfulObservation = (request: InventoryReservationCreateRequest): ReservationCreateBackendObservation => ({
  _tag: 'ESTABLISHED',
  allocations: plannedAllocations(request),
  effectId: request.effectId,
  establishedAt: timestamp,
  ownerEvidenceRef: 'wms:reservation:42',
});

const makeCreateHarness = Effect.gen(function* makeCreateHarness() {
  const effects = yield* makeEffects;
  const backendCalls = yield* Ref.make<readonly InventoryReservationCreateRequest[]>([]);
  const observations = yield* Ref.make<
    readonly ((request: InventoryReservationCreateRequest) => ReservationCreateBackendObservation)[]
  >([successfulObservation]);
  const ledger = makeInMemoryInventoryEffectLedger(timestamp);
  const backend: InventoryReservationCreateBackend = {
    create: (request) =>
      Effect.gen(function* executeBackend() {
        yield* Ref.update(backendCalls, (calls) => [...calls, request]);
        const [next, ...rest] = yield* Ref.get(observations);
        yield* Ref.set(observations, rest);
        return (next ?? successfulObservation)(request);
      }),
  };
  const service = makeInventoryReservationCreateService({
    backendConfigurations: { findCurrent: () => Effect.succeed(Option.some(authority)) },
    candidates: {
      lockCurrentForItem: () =>
        Effect.succeed(positions.map((current) => ({ position: current, reservedAmount: '0' }))),
    },
    commerceContexts: { resolveCurrent: () => Effect.succeed(payload().commerceContext) },
    effects: effects.persistence,
    eligibility: { isEligible: () => Effect.succeed(true) },
    ledger,
    lockBindingScopes: () => Effect.void,
    makeAllocationId: ({ effectId: id, positionId, purchaseDemandOccurrenceId }) =>
      StockAllocationIdSchema.make(`${id}:${purchaseDemandOccurrenceId}:${positionId}`),
    makeMutationId: () => mutationId,
    resolver: { resolve: (demand) => Effect.succeed(resolved(demand.purchaseDemandOccurrenceId, demand.quantity)) },
  });
  const execution = makeInventoryReservationCreateExecutionService({ backend, effects: effects.persistence, ledger });
  return {
    backendCalls,
    effects,
    execute: (request: InventoryReservationCreateRequest) => execution.execute({ legalEntityId, tenantId }, request),
    observations,
    service,
  };
});

const makeConfirmationPersistence = () => {
  let current: ReservationConfirmation | undefined;
  const history: ReservationConfirmation[] = [];
  const persistence: ReservationConfirmationPersistence = {
    createOrRead: (candidate) => {
      if (current === undefined) {
        current = candidate;
        history.push(candidate);
        return Effect.succeed({ confirmation: candidate, outcome: 'INSERTED' as const });
      }
      return Effect.succeed({ confirmation: current, outcome: 'EXISTING' as const });
    },
    findByRef: (ref) =>
      Effect.succeed(
        current?.ref.resourceId === ref.resourceId && current.ref.tenantId === ref.tenantId
          ? Option.some(current)
          : Option.none(),
      ),
    findByReservationAttempt: (reservationRef, attemptId) =>
      Effect.succeed(
        current?.reservation.ref.resourceId === reservationRef.resourceId &&
          current.reservation.origin.attemptId === attemptId
          ? Option.some(current)
          : Option.none(),
      ),
    readHistory: () => Effect.succeed(history),
    saveRevision: ({ current: expected, next }) => {
      if (current?.revision !== expected.revision) {
        return Effect.fail(
          new ReservationConfirmationRejected({
            code: 'reservation_confirmation_rejected',
            reason: 'REVISION_CONFLICT',
          }),
        );
      }
      current = next;
      history.push(next);
      return Effect.succeed(next);
    },
  };
  return { persistence, readCurrent: () => current };
};

const confirmationIssuer: ReservationConfirmationIssuer = {
  issue: (request) =>
    Schema.decodeUnknownEffect(AuthoritativeReservationEvidenceSchema)({
      effectId: request.effectId,
      evidence: {
        allocations: request.reservation.allocations,
        attemptId: request.reservation.attemptId,
        customerConfigurationId: request.configuration.customerConfigurationId,
        ownerEvidenceRef: 'owner-proof:confirmation:1',
        reservationId: request.reservation.reservationId,
        tenantId: request.reservation.tenantId,
        validFrom: timestamp,
        validUntil: '2026-09-24T10:15:00.000Z',
      },
      issuer: {
        backend: request.configuration.selection.backend,
        backendId: request.configuration.selection.backendId,
        origin: 'ONTOS_WMS',
      },
      kind: 'AUTHORITATIVE_RESERVATION_EVIDENCE',
      operation: 'RESERVATION_CONFIRMATION',
    }).pipe(Effect.orDie),
};

const protectionEvidence = (reservation: ProvisionalInventoryReservation) =>
  Schema.decodeUnknownSync(AuthoritativeReservationEvidenceSchema)({
    effectId: 'commitment-protection-effect-1',
    evidence: {
      allocations: reservation.requirements.flatMap(({ allocations }) =>
        allocations.map(({ allocationId, positionRef, quantity, stockItemRef }) => ({
          allocationId,
          quantity,
          stockItemRef,
          stockPositionRef: positionRef,
        })),
      ),
      attemptId: reservation.origin.attemptId,
      customerConfigurationId: reservation.authority.customerConfigurationId,
      ownerEvidenceRef: 'owner-proof:protection:1',
      reservationId: reservation.ref.resourceId,
      tenantId: reservation.ref.tenantId,
      validFrom: '2026-09-24T10:14:59.999Z',
      validUntil: '2026-09-25T10:00:00.000Z',
    },
    issuer: {
      backend: reservation.authority.selection.backend,
      backendId: reservation.authority.selection.backendId,
      origin: 'ONTOS_WMS',
    },
    kind: 'AUTHORITATIVE_RESERVATION_EVIDENCE',
    operation: 'COMMITMENT_PROTECTION',
  });

const makeReleasePersistence = () => {
  let current: ReservationReleaseEffect | undefined;
  const persistence: ReservationReleaseEffectPersistence = {
    createOrRead: (candidate) => {
      if (current === undefined) {
        current = candidate;
        return Effect.succeed({ effect: candidate, outcome: 'INSERTED' as const });
      }
      return Effect.succeed({ effect: current, outcome: 'EXISTING' as const });
    },
    findByReservation: () => Effect.succeed(current === undefined ? Option.none() : Option.some(current)),
    read: () => Effect.succeed(current === undefined ? Option.none() : Option.some(current)),
    save: (expected, next) => {
      if (current?.revision !== expected.revision) {
        return Effect.die('acceptance release fixture revision conflict');
      }
      current = next;
      return Effect.succeed(next);
    },
  };
  return { persistence, read: () => current };
};

const wholeReservationScope = (reservation: ProvisionalInventoryReservation) => ({
  allocations: reservation.requirements.flatMap(({ allocations }) =>
    allocations.map(({ allocationId, positionRef, quantity, stockItemRef }) => ({
      allocationId,
      quantity,
      stockItemRef,
      stockPositionRef: positionRef,
    })),
  ),
  attemptId: reservation.origin.attemptId,
  reservationId: reservation.ref.resourceId,
  tenantId: reservation.ref.tenantId,
});

const makeReleaseHarness = (reservation: ProvisionalInventoryReservation) => {
  const effects = makeReleasePersistence();
  const ledger = makeInMemoryInventoryEffectLedger(timestamp);
  let backendCalls = 0;
  const backend: InventoryReservationReleaseBackend = {
    release: (request) => {
      backendCalls += 1;
      return Schema.decodeUnknownEffect(ReservationReleaseBackendObservationSchema)({
        _tag: 'RELEASED',
        effectId: request.effectId,
        issuer: {
          backend: request.reservation.authority.selection.backend,
          backendId: request.reservation.authority.selection.backendId,
          origin: 'ONTOS_WMS',
        },
        ownerEvidenceRef: 'owner-proof:release:1',
        releasedAt: '2026-09-24T10:20:00.000Z',
        scope: wholeReservationScope(request.reservation),
      }).pipe(Effect.orDie);
    },
  };
  const service = makeInventoryReservationReleaseService({
    effects: effects.persistence,
    ledger,
    makeMutationId: () => releaseMutationId,
    obligations: { read: () => Effect.succeed(Option.some(reservation)) },
  });
  const execution = makeInventoryReservationReleaseExecutionService({
    backend,
    effects: effects.persistence,
    ledger,
    orderTruth: {
      read: () =>
        Effect.succeed({
          _tag: 'NOT_COMMITTED_CLOSED' as const,
          closureEvidenceRef: 'order-proof:closed:1',
          nonCommitEvidenceRef: 'order-proof:not-committed:1',
          observedAt: '2026-09-24T10:18:00.000Z',
        }),
    },
    protectionTruth: {
      read: () =>
        Effect.succeed({
          _tag: 'ABSENT_PROVEN' as const,
          evidenceRef: 'protection-proof:absent:1',
          observedAt: '2026-09-24T10:19:00.000Z',
        }),
    },
  });
  return { backendCalls: () => backendCalls, effects, execution, service };
};

describe('Inventory owner contract acceptance', () => {
  it.effect('preserves exact occurrence-to-Requirement identity and exact 6/4 multi-Position allocation on retry', () =>
    Effect.gen(function* acceptReservationFlow() {
      const harness = yield* makeCreateHarness;
      const first = yield* harness.service.create(payload(), actionContext);
      yield* harness.execute(first.result.effect.request);
      const retry = yield* harness.service.create(payload(), actionContext);
      const established = Schema.decodeUnknownSync(EstablishedReservationCreateEffectSchema)(
        Option.getOrThrow(yield* harness.effects.persistence.read(effectId)),
      );
      const requirement = Option.getOrThrow(Option.fromNullishOr(established.reservation.requirements[0]));

      expect(first.result.outcome).toBe('PENDING');
      expect(retry.result.outcome).toBe('EXACT_REPLAY');
      expect(retry.result.effect.request).toEqual(first.result.effect.request);
      expect(requirement.purchaseDemandOccurrenceId).toBe('occurrence-1');
      expect(requirement.quantity).toBe('10');
      expect(requirement.exactSelectionMeaning).toEqual(exactSelectionMeaning);
      expect(requirement.stockItem.stockItemRef).toEqual(stockItem.stockItemRef);
      expect(requirement.unitRef).toEqual(unitRef);
      expect(requirement).not.toHaveProperty('components');
      expect(requirement).not.toHaveProperty('convertedQuantity');
      expect(requirement.allocations.map(({ quantity }) => quantity.amount)).toEqual(['6', '4']);
      expect(requirement.allocations.map(({ positionRef }) => positionRef)).toEqual(positions.map(({ ref }) => ref));
      expect(requirement.allocations.every(({ stockItemRef }) => stockItemRef.resourceId === itemId)).toBe(true);
      expect(yield* Ref.get(harness.backendCalls)).toHaveLength(1);

      const occurrenceHarness = yield* makeCreateHarness;
      const occurrencePayload = payload([resolved('occurrence-a', '5'), resolved('occurrence-b', '5')]);
      const pending = yield* occurrenceHarness.service.create(occurrencePayload, actionContext);
      yield* occurrenceHarness.execute(pending.result.effect.request);
      const occurrenceRetry = yield* occurrenceHarness.service.create(occurrencePayload, actionContext);
      const occurrenceTerminal = Schema.decodeUnknownSync(EstablishedReservationCreateEffectSchema)(
        Option.getOrThrow(yield* occurrenceHarness.effects.persistence.read(effectId)),
      );
      expect(
        occurrenceTerminal.reservation.requirements.map(({ purchaseDemandOccurrenceId }) => purchaseDemandOccurrenceId),
      ).toEqual(['occurrence-a', 'occurrence-b']);
      expect(occurrenceRetry.result.effect.request.reservation.requirements).toEqual(
        pending.result.effect.request.reservation.requirements,
      );
    }),
  );

  it.effect('keeps failed and indeterminate create effects as non-Reservation debt and consumer constraints', () =>
    Effect.gen(function* preserveCreateDebt() {
      const partialHarness = yield* makeCreateHarness;
      yield* Ref.set(partialHarness.observations, [
        (request) => ({
          _tag: 'PARTIAL',
          constrainedAllocations: [
            {
              ...Option.getOrThrow(Option.fromNullishOr(plannedAllocations(request)[0])),
              quantity: { amount: ExactStockQuantityAmountSchema.make('6'), unitRef },
            },
          ],
          effectId: request.effectId,
          observedAt: timestamp,
          ownerEvidenceRef: 'wms:partial-hold:42',
        }),
      ]);
      const partialPending = yield* partialHarness.service.create(payload(), actionContext);
      yield* partialHarness.execute(partialPending.result.effect.request);
      const partial = Schema.decodeUnknownSync(ReconciliationRequiredReservationCreateEffectSchema)(
        Option.getOrThrow(yield* partialHarness.effects.persistence.read(effectId)),
      );
      expect((yield* Ref.get(partialHarness.effects.obligations)).size).toBe(0);

      const unknownHarness = yield* makeCreateHarness;
      yield* Ref.set(unknownHarness.observations, [
        (request) => ({
          _tag: 'INDETERMINATE',
          effectId: request.effectId,
          observedAt: timestamp,
          reason: 'BACKEND_OUTCOME_UNKNOWN',
        }),
      ]);
      const unknownPayload = payload(undefined, {
        attemptId: 'attempt-2',
        effectId: secondEffectId,
        reservationRef: {
          moduleId: 'commerce.inventory',
          resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          resourceType: 'commerce.inventory.inventory-reservation',
          tenantId,
        },
      });
      const unknownPending = yield* unknownHarness.service.create(unknownPayload, actionContext);
      yield* unknownHarness.execute(unknownPending.result.effect.request);
      const indeterminate = Schema.decodeUnknownSync(IndeterminateReservationCreateEffectSchema)(
        Option.getOrThrow(yield* unknownHarness.effects.persistence.read(secondEffectId)),
      );
      expect((yield* Ref.get(unknownHarness.effects.obligations)).size).toBe(0);

      const evidence = yield* makeCurrentStockEvidenceForAvailabilityService({
        findAuthority: () => Effect.succeed(Option.some(authority)),
        findBinding: () => Effect.succeed(Option.some(binding)),
        findStockItem: () => Effect.succeed(Option.some(stockItem)),
        findStockLocation: () => Effect.succeed(Option.some(firstStockLocation)),
        listCommittedObligations: () => Effect.succeed([]),
        listCurrentSuccessfulAllocations: () => Effect.succeed([]),
        listMaterialEffects: () => Effect.succeed([]),
        readLatestSourceAssertion: () => Effect.succeed(Option.none()),
        readPosition: () => Effect.succeed(Option.some(firstPosition)),
        unresolvedCreateEffects: Effect.succeed([partial, indeterminate]),
      }).read(firstPosition.ref);
      const exact = Schema.decodeUnknownSync(ExactUnresolvedReservationEffectConstraintSchema)(
        evidence.unresolvedReservationEffectConstraints[0],
      );
      const unknown = Schema.decodeUnknownSync(IndeterminateUnresolvedReservationEffectConstraintSchema)(
        evidence.unresolvedReservationEffectConstraints[1],
      );

      expect(evidence.provisionalReserved).toMatchObject({ meaning: 'RESERVED', quantity: { amount: '0' } });
      expect(exact.constrainedAllocations[0]?.quantity.amount).toBe('6');
      expect(exact.countsTowardReserved).toBe(false);
      expect(exact.effectId).toBe(effectId);
      expect(exact.provesReusableOnHand).toBe(false);
      expect(unknown.countsTowardReserved).toBe(false);
      expect(unknown.effectId).toBe(secondEffectId);
      expect(unknown.provesReusableOnHand).toBe(false);
      expect(unknown.reason).toBe('BACKEND_OUTCOME_UNKNOWN');
    }),
  );

  it.effect('keeps Confirmation expiry terminal while preserving a late-proven original in-time Protection', () =>
    Effect.gen(function* preserveOriginalProtection() {
      const create = yield* makeCreateHarness;
      const pending = yield* create.service.create(payload(), actionContext);
      yield* create.execute(pending.result.effect.request);
      const established = Schema.decodeUnknownSync(EstablishedReservationCreateEffectSchema)(
        Option.getOrThrow(yield* create.effects.persistence.read(effectId)),
      );
      const memory = makeConfirmationPersistence();
      const confirmations = makeReservationConfirmationService({
        issuer: confirmationIssuer,
        persistence: memory.persistence,
      });
      const issued = yield* confirmations.issue({
        confirmationRef,
        effectId: confirmationEffectId,
        reservation: established.reservation,
      });
      const expired = yield* confirmations.evaluateForCommitment({
        confirmationRef,
        evaluatedAt: '2026-09-24T10:30:00.000Z',
      });
      const recovered = yield* confirmations.evaluateForCommitment({
        confirmationRef,
        evaluatedAt: '2026-09-24T11:00:00.000Z',
        protection: {
          evidence: protectionEvidence(established.reservation),
          kind: 'ORIGINAL_EFFECT_RECOVERY',
        },
      });
      const replay = yield* confirmations.issue({
        confirmationRef,
        effectId: confirmationEffectId,
        reservation: established.reservation,
      });

      expect(issued.outcome).toBe('ISSUED');
      expect(expired).toMatchObject({
        confirmation: { health: { state: 'EXPIRED' } },
        outcome: 'TERMINAL_READINESS_LOSS',
        replacement: 'BLOCKED_UNTIL_PREDECESSOR_RESOLVED',
      });
      expect(recovered).toMatchObject({
        confirmation: { health: { state: 'EXPIRED' } },
        fence: 'PRESERVED',
        outcome: 'PROTECTION_ESTABLISHED_IN_TIME',
      });
      expect(recovered.confirmation.ref).toEqual(issued.confirmation.ref);
      expect(replay).toMatchObject({ confirmation: { health: { state: 'EXPIRED' } }, outcome: 'EXACT_REPLAY' });
      expect(memory.readCurrent()).not.toHaveProperty('renewedAt');
      expect(memory.readCurrent()).not.toHaveProperty('releasedAt');
    }),
  );

  it.effect(
    'releases the whole Reservation only after authoritative non-commit, closure, and no-Protection proof',
    () =>
      Effect.gen(function* releaseSafely() {
        const create = yield* makeCreateHarness;
        const pending = yield* create.service.create(payload(), actionContext);
        yield* create.execute(pending.result.effect.request);
        const established = Schema.decodeUnknownSync(EstablishedReservationCreateEffectSchema)(
          Option.getOrThrow(yield* create.effects.persistence.read(effectId)),
        );
        const release = makeReleaseHarness(established.reservation);
        const requested = yield* release.service.request(
          {
            attemptId: established.reservation.origin.attemptId,
            releaseEffectId,
            reservationRef: established.reservation.ref,
            scope: { _tag: 'WHOLE_RESERVATION' },
          },
          {
            actionInvocationId,
            legalEntityId,
            requestedAt: '2026-09-24T10:16:00.000Z',
            tenantId,
          },
        );
        yield* release.execution.execute({ legalEntityId, tenantId }, requested.result.effect.request);
        const released = Schema.decodeUnknownSync(ReleasedReservationEffectSchema)(release.effects.read());

        expect(requested.result.outcome).toBe('PENDING');
        expect(released.activeAllocations).toEqual([]);
        expect(released.releaseOutcome).toBe('RELEASED');
        expect(released.request.effectId).toBe(releaseEffectId);
        expect(released.request.reservation.ref).toEqual(established.reservation.ref);
        expect(released.safeReleaseProof.order).toMatchObject({
          closureEvidenceRef: 'order-proof:closed:1',
          nonCommitEvidenceRef: 'order-proof:not-committed:1',
        });
        expect(released.safeReleaseProof.protection.evidenceRef).toBe('protection-proof:absent:1');
        expect(released.safelyReusable).toBe(true);
        expect(release.backendCalls()).toBe(1);
      }),
  );

  it.effect('preserves shortage rank, affected Position scope, recovery rank, and unreleased fences', () =>
    Effect.gen(function* acceptShortagePriority() {
      const result = yield* evaluateInventoryOwnerAcceptanceShortage();

      expect(result.atRisk.decisions).toEqual([
        expect.objectContaining({ amount: '3', capacity: 'SHORTAGE', health: 'AT_RISK' }),
        expect.objectContaining({ amount: '1', capacity: 'SHORTAGE', health: 'VALID' }),
      ]);
      expect(
        result.atRisk.decisions.some(
          ({ confirmationId }) => confirmationId === result.unrelatedPosition.confirmationId,
        ),
      ).toBe(false);
      expect(result.recovery.confirmationIdentityPreserved).toBe(true);
      expect(result.recovery.issuanceRankPreserved).toBe(true);
      expect(result.recovery.summary.decisions).toEqual([
        expect.objectContaining({ amount: '3', health: 'VALID' }),
        expect.objectContaining({ amount: '1', health: 'VALID' }),
      ]);
      expect(result.poolBoundary.decisions).toEqual([]);
      expect(result.poolBoundary.fencedAmount).toBe('1');
      expect(result.poolBoundary.explicitlyReleasedConfirmationId).not.toBe(
        result.poolBoundary.terminalUnreleasedConfirmationId,
      );
    }),
  );

  it.effect('preserves later material effects when correcting a Stock Position', () =>
    Effect.gen(function* acceptLateIssueCorrection() {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-25T10:05:00.000Z')));
      const result = yield* runInventoryOwnerAcceptanceLateIssueCorrectionScenario({
        correctStockPosition: ({
          authority: correctionAuthority,
          context,
          corrections,
          payload: correctionPayload,
          position: current,
          sourceEvidence,
        }) =>
          makeStockCorrectionService({
            assertions: { findById: () => Effect.succeed(Option.none()) },
            backendConfigurations: { findCurrent: () => Effect.succeed(Option.some(correctionAuthority)) },
            corrections,
            impacts: { evaluate: () => Effect.die('must not run') },
            positions: { read: () => Ref.get(current).pipe(Effect.map(Option.some)) },
            sourceEvidence: { findCurrentById: () => Effect.succeed(Option.some(sourceEvidence)) },
            sourceImports: { lockAndReadAcceptedHistory: () => Effect.succeed([]) },
          }).correct(correctionPayload, context),
      });

      expect(result).toEqual({
        correctionTag: 'INDETERMINATE',
        currentOnHandEstablished: false,
        materialEffectIds: ['ffffffff-ffff-4fff-8fff-ffffffffffff'],
        onHandTag: 'INDETERMINATE',
        outcome: 'RECONCILIATION_REQUIRED',
        reasonCode: 'MATERIAL_EFFECT_COVERAGE_MISSING',
      });
    }),
  );

  it.effect('ends Stock Sharing Eligibility without rewriting the historical relation scope or subject', () =>
    Effect.gen(function* acceptRelationEndHistory() {
      const result = yield* runStockSharingLifecycleAcceptance;

      expect(result.ended.lifecycle).toBe('ENDED');
      expect(result.evaluationFailure.reason).toBe('NO_APPLICABLE_CURRENT_RELATION');
      expect(result.history.map(({ revision }) => revision)).toEqual([1, 2]);
      expect(result.history[0]?.scope).toEqual(result.originalScope);
      expect(result.history[0]?.subject).toEqual(result.originalSubject);
    }),
  );

  it.effect('corrects the binding relation without redefining either immutable Stock Item meaning', () =>
    Effect.gen(function* acceptImmutableItemMeaning() {
      const result = yield* runBindingCorrectionMeaningAcceptance;

      expect(result.correctedBinding.revision).toBe(2);
      expect(result.correctedBinding.stockItemRef).toEqual(result.replacementItem.stockItemRef);
      expect(result.history[0]?.binding).toEqual(result.originalBinding);
      expect(result.originalItem.exactSelectionMeaning).toEqual(result.originalMeaning);
      expect(result.replacementItem.exactSelectionMeaning).toEqual(result.replacementMeaning);
    }),
  );

  it.effect('keeps delayed external evidence issuer-qualified and outside Current truth after owner cutover', () =>
    Effect.gen(function* acceptIssuerQualifiedCorrelation() {
      const result = yield* runExternalIssuerCutoverAcceptance;

      expect(Schema.is(HistoricalInventorySourceAssertionEvaluationSchema)(result.evaluation)).toBe(true);
      expect(result.evaluation.assertion.issuer.backendId).toBe('backend-a');
      expect(result.evaluation.assertion.issuerAuthority).toBe('HISTORICAL_PRE_CUTOVER_ISSUER');
      expect(result.selectedConfiguration.selection.backendId).toBe('backend-b');
      expect(result.evaluation.assertion.authorityConfiguration).toEqual(result.selectedConfiguration);
      expect(result.evaluation.postEffectOnHand).toBeNull();
      expect(result.currentness.establishesCurrentStockGuarantee).toBe(false);
      expect(result.currentness.hasCurrentStockGuarantee).toBe(false);
      expect(Schema.is(UnknownOnHandEvidenceSchema)(result.currentness.position.onHand)).toBe(true);
      expect(result.assertionHistory).toHaveLength(1);
      expect(result.assertionHistory[0]?.issuer).toEqual(result.proposal.issuer);
      expect(result.correlations.every(({ externalKey }) => externalKey.issuer.backendId === 'backend-a')).toBe(true);
    }),
  );
});
