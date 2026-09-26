import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import type { OutboxWorkerHandlerContext, ScopedRoutineInvoker } from '@app/core-runtime';
import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { OutboxWorkerLegalEntityScopeFanout } from '@app/core-runtime/outbox/worker';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { ProvisionalInventoryReservation } from '../../shared/domain/inventory-obligation.ts';
import { ProvisionalInventoryReservationSchema } from '../../shared/domain/inventory-obligation.ts';
import {
  IndeterminateReservationReleaseEffectSchema,
  InventoryReservationReleaseRejected,
  NotReleasableReservationEffectSchema,
  ReleasedReservationEffectSchema,
  ReservationReleaseBackendObservationSchema,
  ReservationReleaseEffectIdSchema,
  ReservationReleaseMutationIdSchema,
} from '../../shared/domain/inventory-reservation-release.ts';
import { OrderCommitmentAttemptIdSchema } from '../../shared/inventory-launch-scope.ts';
import { ActionInvocationIdSchema, LegalEntityIdSchema } from '../../shared/domain/physical-stock-effect.ts';
import type {
  ReservationReleaseBackendObservation,
  ReservationReleaseEffect,
  ReservationReleaseRequest,
  ReservationReleaseOrderTruth,
  ReservationReleaseProtectionTruth,
  ReleaseInventoryReservationPayload,
} from '../../shared/domain/inventory-reservation-release.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { InventoryBackendIdSchema } from '../../shared/domain/inventory-backend-identifiers.ts';
import type {
  InventoryReservationReleaseBackend,
  ReservationReleaseEffectPersistence,
} from '../../src/services/inventory-reservation-release.service.ts';
import {
  makeInventoryReservationReleaseExecutionService,
  makeInventoryReservationReleaseService,
} from '../../src/services/inventory-reservation-release.service.ts';
import {
  inventoryEffectLedgerId,
  reservationReleaseLedgerIntent,
} from '../../src/services/inventory-effect-ledger.service.ts';
import { makeInMemoryInventoryEffectLedger } from '../support/inventory-effect-ledger.ts';
import {
  handleExecuteInventoryReservationRelease,
  InventoryReservationReleaseExecution,
} from '../../src/workers/execute-inventory-reservation-release.worker.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = LegalEntityIdSchema.make('22222222-2222-4222-8222-222222222222');
const reservationId = '33333333-3333-4333-8333-333333333333';
const itemId = '44444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';
const positionId = '66666666-6666-4666-8666-666666666666';
const configurationId = '77777777-7777-4777-8777-777777777777';
const bindingId = '88888888-8888-4888-8888-888888888888';
const timestamp = '2026-09-24T10:00:00.000Z';
const attemptId = OrderCommitmentAttemptIdSchema.make('attempt-checkout-1');
const actionInvocationId = ActionInvocationIdSchema.make('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
const releaseEffectId = Schema.decodeUnknownSync(ReservationReleaseEffectIdSchema)('release-effect:attempt-checkout-1');
const mutationId = Schema.decodeUnknownSync(ReservationReleaseMutationIdSchema)('99999999-9999-4999-8999-999999999999');

const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const stockItemRef = {
  moduleId: 'commerce.inventory' as const,
  resourceId: itemId,
  resourceType: 'commerce.inventory.stock-item' as const,
  tenantId,
};
const exactSelectionMeaning = { id: 'catalog-owner:selection-meaning-1', kind: 'PRODUCT_VARIANT' as const };
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
const stockItem = Schema.decodeUnknownSync(StockItemSchema)({
  createdAt: timestamp,
  exactSelectionMeaning,
  lifecycle: 'CURRENT',
  retiredAt: null,
  revision: 1,
  stockItemRef,
  unitRef,
});
const reservation = Schema.decodeUnknownSync(ProvisionalInventoryReservationSchema)({
  authority: {
    configurationId,
    customerConfigurationId: 'customer-configuration-primary',
    revision: 1,
    selectedAt: '2026-09-24T09:00:00.000Z',
    selection: {
      backend: 'external_business_system',
      backendId: 'erp-primary',
      exactReservationCapability: 'SUPPORTED',
      stockCorrectionCapability: 'UNSUPPORTED',
    },
    tenantId,
  },
  establishedAt: timestamp,
  lifecycleMeaning: 'PROVISIONAL_RESERVATION',
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
          stockItemRef,
        },
      ],
      bindingRef: {
        moduleId: 'commerce.inventory',
        resourceId: bindingId,
        resourceType: 'commerce.inventory.catalog-to-stock-binding',
        tenantId,
      },
      catalogSelection: selection,
      exactSelectionMeaning,
      purchaseDemandOccurrenceId: 'demand-occurrence-1',
      quantity: '10',
      stockItem,
      unitRef,
    },
  ],
});
const requirementId = reservation.requirements[0]?.purchaseDemandOccurrenceId;
if (requirementId === undefined) {
  throw new Error('Release test Reservation requires one Stock Requirement');
}

