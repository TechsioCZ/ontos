import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import type { OutboxWorkerHandlerContext, ScopedRoutineInvoker } from '@app/core-runtime';
import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { OutboxWorkerLegalEntityScopeFanout } from '@app/core-runtime/outbox/worker';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Deferred, Effect, Option, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';

import {
  CatalogToStockBindingRejected,
  ResolvedCatalogStockDemandSchema,
} from '../../shared/domain/catalog-to-stock-binding.ts';
import type { ResolvedCatalogStockDemand } from '../../shared/domain/catalog-to-stock-binding.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import { StockAllocationIdSchema } from '../../shared/domain/inventory-obligation.ts';
import {
  CreateInventoryReservationPayloadSchema,
  EstablishedReservationCreateEffectSchema,
  InventoryReservationCreateMutationIdSchema,
  InventoryReservationCreateRejected,
  ReconciliationRequiredReservationCreateEffectSchema,
} from '../../shared/domain/inventory-reservation-create.ts';
import type {
  InventoryReservationCreateRequest,
  ReservationCreateAllocation,
  ReservationCreateBackendObservation,
  ReservationCreateEffect,
} from '../../shared/domain/inventory-reservation-create.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { ExactStockQuantityAmountSchema, StockPositionSchema } from '../../shared/domain/stock-position.ts';
import { ActionInvocationIdSchema } from '../../shared/domain/physical-stock-effect.ts';
import { ReservationAuthorityEffectIdSchema } from '../../shared/domain/reservation-issuer-failure-fields.ts';
import { TrustedCurrentCommercePurchasingContextSchema } from '../../shared/domain/stock-sharing-eligibility.ts';
import type { ProvisionalInventoryReservation } from '../../shared/domain/inventory-obligation.ts';
import type {
  InventoryReservationCreateBackend,
  ReservationCreateEffectPersistence,
} from '../../src/services/inventory-reservation-create.service.ts';
import {
  makeInventoryReservationCreateExecutionService,
  makeInventoryReservationCreateService,
} from '../../src/services/inventory-reservation-create.service.ts';
import {
  inventoryEffectLedgerId,
  reservationCreateLedgerIntent,
} from '../../src/services/inventory-effect-ledger.service.ts';
import {
  inventoryReservationCreateEffects,
  inventoryReservationCreateEffectTransitionContract,
} from '../../src/persistence/reservation-create-effect-table.ts';
import {
  createInventoryReservationAction,
  handleCreateInventoryReservation,
} from '../../src/actions/create-inventory-reservation.action.ts';
import {
  handleExecuteInventoryReservationCreate,
  InventoryReservationCreateExecution,
} from '../../src/workers/execute-inventory-reservation-create.worker.ts';
import { makeInMemoryInventoryEffectLedger } from '../support/inventory-effect-ledger.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const reservationId = '33333333-3333-4333-8333-333333333333';
const itemId = '44444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';
const firstPositionId = '66666666-6666-4666-8666-666666666666';
const secondPositionId = '77777777-7777-4777-8777-777777777777';
const configurationId = '88888888-8888-4888-8888-888888888888';
const bindingId = '99999999-9999-4999-8999-999999999999';
const timestamp = '2026-09-24T10:00:00.000Z';
const effectId = Schema.decodeUnknownSync(ReservationAuthorityEffectIdSchema)('reservation-create-effect-1');
const actionInvocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const mutationId = Schema.decodeUnknownSync(InventoryReservationCreateMutationIdSchema)(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
);
const actionContext = {
  actionInvocationId,
  legalEntityId,
  tenantId,
  trustedStorefrontId: 'storefront-primary',
} as const;
const partialQuantity = Schema.decodeUnknownSync(ExactStockQuantityAmountSchema)('3');
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
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
const meaning = { id: 'catalog:package:meaning-1', kind: 'PACKAGE_OPTION' as const };
const stockItem = Schema.decodeUnknownSync(StockItemSchema)({
  createdAt: timestamp,
  exactSelectionMeaning: meaning,
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
  customerConfigurationId: 'customer-configuration-primary',
  revision: 1,
  selectedAt: timestamp,
  selection: {
    backend: 'external_business_system',
    backendId: 'erp-primary',
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
      evidenceRef: `stock:${resourceId}`,
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
      customerConfigurationId: authority.customerConfigurationId,
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
const positions = [
  position(firstPositionId, 'aaaaaaaa-0000-4000-8000-000000000001', '6'),
  position(secondPositionId, 'aaaaaaaa-0000-4000-8000-000000000002', '4'),
];
const resolved = (occurrenceId: string, quantity: string): ResolvedCatalogStockDemand =>
  Schema.decodeUnknownSync(ResolvedCatalogStockDemandSchema)({
    bindingRef: {
      moduleId: 'commerce.inventory',
      resourceId: bindingId,
      resourceType: 'commerce.inventory.catalog-to-stock-binding',
      tenantId,
    },
    catalogSelection: selection,
    exactSelectionMeaning: meaning,
    purchaseDemandOccurrenceId: occurrenceId,
    quantity,
    stockItem,
    unitRef,
  });
const decodePayload = Schema.decodeUnknownSync(CreateInventoryReservationPayloadSchema, { onExcessProperty: 'error' });
const reversed = <Value>(values: readonly Value[]): readonly Value[] => {
  const result: Value[] = [];
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined) {
      result.push(value);
    }
  }
  return result;
};
const payload = (
  demands = [resolved('occurrence-1', '10')],
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
      customerConfigurationId: authority.customerConfigurationId,
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
    customerConfigurationId: authority.customerConfigurationId,
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
  const records = yield* Ref.make<ReadonlyMap<string, ReservationCreateEffect>>(new Map());
  const obligations = yield* Ref.make<ReadonlyMap<string, ProvisionalInventoryReservation>>(new Map());
  const persistence: ReservationCreateEffectPersistence = {
    createOrRead: (request) =>
      Ref.modify(
        records,
        (
          current,
        ): [
          { readonly effect: ReservationCreateEffect; readonly outcome: 'EXISTING' | 'INSERTED' },
          ReadonlyMap<string, ReservationCreateEffect>,
        ] => {
          const existing = current.get(request.effectId);
          if (existing !== undefined) {
            return [{ effect: existing, outcome: 'EXISTING' as const }, current];
          }
          const record: ReservationCreateEffect = { _tag: 'REQUESTED', request };
          return [{ effect: record, outcome: 'INSERTED' as const }, new Map(current).set(request.effectId, record)];
        },
      ),
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
  return { obligations, persistence, records };
});

const plannedObservationAllocations = (
  request: InventoryReservationCreateRequest,
): readonly ReservationCreateAllocation[] =>
  request.reservation.requirements.flatMap(({ allocations }) =>
    allocations.map(({ positionRef, ...allocation }) => ({ ...allocation, stockPositionRef: positionRef })),
  );

const successfulObservation = (request: InventoryReservationCreateRequest): ReservationCreateBackendObservation => ({
  _tag: 'ESTABLISHED',
  allocations: plannedObservationAllocations(request),
  effectId: request.effectId,
  establishedAt: timestamp,
  ownerEvidenceRef: 'erp:reservation:42',
});

const makeHarness = Effect.gen(function* makeHarness() {
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
    makeAllocationId: ({ effectId: id, positionId, purchaseDemandOccurrenceId }) =>
      Schema.decodeUnknownSync(StockAllocationIdSchema)(`${id}:${purchaseDemandOccurrenceId}:${positionId}`),
    makeMutationId: () => mutationId,
    resolver: { resolve: (demand) => Effect.succeed(resolved(demand.purchaseDemandOccurrenceId, demand.quantity)) },
  });
  const execution = makeInventoryReservationCreateExecutionService({ backend, effects: effects.persistence, ledger });
  const execute = (request: InventoryReservationCreateRequest) =>
    execution.execute({ legalEntityId, tenantId }, request);
  return { backendCalls, effects, execute, observations, service };
});