const payload = (overrides: Partial<ReleaseInventoryReservationPayload> = {}): ReleaseInventoryReservationPayload => ({
  attemptId,
  releaseEffectId,
  reservationRef: reservation.ref,
  scope: { _tag: 'WHOLE_RESERVATION' },
  ...overrides,
});

const memoryPersistence = () => {
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
        return Effect.fail(
          new InventoryReservationReleaseRejected({
            code: 'inventory_reservation_release_rejected',
            effectId: expected.request.effectId,
            reason: 'REVISION_CONFLICT',
          }),
        );
      }
      current = next;
      return Effect.succeed(next);
    },
  };
  return { persistence, read: () => current };
};

const wholeScope = (value: ProvisionalInventoryReservation) => ({
  allocations: value.requirements.flatMap(({ allocations }) =>
    allocations.map(({ allocationId, positionRef, quantity, stockItemRef: itemRef }) => ({
      allocationId,
      quantity,
      stockItemRef: itemRef,
      stockPositionRef: positionRef,
    })),
  ),
  attemptId: value.origin.attemptId,
  reservationId: value.ref.resourceId,
  tenantId: value.ref.tenantId,
});

const makeHarness = (input?: {
  readonly backendObservation?: ReservationReleaseBackendObservation;
  readonly orderTruth?: ReservationReleaseOrderTruth;
  readonly protectionTruth?: ReservationReleaseProtectionTruth;
}) => {
  const effects = memoryPersistence();
  const ledger = makeInMemoryInventoryEffectLedger(timestamp);
  let backendCalls = 0;
  let backendRequest: ReservationReleaseRequest | undefined;
  const backend: InventoryReservationReleaseBackend = {
    release: (request) => {
      backendCalls += 1;
      backendRequest = request;
      return Schema.decodeUnknownEffect(ReservationReleaseBackendObservationSchema)(
        input?.backendObservation ?? {
          _tag: 'RELEASED',
          effectId: request.effectId,
          issuer: {
            backend: request.reservation.authority.selection.backend,
            backendId: request.reservation.authority.selection.backendId,
            origin: 'EXTERNAL_BUSINESS_SYSTEM',
          },
          ownerEvidenceRef: 'owner-proof:release:1',
          releasedAt: '2026-09-24T10:05:00.000Z',
          scope: wholeScope(request.reservation),
        },
      ).pipe(Effect.orDie);
    },
  };
  const service = makeInventoryReservationReleaseService({
    effects: effects.persistence,
    ledger,
    makeMutationId: () => mutationId,
    obligations: { read: () => Effect.succeed(Option.some(reservation)) },
  });
  const execution = makeInventoryReservationReleaseExecutionService({
    backend,
    effects: effects.persistence,
    ledger,
    orderTruth: {
      read: () =>
        Effect.succeed(
          input?.orderTruth ?? {
            _tag: 'NOT_COMMITTED_CLOSED',
            closureEvidenceRef: 'order-proof:closed:1',
            nonCommitEvidenceRef: 'order-proof:not-committed:1',
            observedAt: '2026-09-24T10:03:00.000Z',
          },
        ),
    },
    protectionTruth: {
      read: () =>
        Effect.succeed(
          input?.protectionTruth ?? {
            _tag: 'ABSENT_PROVEN',
            evidenceRef: 'protection-proof:absent:1',
            observedAt: '2026-09-24T10:04:00.000Z',
          },
        ),
    },
  });
  return { backendCalls: () => backendCalls, backendRequest: () => backendRequest, effects, execution, service };
};

describe('Inventory Reservation Release', () => {
  it.effect('collapses regenerated Release dispatch metadata onto the same business intent', () =>
    Effect.gen(function* stableReleaseIntent() {
      const harness = makeHarness();
      const requested = yield* harness.service.request(payload(), {
        actionInvocationId,
        legalEntityId,
        requestedAt: timestamp,
        tenantId,
      });
      const original = requested.result.effect;
      const retried: ReservationReleaseEffect = {
        _tag: 'REQUESTED',
        request: {
          ...original.request,
          mutationId: ReservationReleaseMutationIdSchema.make('99999999-9999-4999-8999-999999999998'),
          requestedAt: '2026-09-24T10:00:01.000Z',
          sourceActionInvocationId: ActionInvocationIdSchema.make('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'),
        },
        revision: 1,
      };
      const ledger = makeInMemoryInventoryEffectLedger(timestamp);
      const results = yield* Effect.all(
        [
          ledger.claim(
            tenantId,
            inventoryEffectLedgerId(original.request.effectId),
            reservationReleaseLedgerIntent(original),
          ),
          ledger.claim(
            tenantId,
            inventoryEffectLedgerId(retried.request.effectId),
            reservationReleaseLedgerIntent(retried),
          ),
        ],
        { concurrency: 'unbounded' },
      );

      expect(new Set(results.map(({ outcome }) => outcome))).toEqual(new Set(['CLAIMED', 'EXACT_REPLAY']));
    }),
  );

  it.effect(
    'releases the whole provisional Reservation only after authoritative non-commit, closure, and no-Protection proofs',
    () =>
      Effect.gen(function* releaseWholeReservation() {
        const harness = makeHarness();
        const requested = yield* harness.service.request(payload(), {
          actionInvocationId,
          legalEntityId,
          requestedAt: timestamp,
          tenantId,
        });
        expect(requested.result.outcome).toBe('PENDING');

        yield* harness.execution.execute({ legalEntityId, tenantId }, requested.result.effect.request);

        const released = Schema.decodeUnknownSync(ReleasedReservationEffectSchema)(harness.effects.read());
        expect(released).toMatchObject({
          activeAllocations: [],
          releaseOutcome: 'RELEASED',
          request: {
            effectId: releaseEffectId,
            reservation: { origin: { attemptId }, ref: reservation.ref },
          },
          safeReleaseProof: {
            order: {
              _tag: 'NOT_COMMITTED_CLOSED',
              closureEvidenceRef: 'order-proof:closed:1',
              nonCommitEvidenceRef: 'order-proof:not-committed:1',
            },
            protection: { _tag: 'ABSENT_PROVEN', evidenceRef: 'protection-proof:absent:1' },
          },
        });
        expect(harness.backendCalls()).toBe(1);
      }),
  );

  it.effect('publishes one replay-stable Reservation guarantee change from persisted Release evidence', () =>
    Effect.gen(function* publishReleasedGuarantee() {
      const harness = makeHarness();
      const requested = yield* harness.service.request(payload(), {
        actionInvocationId,
        legalEntityId,
        requestedAt: timestamp,
        tenantId,
      });
      yield* harness.execution.execute({ legalEntityId, tenantId }, requested.result.effect.request);
      const terminal = Schema.decodeUnknownSync(ReleasedReservationEffectSchema)(harness.effects.read());
      const publications: { readonly input: unknown; readonly topic: string }[] = [];
      const routineInvoker: ScopedRoutineInvoker = {
        invoke: (routine) =>
          Effect.sync(() => Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([{ record: terminal }])),
      };
      const workerScope: OutboxWorkerLegalEntityScope = {
        completionPublisher: {
          publish: (definition, input) =>
            Effect.sync(() => {
              publications.push({ input, topic: definition.topic });
              return {
                domainEventId: input.completionId,
                outcome: publications.length === 1 ? ('PUBLISHED' as const) : ('ALREADY_PUBLISHED' as const),
              };
            }),
        },
        legalEntityId,
        routineInvoker,
        tenantId,
      };
      const context: OutboxWorkerHandlerContext = {
        attemptNumber: 1,
        claimId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        consumerModuleKey: 'commerce.inventory',
        deliveryId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        domainEventId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        legalEntityScope: 'required',
        messageId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        producerModuleKey: 'commerce.inventory',
        tenantId,
        tenantSequenceNo: 1n,
        topic: 'commerce.inventory.inventory-reservation-release-requested.v1',
        workerKey: 'commerce.inventory.execute-inventory-reservation-release',
      };
      const worker = handleExecuteInventoryReservationRelease({ request: terminal.request }, context).pipe(
        Effect.provideService(InventoryReservationReleaseExecution, { execute: () => Effect.void }),
        Effect.provideService(OutboxWorkerLegalEntityScopeFanout, {
          forEachScope: (_workerContext, observe) => observe(workerScope),
        }),
      );

      yield* worker;
      yield* worker;

      expect(publications).toHaveLength(2);
      expect(publications[0]).toEqual(publications[1]);
      expect(publications[0]).toMatchObject({ topic: 'commerce.inventory.reservation-guarantee-changed.v1' });
      expect(publications[0]?.input).toMatchObject({
        completionId: mutationId,
        occurredAt: new Date('2026-09-24T10:05:00.000Z'),
        payloadJson: {
          ordering: { _tag: 'IMMUTABLE_OCCURRENCE_IDENTITY', occurrenceId: mutationId },
          state: 'RELEASED',
          subjectRef: reservation.ref,
        },
      });
    }),
  );

  it.effect('executes only the durable original Reservation snapshot when a replay envelope is retargeted', () =>
    Effect.gen(function* rejectEnvelopeRetargeting() {
      const harness = makeHarness();
      const requested = yield* harness.service.request(payload(), {
        actionInvocationId,
        legalEntityId,
        requestedAt: timestamp,
        tenantId,
      });
      const originalRequest = requested.result.effect.request;
      const retargetedEnvelope: ReservationReleaseRequest = {
        ...originalRequest,
        reservation: {
          ...originalRequest.reservation,
          authority: {
            ...originalRequest.reservation.authority,
            selection: {
              ...originalRequest.reservation.authority.selection,
              backendId: InventoryBackendIdSchema.make('erp-replacement'),
            },
          },
        },
      };

      yield* harness.execution.execute({ legalEntityId, tenantId }, retargetedEnvelope);

      expect(harness.backendRequest()?.reservation.authority.selection.backendId).toBe('erp-primary');
      expect(Schema.is(ReleasedReservationEffectSchema)(harness.effects.read())).toBe(true);
    }),
  );

  it.effect('rejects a partial release request as a typed unsupported operation', () =>
    Effect.gen(function* rejectPartialRelease() {
      const harness = makeHarness();
      const failure = yield* harness.service
        .request(payload({ scope: { _tag: 'PARTIAL_RESERVATION', requirementIds: [requirementId] } }), {
          actionInvocationId,
          legalEntityId,
          requestedAt: timestamp,
          tenantId,
        })
        .pipe(Effect.flip);
      const rejection = Schema.decodeUnknownSync(InventoryReservationReleaseRejected)(failure);
      expect(rejection.reason).toBe('PARTIAL_RELEASE_UNSUPPORTED');
      expect(harness.effects.read()).toBeUndefined();
    }),
  );

  it.effect('never releases on expiry or abandonment without authoritative Order closure proof', () =>
    Effect.gen(function* refuseUnsafeRelease() {
      const harness = makeHarness({
        orderTruth: {
          _tag: 'INDETERMINATE',
          observedAt: '2026-09-24T10:03:00.000Z',
          reason: 'ORDER_EVIDENCE_UNAVAILABLE',
        },
      });
      const requested = yield* harness.service.request(payload(), {
        actionInvocationId,
        legalEntityId,
        requestedAt: timestamp,
        tenantId,
      });
      yield* harness.execution.execute({ legalEntityId, tenantId }, requested.result.effect.request);
      const indeterminate = Schema.decodeUnknownSync(IndeterminateReservationReleaseEffectSchema)(
        harness.effects.read(),
      );
      expect(indeterminate).toMatchObject({
        reason: 'ORDER_OUTCOME_UNKNOWN',
        safelyReusable: false,
      });
      expect(harness.backendCalls()).toBe(0);
    }),
  );

  it.effect('treats proven committed obligation as NOT_RELEASABLE without calling the Reservation Authority', () =>
    Effect.gen(function* committedIsNotReleasable() {
      const harness = makeHarness({
        orderTruth: {
          _tag: 'COMMITTED',
          evidenceRef: 'order-proof:committed:1',
          observedAt: '2026-09-24T10:03:00.000Z',
        },
      });
      const requested = yield* harness.service.request(payload(), {
        actionInvocationId,
        legalEntityId,
        requestedAt: timestamp,
        tenantId,
      });
      yield* harness.execution.execute({ legalEntityId, tenantId }, requested.result.effect.request);
      const notReleasable = Schema.decodeUnknownSync(NotReleasableReservationEffectSchema)(harness.effects.read());
      expect(notReleasable.reason).toBe('COMMITTED');
      expect(harness.backendCalls()).toBe(0);
    }),
  );

  it.effect('preserves late-proven in-time Protection as a fence even after Confirmation expiry', () =>
    Effect.gen(function* preserveProtectionFence() {
      const harness = makeHarness({
        protectionTruth: {
          _tag: 'ESTABLISHED',
          establishedAt: '2026-09-24T10:04:00.000Z',
          evidenceRef: 'protection-proof:established:1',
          observedAt: '2026-09-24T10:20:00.000Z',
        },
      });
      const requested = yield* harness.service.request(payload(), {
        actionInvocationId,
        legalEntityId,
        requestedAt: '2026-09-24T10:20:00.000Z',
        tenantId,
      });
      yield* harness.execution.execute({ legalEntityId, tenantId }, requested.result.effect.request);
      const notReleasable = Schema.decodeUnknownSync(NotReleasableReservationEffectSchema)(harness.effects.read());
      expect(notReleasable.reason).toBe('PROTECTION_ESTABLISHED');
      expect(harness.backendCalls()).toBe(0);
    }),
  );

  it.effect('keeps stock constrained when authoritative Protection truth is unknown', () =>
    Effect.gen(function* preserveUnknownProtectionFence() {
      const harness = makeHarness({
        protectionTruth: {
          _tag: 'INDETERMINATE',
          observedAt: '2026-09-24T10:04:00.000Z',
          reason: 'PROTECTION_EVIDENCE_UNAVAILABLE',
        },
      });
      const requested = yield* harness.service.request(payload(), {
        actionInvocationId,
        legalEntityId,
        requestedAt: timestamp,
        tenantId,
      });
      yield* harness.execution.execute({ legalEntityId, tenantId }, requested.result.effect.request);

      const indeterminate = Schema.decodeUnknownSync(IndeterminateReservationReleaseEffectSchema)(
        harness.effects.read(),
      );
      expect(indeterminate.reason).toBe('PROTECTION_OUTCOME_UNKNOWN');
      expect(indeterminate.safelyReusable).toBe(false);
      expect(harness.backendCalls()).toBe(0);
    }),
  );

  it.effect('rejects Release evidence from a replacement backend without retargeting the original Reservation', () =>
    Effect.gen(function* rejectReplacementBackend() {
      const harness = makeHarness({
        backendObservation: Schema.decodeUnknownSync(ReservationReleaseBackendObservationSchema)({
          _tag: 'RELEASED',
          effectId: releaseEffectId,
          issuer: {
            backend: 'external_business_system',
            backendId: 'erp-replacement',
            origin: 'EXTERNAL_BUSINESS_SYSTEM',
          },
          ownerEvidenceRef: 'owner-proof:release:replacement',
          releasedAt: '2026-09-24T10:05:00.000Z',
          scope: wholeScope(reservation),
        }),
      });
      const requested = yield* harness.service.request(payload(), {
        actionInvocationId,
        legalEntityId,
        requestedAt: timestamp,
        tenantId,
      });
      const failure = yield* harness.execution
        .execute({ legalEntityId, tenantId }, requested.result.effect.request)
        .pipe(Effect.flip);

      const rejection = Schema.decodeUnknownSync(InventoryReservationReleaseRejected)(failure);
      expect(rejection.reason).toBe('INVALID_BACKEND_OBSERVATION');
      expect(harness.backendCalls()).toBe(1);
    }),
  );

  it.effect('keeps an indeterminate owner outcome non-reusable and retries only the original effect identity', () =>
    Effect.gen(function* retainOriginalEffect() {
      const harness = makeHarness({
        backendObservation: {
          _tag: 'INDETERMINATE',
          effectId: releaseEffectId,
          observedAt: '2026-09-24T10:05:00.000Z',
          reason: 'AUTHORITY_OUTCOME_UNKNOWN',
        },
      });
      const first = yield* harness.service.request(payload(), {
        actionInvocationId,
        legalEntityId,
        requestedAt: timestamp,
        tenantId,
      });
      yield* harness.execution.execute({ legalEntityId, tenantId }, first.result.effect.request);
      const retry = yield* harness.service.request(payload(), {
        actionInvocationId,
        legalEntityId,
        requestedAt: timestamp,
        tenantId,
      });

      const indeterminate = Schema.decodeUnknownSync(IndeterminateReservationReleaseEffectSchema)(retry.result.effect);
      expect(retry.result.outcome).toBe('INDETERMINATE');
      expect(indeterminate.safelyReusable).toBe(false);
      expect(retry.result.effect.request.effectId).toBe(releaseEffectId);
      expect(retry.dispatchRequested).toBe(false);
    }),
  );

  it.effect('returns ALREADY_RELEASED on exact replay and never repeats the quantity effect', () =>
    Effect.gen(function* idempotentRelease() {
      const harness = makeHarness();
      const first = yield* harness.service.request(payload(), {
        actionInvocationId,
        legalEntityId,
        requestedAt: timestamp,
        tenantId,
      });
      yield* harness.execution.execute({ legalEntityId, tenantId }, first.result.effect.request);
      const replay = yield* harness.service.request(payload(), {
        actionInvocationId,
        legalEntityId,
        requestedAt: timestamp,
        tenantId,
      });
      yield* harness.execution.execute({ legalEntityId, tenantId }, replay.result.effect.request);

      expect(replay.result.outcome).toBe('ALREADY_RELEASED');
      expect(harness.backendCalls()).toBe(1);
    }),
  );
});