describe('Inventory Reservation create result', () => {
  it('owns a tenant-scoped Attempt/effect ledger with immutable exact-request transition contract', () => {
    const table = getTableConfig(inventoryReservationCreateEffects);

    expect(table.enableRLS).toBe(true);
    expect(table.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        'inventory_reservation_create_effects_mutation_uk',
        'inventory_reservation_create_effects_attempt_uk',
        'inventory_reservation_create_effects_reservation_uk',
      ]),
    );
    expect(table.primaryKeys).toHaveLength(1);
    expect(table.primaryKeys[0]?.getName()).toBe('inventory_reservation_create_effects_pkey');
    expect(table.primaryKeys[0]?.columns.map(({ name }) => name)).toEqual(['tenant_id', 'effect_id']);
    expect(table.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
      'inventory_reservation_create_effects_backend_configuration_fk',
    );
    expect(inventoryReservationCreateEffectTransitionContract).toMatchObject({
      constraintName: 'inventory_reservation_create_effects_transition_ck',
      functionName: 'inventory.enforce_reservation_create_effect_transition',
      triggerName: 'inventory_reservation_create_effects_transition_trg',
    });
    expect(inventoryReservationCreateEffectTransitionContract.immutableColumns).toEqual(
      expect.arrayContaining([
        'effect_id',
        'attempt_id',
        'mutation_id',
        'reservation_id',
        'request_json',
        'requested_at',
        'source_action_invocation_id',
      ]),
    );
    expect(inventoryReservationCreateEffectTransitionContract.terminalStates).toContain('RESOLVED_NO_RESERVATION');
  });

  it.effect('establishes one complete Package Reservation split over two eligible Positions', () =>
    Effect.gen(function* completeSplit() {
      const harness = yield* makeHarness;
      const staged = yield* harness.service.create(payload(), actionContext);

      expect(staged.result.outcome).toBe('PENDING');
      expect(staged.dispatchRequested).toBe(true);
      expect(yield* Ref.get(harness.backendCalls)).toEqual([]);
      yield* harness.execute(staged.result.effect.request);
      const terminal = yield* harness.effects.persistence.read(effectId);
      expect(Option.isSome(terminal)).toBe(true);
      if (Option.isSome(terminal) && Schema.is(EstablishedReservationCreateEffectSchema)(terminal.value)) {
        const [requirement] = terminal.value.reservation.requirements;
        expect(requirement?.quantity).toBe('10');
        expect(requirement?.exactSelectionMeaning).toEqual(meaning);
        expect(requirement?.allocations.map(({ quantity }) => quantity.amount)).toEqual(['6', '4']);
        expect(requirement?.allocations.every(({ stockItemRef }) => stockItemRef.resourceId === itemId)).toBe(true);
      }
      expect((yield* Ref.get(harness.effects.obligations)).size).toBe(1);
    }),
  );

  it.effect('keeps equal-valued occurrences distinct and consumes the shared constrained pool once', () =>
    Effect.gen(function* preserveOccurrences() {
      const harness = yield* makeHarness;
      const staged = yield* harness.service.create(
        payload([resolved('occurrence-a', '5'), resolved('occurrence-b', '5')]),
        actionContext,
      );

      yield* harness.execute(staged.result.effect.request);
      const result = yield* harness.effects.persistence.read(effectId);
      if (Option.isSome(result) && Schema.is(EstablishedReservationCreateEffectSchema)(result.value)) {
        expect(
          result.value.reservation.requirements.map(({ purchaseDemandOccurrenceId }) => purchaseDemandOccurrenceId),
        ).toEqual(['occurrence-a', 'occurrence-b']);
        expect(
          result.value.reservation.requirements
            .flatMap(({ allocations }) => allocations)
            .map(({ quantity }) => quantity.amount),
        ).toEqual(['5', '1', '4']);
      }
    }),
  );

  it.effect('rejects known insufficient constrained stock before any backend effect', () =>
    Effect.gen(function* insufficient() {
      const harness = yield* makeHarness;
      const failure = yield* harness.service
        .create(payload([resolved('occurrence-1', '11')]), actionContext)
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'INSUFFICIENT_CONSTRAINED_STOCK' });
      expect(yield* Ref.get(harness.backendCalls)).toEqual([]);
      expect((yield* Ref.get(harness.effects.records)).size).toBe(0);
    }),
  );

  it.effect('persists a proven partial hold only as Reconciliation debt bound to the original effect', () =>
    Effect.gen(function* partialHold() {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.observations, [
        (request) => {
          const firstAllocation = plannedObservationAllocations(request).at(0);
          return firstAllocation === undefined
            ? {
                _tag: 'INDETERMINATE',
                effectId: request.effectId,
                observedAt: timestamp,
                reason: 'EVIDENCE_UNVERIFIABLE',
              }
            : {
                _tag: 'PARTIAL',
                constrainedAllocations: [
                  {
                    ...firstAllocation,
                    quantity: { amount: partialQuantity, unitRef },
                  },
                ],
                effectId: request.effectId,
                observedAt: timestamp,
                ownerEvidenceRef: 'erp:partial-hold:42',
              };
        },
      ]);

      const staged = yield* harness.service.create(payload(), actionContext);
      yield* harness.execute(staged.result.effect.request);
      const result = yield* harness.effects.persistence.read(effectId);
      expect(
        Option.isSome(result) && Schema.is(ReconciliationRequiredReservationCreateEffectSchema)(result.value),
      ).toBe(true);
      expect((yield* Ref.get(harness.effects.obligations)).size).toBe(0);

      const failure = yield* harness.service
        .create(payload(undefined, { effectId: 'competing-effect-2' }), actionContext)
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ reason: 'ATTEMPT_HAS_UNRESOLVED_EFFECT' });
    }),
  );

  it.effect('rejects duplicate partial-allocation identities as an invalid backend observation', () =>
    Effect.gen(function* duplicatePartialAllocation() {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.observations, [
        (request) => {
          const firstAllocation = plannedObservationAllocations(request).at(0);
          return firstAllocation === undefined
            ? {
                _tag: 'INDETERMINATE',
                effectId: request.effectId,
                observedAt: timestamp,
                reason: 'EVIDENCE_UNVERIFIABLE',
              }
            : {
                _tag: 'PARTIAL',
                constrainedAllocations: [firstAllocation, firstAllocation],
                effectId: request.effectId,
                observedAt: timestamp,
                ownerEvidenceRef: 'erp:invalid-duplicate-hold:42',
              };
        },
      ]);

      const staged = yield* harness.service.create(payload(), actionContext);
      const failure = yield* harness.execute(staged.result.effect.request).pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'INVALID_BACKEND_OBSERVATION' });
      expect((yield* Ref.get(harness.effects.obligations)).size).toBe(0);
    }),
  );

  it.effect('retries an indeterminate create only with the original effect identity', () =>
    Effect.gen(function* retryOriginalEffect() {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.observations, [
        (request) => ({
          _tag: 'INDETERMINATE',
          effectId: request.effectId,
          observedAt: timestamp,
          reason: 'BACKEND_OUTCOME_UNKNOWN',
        }),
        successfulObservation,
      ]);

      const staged = yield* harness.service.create(payload(), actionContext);
      yield* harness.execute(staged.result.effect.request);
      const first = yield* harness.service.create(payload(), actionContext);
      yield* harness.execute(staged.result.effect.request);
      const recovered = yield* harness.service.create(payload(), actionContext);

      expect(first.result.outcome).toBe('INDETERMINATE');
      expect(recovered.result.outcome).toBe('EXACT_REPLAY');
      expect((yield* Ref.get(harness.backendCalls)).map(({ effectId: id }) => id)).toEqual([effectId, effectId]);
    }),
  );

  it.effect('returns exact replay without executing the backend twice after establishment', () =>
    Effect.gen(function* exactReplay() {
      const harness = yield* makeHarness;
      const staged = yield* harness.service.create(payload(), actionContext);
      yield* harness.execute(staged.result.effect.request);
      const replay = yield* harness.service.create(payload(), actionContext);

      expect(replay.result.outcome).toBe('EXACT_REPLAY');
      expect(replay.dispatchRequested).toBe(false);
      expect((yield* Ref.get(harness.backendCalls)).length).toBe(1);
    }),
  );

  it.effect('collapses concurrent business-equivalent intents across regenerated metadata and demand order', () =>
    Effect.gen(function* stableLedgerIntent() {
      const harness = yield* makeHarness;
      const demands = [resolved('occurrence-1', '4'), resolved('occurrence-2', '6')];
      const staged = yield* harness.service.create(payload(demands), actionContext);
      const original = staged.result.effect;
      const reordered: ReservationCreateEffect = {
        _tag: 'REQUESTED',
        request: {
          ...original.request,
          mutationId: Schema.decodeUnknownSync(InventoryReservationCreateMutationIdSchema)(
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
          ),
          requestedAt: '2026-09-24T10:00:01.000Z',
          reservation: {
            ...original.request.reservation,
            requirements: reversed(
              original.request.reservation.requirements.map((requirement) => ({
                ...requirement,
                allocations: reversed(requirement.allocations),
              })),
            ),
          },
          sourceActionInvocationId: Schema.decodeUnknownSync(ActionInvocationIdSchema)(
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
          ),
        },
      };
      const ledger = makeInMemoryInventoryEffectLedger(timestamp);
      const results = yield* Effect.all(
        [
          ledger.claim(tenantId, inventoryEffectLedgerId(effectId), reservationCreateLedgerIntent(original)),
          ledger.claim(tenantId, inventoryEffectLedgerId(effectId), reservationCreateLedgerIntent(reordered)),
        ],
        { concurrency: 'unbounded' },
      );

      expect(new Set(results.map(({ outcome }) => outcome))).toEqual(new Set(['CLAIMED', 'EXACT_REPLAY']));
      expect(results[0]?.record.intent).toEqual(results[1]?.record.intent);
    }),
  );

  it.effect('returns the immutable exact replay without re-resolving later Commerce configuration', () =>
    Effect.gen(function* replayHistoricalIntent() {
      const harness = yield* makeHarness;
      const staged = yield* harness.service.create(payload(), actionContext);
      yield* harness.execute(staged.result.effect.request);
      const replayService = makeInventoryReservationCreateService({
        backendConfigurations: { findCurrent: () => Effect.die('authority must not be re-resolved for exact replay') },
        candidates: { lockCurrentForItem: () => Effect.die('stock must not be re-planned for exact replay') },
        commerceContexts: {
          resolveCurrent: () => Effect.die('Commerce context must not be re-resolved for exact replay'),
        },
        effects: harness.effects.persistence,
        eligibility: { isEligible: () => Effect.die('eligibility must not be re-resolved for exact replay') },
        ledger: makeInMemoryInventoryEffectLedger(timestamp),
        makeAllocationId: () => Schema.decodeUnknownSync(StockAllocationIdSchema)('unused'),
        makeMutationId: () => mutationId,
        resolver: { resolve: () => Effect.die('demand must not be re-resolved for exact replay') },
      });

      const replay = yield* replayService.create(payload(), actionContext);

      expect(replay.result.outcome).toBe('EXACT_REPLAY');
      expect(replay.dispatchRequested).toBe(false);
      expect(replay.result.effect.request).toEqual(staged.result.effect.request);
    }),
  );

  it.effect('returns one pending effect when identical creates miss the initial read and contend', () =>
    Effect.gen(function* concurrentExactReplay() {
      const effects = yield* makeEffects;
      const initialReadCount = yield* Ref.make(0);
      const attemptReadCount = yield* Ref.make(0);
      const contentionCount = yield* Ref.make(0);
      const createCount = yield* Ref.make(0);
      const commerceResolutionCount = yield* Ref.make(0);
      const bothInitialReads = yield* Deferred.make<null>();
      const bothAttemptReads = yield* Deferred.make<null>();
      const firstIntentCommitted = yield* Deferred.make<null>();
      const persistence: ReservationCreateEffectPersistence = {
        ...effects.persistence,
        createOrRead: (request) =>
          effects.persistence.createOrRead(request).pipe(
            Effect.tap(() => Ref.update(createCount, (count) => count + 1)),
            Effect.tap(() => Deferred.succeed(firstIntentCommitted, null)),
          ),
        findByAttempt: (attemptId) =>
          Ref.updateAndGet(attemptReadCount, (count) => count + 1).pipe(
            Effect.flatMap((readNumber) =>
              readNumber <= 2
                ? Effect.gen(function* synchronizeAttemptMisses() {
                    if (readNumber === 2) {
                      yield* Deferred.succeed(bothAttemptReads, null);
                    }
                    yield* Deferred.await(bothAttemptReads);
                    return Option.none<ReservationCreateEffect>();
                  })
                : effects.persistence.findByAttempt(attemptId),
            ),
          ),
        read: (id) =>
          Ref.updateAndGet(initialReadCount, (count) => count + 1).pipe(
            Effect.flatMap((readNumber) =>
              readNumber <= 2
                ? Effect.gen(function* synchronizeInitialMisses() {
                    if (readNumber === 2) {
                      yield* Deferred.succeed(bothInitialReads, null);
                    }
                    yield* Deferred.await(bothInitialReads);
                    return Option.none<ReservationCreateEffect>();
                  })
                : effects.persistence.read(id),
            ),
          ),
      };
      const service = makeInventoryReservationCreateService({
        backendConfigurations: { findCurrent: () => Effect.succeed(Option.some(authority)) },
        candidates: {
          lockCurrentForItem: () =>
            Ref.updateAndGet(contentionCount, (count) => count + 1).pipe(
              Effect.flatMap((contentionNumber) =>
                contentionNumber === 1
                  ? Effect.succeed(positions.map((current) => ({ position: current, reservedAmount: '0' })))
                  : Deferred.await(firstIntentCommitted).pipe(
                      Effect.as(positions.map((current) => ({ position: current, reservedAmount: '10' }))),
                    ),
              ),
            ),
        },
        commerceContexts: {
          resolveCurrent: () =>
            Ref.update(commerceResolutionCount, (count) => count + 1).pipe(Effect.as(payload().commerceContext)),
        },
        effects: persistence,
        eligibility: { isEligible: () => Effect.succeed(true) },
        ledger: makeInMemoryInventoryEffectLedger(timestamp),
        makeAllocationId: ({ effectId: id, positionId, purchaseDemandOccurrenceId }) =>
          Schema.decodeUnknownSync(StockAllocationIdSchema)(`${id}:${purchaseDemandOccurrenceId}:${positionId}`),
        makeMutationId: () => mutationId,
        resolver: {
          resolve: (current) => Effect.succeed(resolved(current.purchaseDemandOccurrenceId, current.quantity)),
        },
      });

      const results = yield* Effect.all(
        [service.create(payload(), actionContext), service.create(payload(), actionContext)],
        { concurrency: 'unbounded' },
      );

      expect(results.map(({ result }) => result.outcome)).toEqual(['PENDING', 'PENDING']);
      expect(results[1]?.result.effect).toEqual(results[0]?.result.effect);
      expect(results.filter(({ dispatchRequested }) => dispatchRequested)).toHaveLength(1);
      expect(yield* Ref.get(createCount)).toBe(1);
      expect(yield* Ref.get(commerceResolutionCount)).toBe(2);
      expect((yield* Ref.get(effects.records)).size).toBe(1);

      const conflict = yield* service.create(payload([resolved('occurrence-1', '9')]), actionContext).pipe(Effect.flip);
      expect(conflict).toMatchObject({ reason: 'EFFECT_ID_CONFLICT' });
    }),
  );

  it.effect('keeps missing binding distinct from insufficient stock', () =>
    Effect.gen(function* bindingFailure() {
      const harness = yield* makeHarness;
      const service = makeInventoryReservationCreateService({
        backendConfigurations: { findCurrent: () => Effect.succeed(Option.some(authority)) },
        candidates: { lockCurrentForItem: () => Effect.die('planner must not execute') },
        commerceContexts: { resolveCurrent: () => Effect.succeed(payload().commerceContext) },
        effects: harness.effects.persistence,
        eligibility: { isEligible: () => Effect.succeed(true) },
        ledger: makeInMemoryInventoryEffectLedger(timestamp),
        makeAllocationId: () => Schema.decodeUnknownSync(StockAllocationIdSchema)('unused'),
        makeMutationId: () => mutationId,
        resolver: {
          resolve: () =>
            Effect.fail(
              new CatalogToStockBindingRejected({
                code: 'catalog_to_stock_binding_rejected',
                reason: 'MISSING_BINDING',
              }),
            ),
        },
      });
      const failure = yield* service.create(payload(), actionContext).pipe(Effect.flip);

      expect(failure).toMatchObject({ outcome: 'MISSING', reason: 'MISSING_BINDING' });
      expect(Schema.is(InventoryReservationCreateRejected)(failure)).toBe(false);
    }),
  );

  it.effect('rejects a caller commerce context whose owner legal entity differs from the Action scope', () =>
    Effect.gen(function* rejectCrossEntityContext() {
      const harness = yield* makeHarness;
      const otherLegalEntityId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const derived = Schema.decodeUnknownSync(TrustedCurrentCommercePurchasingContextSchema)({
        ...payload().commerceContext,
        sellingLegalEntityRef: { ...payload().commerceContext.sellingLegalEntityRef, resourceId: otherLegalEntityId },
      });
      const service = makeInventoryReservationCreateService({
        backendConfigurations: { findCurrent: () => Effect.succeed(Option.some(authority)) },
        candidates: { lockCurrentForItem: () => Effect.die('planner must not execute') },
        commerceContexts: { resolveCurrent: () => Effect.succeed(derived) },
        effects: harness.effects.persistence,
        eligibility: { isEligible: () => Effect.succeed(true) },
        ledger: makeInMemoryInventoryEffectLedger(timestamp),
        makeAllocationId: () => Schema.decodeUnknownSync(StockAllocationIdSchema)('unused'),
        makeMutationId: () => mutationId,
        resolver: { resolve: () => Effect.die('resolver must not execute') },
      });

      const failure = yield* service.create(payload(), actionContext).pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'COMMERCE_CONTEXT_NOT_ELIGIBLE' });
      expect(yield* Ref.get(harness.backendCalls)).toEqual([]);
      expect((yield* Ref.get(harness.effects.records)).size).toBe(0);
    }),
  );

  it.effect('commits proven effect absence as resolved without a Reservation and replays it terminally', () =>
    Effect.gen(function* resolveNoReservation() {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.observations, [
        (request) => ({
          _tag: 'REJECTED',
          effectAbsenceProven: true,
          effectId: request.effectId,
          reason: 'INSUFFICIENT_STOCK',
        }),
      ]);

      const staged = yield* harness.service.create(payload(), actionContext);
      yield* harness.execute(staged.result.effect.request);
      const replay = yield* harness.service.create(payload(), actionContext);

      expect(replay.result.outcome).toBe('RESOLVED_NO_RESERVATION');
      expect(replay.dispatchRequested).toBe(false);
      expect((yield* Ref.get(harness.effects.obligations)).size).toBe(0);
      expect((yield* Ref.get(harness.backendCalls)).length).toBe(1);

      const competing = yield* harness.service
        .create(payload(undefined, { effectId: 'competing-effect-after-resolution' }), actionContext)
        .pipe(Effect.flip);
      expect(competing).toMatchObject({ reason: 'ATTEMPT_ALREADY_RESOLVED' });
    }),
  );

  it.effect('commits the pending intent and one linked self-outbox request before backend dispatch', () =>
    Effect.gen(function* stageActionIntent() {
      const harness = yield* makeHarness;
      const collector = createActionCollector(
        createInventoryReservationAction.descriptor.domainEvents,
        'commerce.inventory',
        createInventoryReservationAction.descriptor.accessEvidencePolicy,
        createInventoryReservationAction.descriptor.auditEvidenceSchema,
      );
      const result = yield* handleCreateInventoryReservation(payload(), {
        actionInvocationId,
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope: trustVerifiedGatewayPrincipalContext({
          authBindingId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
          authContextRef: 'test:inventory-reservation-create',
          authMethod: 'api_key',
          correlationId: 'inventory-reservation-create-test',
          legalEntityId,
          principalId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
          tenantId,
          trustedStorefrontId: 'storefront-primary',
        }),
        services: harness.service,
      });
      const material = collector.snapshot();

      expect(result.outcome).toBe('PENDING');
      expect(yield* Ref.get(harness.backendCalls)).toEqual([]);
      expect(material.domainEvents).toHaveLength(1);
      expect(material.outboxMessages).toHaveLength(1);
      expect(material.outboxMessages[0]?.domainEventIndex).toBe(0);
      expect(material.outboxMessages[0]?.message).toMatchObject({
        payloadJson: { request: result.effect.request },
        topic: 'commerce.inventory.inventory-reservation-create-requested.v1',
      });
    }),
  );

  it.effect('executes the exact Legal Entity worker scope and publishes the persisted terminal completion', () =>
    Effect.gen(function* executeWorkerIntent() {
      const harness = yield* makeHarness;
      const staged = yield* harness.service.create(payload(), actionContext);
      yield* harness.execute(staged.result.effect.request);
      const persisted = yield* harness.effects.persistence.read(effectId);
      const terminal = yield* Effect.fromOption(persisted).pipe(Effect.orDie);
      const completions: unknown[] = [];
      const executions: InventoryReservationCreateRequest[] = [];
      const workerDomainEventId = '11111111-2222-4333-8444-555555555555';
      const routineInvoker: ScopedRoutineInvoker = {
        invoke: (routine) =>
          Effect.sync(() => Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([{ record: terminal }])),
      };
      const workerScope: OutboxWorkerLegalEntityScope = {
        completionPublisher: {
          publish: (_definition, input) =>
            Effect.sync(() => {
              completions.push(input);
              return { domainEventId: workerDomainEventId, outcome: 'PUBLISHED' as const };
            }),
        },
        legalEntityId,
        routineInvoker,
        tenantId,
      };
      const requestWorkerContext: OutboxWorkerHandlerContext = {
        attemptNumber: 1,
        claimId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
        consumerModuleKey: 'commerce.inventory',
        deliveryId: 'ffffffff-ffff-4fff-8fff-fffffffffff1',
        domainEventId: workerDomainEventId,
        legalEntityScope: 'required',
        messageId: '22222222-3333-4444-8555-666666666666',
        producerModuleKey: 'commerce.inventory',
        tenantId,
        tenantSequenceNo: 1n,
        topic: 'commerce.inventory.inventory-reservation-create-requested.v1',
        workerKey: 'commerce.inventory.execute-inventory-reservation-create',
      };

      yield* handleExecuteInventoryReservationCreate(
        { request: staged.result.effect.request },
        requestWorkerContext,
      ).pipe(
        Effect.provideService(InventoryReservationCreateExecution, {
          execute: (_scope, request) =>
            Effect.sync(() => {
              executions.push(request);
            }),
        }),
        Effect.provideService(OutboxWorkerLegalEntityScopeFanout, {
          forEachScope: (_context, observe) => observe(workerScope),
        }),
      );

      expect(executions).toEqual([staged.result.effect.request]);
      expect(completions).toHaveLength(1);
      expect(completions[0]).toMatchObject({
        completionId: mutationId,
        payloadJson: terminal,
        sourceActionInvocationId: actionInvocationId,
        subjectResourceId: reservationId,
      });
    }),
  );

  it.effect('redispatches unresolved debt and later publishes terminal completion with the original identities', () =>
    Effect.gen(function* redispatchUntilTerminal() {
      const harness = yield* makeHarness;
      const staged = yield* harness.service.create(payload(), actionContext);
      yield* harness.execute(staged.result.effect.request);
      const persisted = yield* harness.effects.persistence.read(effectId);
      const established = yield* Effect.fromOption(persisted).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(EstablishedReservationCreateEffectSchema)),
        Effect.orDie,
      );
      const unresolved: ReservationCreateEffect = {
        _tag: 'INDETERMINATE',
        observedAt: timestamp,
        possibleConstrainedAllocations: plannedObservationAllocations(staged.result.effect.request),
        reason: 'BACKEND_OUTCOME_UNKNOWN',
        request: staged.result.effect.request,
      };
      const current = yield* Ref.make<ReservationCreateEffect>({
        _tag: 'REQUESTED',
        request: staged.result.effect.request,
      });
      const attempts = yield* Ref.make(0);
      const publications: { readonly input: unknown; readonly topic: string }[] = [];
      const routineInvoker: ScopedRoutineInvoker = {
        invoke: (routine) =>
          Ref.get(current).pipe(
            Effect.map((record) => Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([{ record }])),
          ),
      };
      const workerScope: OutboxWorkerLegalEntityScope = {
        completionPublisher: {
          publish: (definition, input) =>
            Effect.sync(() => {
              publications.push({ input, topic: definition.topic });
              return { domainEventId: input.completionId, outcome: 'PUBLISHED' as const };
            }),
        },
        legalEntityId,
        routineInvoker,
        tenantId,
      };
      const workerContext = (deliveryId: string): OutboxWorkerHandlerContext => ({
        attemptNumber: 1,
        claimId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
        consumerModuleKey: 'commerce.inventory',
        deliveryId,
        domainEventId: '11111111-2222-4333-8444-555555555555',
        legalEntityScope: 'required',
        messageId: '22222222-3333-4444-8555-666666666666',
        producerModuleKey: 'commerce.inventory',
        tenantId,
        tenantSequenceNo: 1n,
        topic: 'commerce.inventory.inventory-reservation-create-requested.v1',
        workerKey: 'commerce.inventory.execute-inventory-reservation-create',
      });
      const execution = {
        execute: () =>
          Ref.updateAndGet(attempts, (count) => count + 1).pipe(
            Effect.flatMap((count) => Ref.set(current, count === 1 ? unresolved : established)),
          ),
      };
      const fanout = {
        forEachScope: (
          _context: OutboxWorkerHandlerContext,
          observe: (scope: OutboxWorkerLegalEntityScope) => Effect.Effect<void, unknown, unknown>,
        ) => observe(workerScope),
      };

      yield* handleExecuteInventoryReservationCreate(
        { request: staged.result.effect.request },
        workerContext('33333333-4444-4555-8666-777777777777'),
      ).pipe(
        Effect.provideService(InventoryReservationCreateExecution, execution),
        Effect.provideService(OutboxWorkerLegalEntityScopeFanout, fanout),
      );
      yield* handleExecuteInventoryReservationCreate(
        { request: staged.result.effect.request },
        workerContext('44444444-5555-4666-8777-888888888888'),
      ).pipe(
        Effect.provideService(InventoryReservationCreateExecution, execution),
        Effect.provideService(OutboxWorkerLegalEntityScopeFanout, fanout),
      );

      expect(publications.map(({ topic }) => topic)).toEqual([
        'commerce.inventory.inventory-reservation-create-requested.v1',
        'commerce.inventory.inventory-reservation-create-completed.v1',
      ]);
      expect(publications[0]?.input).toMatchObject({
        payloadJson: { request: staged.result.effect.request },
        sourceActionInvocationId: actionInvocationId,
      });
      expect(publications[1]?.input).toMatchObject({
        completionId: mutationId,
        payloadJson: established,
        sourceActionInvocationId: actionInvocationId,
      });
      expect(yield* Ref.get(attempts)).toBe(2);
      expect(staged.result.effect.request.effectId).toBe(effectId);
      expect(staged.result.effect.request.mutationId).toBe(mutationId);
    }),
  );
});
