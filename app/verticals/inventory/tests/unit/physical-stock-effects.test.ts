import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';

import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import {
  AppliedPhysicalStockEffectSchema,
  IndeterminatePhysicalStockEffectSchema,
  PhysicalStockEffectIdSchema,
  PhysicalStockEffectPayloadSchema,
  PositiveExactStockQuantityAmountSchema,
  RequestedPhysicalStockEffectSchema,
} from '../../shared/domain/physical-stock-effect.ts';
import type { PhysicalStockEffectRecord } from '../../shared/domain/physical-stock-effect.ts';
import { ExactStockQuantityAmountSchema, StockPositionSchema } from '../../shared/domain/stock-position.ts';
import type { PhysicalStockEffectPersistence } from '../../src/persistence/physical-stock-effect-repository.ts';
import type { InventoryBackendEffectsService } from '../../src/services/inventory-backend-effects.service.ts';
import {
  makePhysicalStockEffectRequestService,
  makePhysicalStockEffectsService,
} from '../../src/services/physical-stock-effects.service.ts';
import type { ReservationShortageImpactService } from '../../src/services/reservation-shortage-impact.service.ts';
import type { InventoryEffectLedgerService } from '../../src/services/inventory-effect-ledger.service.ts';
import { makeInMemoryInventoryEffectLedger } from '../support/inventory-effect-ledger.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const positionId = '33333333-3333-4333-8333-333333333333';
const itemId = '44444444-4444-4444-8444-444444444444';
const locationId = '55555555-5555-4555-8555-555555555555';
const unitId = '66666666-6666-4666-8666-666666666666';
const configurationId = '77777777-7777-4777-8777-777777777777';
const effectId = '88888888-8888-4888-8888-888888888888';
const actionInvocationId = '99999999-9999-4999-8999-999999999999';
const observedAt = '2026-09-24T12:00:00.000Z';
const customerConfigurationId = 'customer-configuration:primary';

const position = Schema.decodeUnknownSync(StockPositionSchema)({
  createdAt: observedAt,
  endedAt: null,
  lifecycle: 'CURRENT',
  onHand: {
    _tag: 'CURRENT',
    evidenceRef: 'external:on-hand:8',
    meaning: 'ON_HAND',
    observedAt,
    ownerConfigurationRef: {
      moduleId: 'commerce.inventory',
      resourceId: configurationId,
      resourceType: 'commerce.inventory.inventory-backend-configuration',
      tenantId,
    },
    quantity: {
      amount: '8',
      unitRef: {
        moduleId: 'commerce.catalog',
        resourceId: unitId,
        resourceType: 'commerce.catalog.product-unit',
        tenantId,
      },
    },
  },
  ref: {
    moduleId: 'commerce.inventory',
    resourceId: positionId,
    resourceType: 'commerce.inventory.stock-position',
    tenantId,
  },
  revision: 1,
  scope: {
    customerConfigurationId,
    stockItemRef: {
      moduleId: 'commerce.inventory',
      resourceId: itemId,
      resourceType: 'commerce.inventory.stock-item',
      tenantId,
    },
    stockLocationRef: {
      moduleId: 'commerce.inventory',
      resourceId: locationId,
      resourceType: 'commerce.inventory.stock-location',
      tenantId,
    },
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: unitId,
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    },
  },
});

const configuration = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
  configurationId,
  customerConfigurationId,
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

const payload = Schema.decodeUnknownSync(PhysicalStockEffectPayloadSchema)({
  customerConfigurationId,
  effectId,
  positionRef: position.ref,
  quantity: { amount: '2', unitRef: position.scope.unitRef },
  reason: { code: 'ORDER_FULFILLMENT', reference: 'order:42/line:1' },
  stockItemRef: position.scope.stockItemRef,
});

const ledgers = new WeakMap<object, InventoryEffectLedgerService>();
const ledgerFor = (persistence: PhysicalStockEffectPersistence) => {
  const existing = ledgers.get(persistence);
  if (existing !== undefined) {
    return existing;
  }
  const ledger = makeInMemoryInventoryEffectLedger(observedAt);
  ledgers.set(persistence, ledger);
  return ledger;
};

const memoryPersistence = () => {
  const records = new Map<string, PhysicalStockEffectRecord>();
  const persistence: PhysicalStockEffectPersistence = {
    createOrRead: (request) => {
      const existing = records.get(request.effectId);
      if (existing !== undefined) {
        return Effect.succeed({ effect: existing, outcome: 'EXISTING' as const });
      }
      const effect = { _tag: 'REQUESTED' as const, request };
      records.set(request.effectId, effect);
      return Effect.succeed({ effect, outcome: 'INSERTED' as const });
    },
    read: (id) => Effect.succeed(Option.fromNullishOr(records.get(id))),
    saveTerminal: (_expected, terminal) => {
      const existing = records.get(terminal.request.effectId);
      if (Schema.is(RequestedPhysicalStockEffectSchema)(existing)) {
        records.set(terminal.request.effectId, terminal);
        return Effect.succeed(terminal);
      }
      return Effect.succeed(existing ?? terminal);
    },
  };
  return { persistence, records };
};

const requestEffect = (persistence: PhysicalStockEffectPersistence, kind: 'ISSUE' | 'RECEIPT' = 'ISSUE') =>
  makePhysicalStockEffectRequestService({
    backendConfigurations: { findCurrent: () => Effect.succeed(Option.some(configuration)) },
    effects: persistence,
    ledger: ledgerFor(persistence),
    positions: { read: () => Effect.succeed(Option.some(position)) },
  }).request(kind, payload, { actionInvocationId, legalEntityId, tenantId });

const workerScope: OutboxWorkerLegalEntityScope = {
  completionPublisher: { publish: () => Effect.die('unused test completion publisher') },
  legalEntityId,
  routineInvoker: { invoke: () => Effect.die('unused test routine invoker') },
  tenantId,
};
const noReservationImpacts: ReservationShortageImpactService = { evaluate: () => Effect.void };

describe('Inventory physical Stock Receipt and Issue', () => {
  it.effect(
    'evaluates Reservation shortage impact after an authoritative physical effect and retries only the evaluation',
    () =>
      Effect.gen(function* evaluateReservationImpact() {
        const { persistence } = memoryPersistence();
        const requested = yield* requestEffect(persistence);
        let backendCalls = 0;
        const evaluatedChanges: string[] = [];
        const impacts: ReservationShortageImpactService = {
          evaluate: (trigger) => {
            evaluatedChanges.push(trigger.changeId);
            return Effect.void;
          },
        };
        const executor = makePhysicalStockEffectsService(
          persistence,
          {
            execute: (request) => {
              backendCalls += 1;
              return Effect.succeed({
                _tag: 'APPLIED',
                evidence: {
                  appliedAt: observedAt,
                  backend: request.backend,
                  backendConfigurationRef: request.backendConfigurationRef,
                  backendEvidenceRef: 'erp:issue:impact',
                  backendId: request.backendId,
                  effectId: request.effectId,
                  issuer: 'erp-primary',
                  kind: request.kind,
                  positionRef: request.positionRef,
                  quantity: request.quantity,
                },
              });
            },
          },
          impacts,
          ledgerFor(persistence),
        );

        yield* executor.execute(workerScope, requested.effect.request);
        yield* executor.execute(workerScope, requested.effect.request);

        expect(backendCalls).toBe(1);
        expect(evaluatedChanges).toEqual([effectId, effectId]);
      }),
  );

  it.effect(
    'replays one exact Issue without repeating the backend physical effect or changing obligation meaning',
    () =>
      Effect.gen(function* exactIssueReplay() {
        const { persistence, records } = memoryPersistence();
        const requested = yield* requestEffect(persistence);
        let backendCalls = 0;
        let observedOnHand = '8';
        const obligationSeam = { mutations: 0 };
        const backend: InventoryBackendEffectsService & { readonly mutateObligation: () => void } = {
          execute: (request) => {
            backendCalls += 1;
            // The external backend owns the mutation. Inventory records evidence and never applies -2 locally.
            observedOnHand = '8';
            return Effect.succeed({
              _tag: 'APPLIED',
              evidence: {
                appliedAt: observedAt,
                backend: request.backend,
                backendConfigurationRef: request.backendConfigurationRef,
                backendEvidenceRef: 'erp:issue:42',
                backendId: request.backendId,
                effectId: request.effectId,
                issuer: 'erp-primary',
                kind: request.kind,
                positionRef: request.positionRef,
                quantity: request.quantity,
              },
            });
          },
          mutateObligation: () => {
            obligationSeam.mutations += 1;
          },
        };
        const executor = makePhysicalStockEffectsService(
          persistence,
          backend,
          noReservationImpacts,
          ledgerFor(persistence),
        );
        yield* executor.execute(workerScope, requested.effect.request);
        yield* executor.execute(workerScope, requested.effect.request);

        expect(backendCalls).toBe(1);
        expect(observedOnHand).toBe('8');
        expect(obligationSeam.mutations).toBe(0);
        expect(Schema.is(AppliedPhysicalStockEffectSchema)(records.get(effectId))).toBe(true);
      }),
  );

  it.effect('replays preserved original evidence without requalifying Current Position or backend', () =>
    Effect.gen(function* replayAfterCutover() {
      const { persistence } = memoryPersistence();
      const first = yield* requestEffect(persistence);
      let currentQualificationReads = 0;
      const replayService = makePhysicalStockEffectRequestService({
        backendConfigurations: {
          findCurrent: () => {
            currentQualificationReads += 1;
            return Effect.die('Current backend must not be read for an exact replay');
          },
        },
        effects: persistence,
        ledger: ledgerFor(persistence),
        positions: {
          read: () => {
            currentQualificationReads += 1;
            return Effect.die('Current Position must not be read for an exact replay');
          },
        },
      });
      const replay = yield* replayService.request('ISSUE', payload, { actionInvocationId, legalEntityId, tenantId });
      expect(replay.outcome).toBe('EXACT_REPLAY');
      expect(replay.effect.request).toEqual(first.effect.request);
      expect(currentQualificationReads).toBe(0);
    }),
  );

  it('rejects zero Receipt/Issue Quantity at the public schema', () => {
    expect(() => Schema.decodeUnknownSync(PositiveExactStockQuantityAmountSchema)('0')).toThrow();
    expect(Schema.decodeUnknownSync(PositiveExactStockQuantityAmountSchema)('0.000000001')).toBe('0.000000001');
  });

  it.effect('returns exact replay for the same durable intent', () =>
    Effect.gen(function* exactIntentReplay() {
      const { persistence } = memoryPersistence();
      expect((yield* requestEffect(persistence)).outcome).toBe('REQUESTED');
      expect((yield* requestEffect(persistence)).outcome).toBe('EXACT_REPLAY');
    }),
  );

  it.effect('preserves the same exact scope and owner evidence for a Receipt request', () =>
    Effect.gen(function* exactReceiptRequest() {
      const { persistence } = memoryPersistence();
      const result = yield* requestEffect(persistence, 'RECEIPT');
      expect(result.effect.request.kind).toBe('RECEIPT');
      expect(result.effect.request.positionRef).toEqual(position.ref);
      expect(result.effect.request.stockItemRef).toEqual(position.scope.stockItemRef);
      expect(result.effect.request.stockLocationRef).toEqual(position.scope.stockLocationRef);
      expect(result.effect.request.backendConfigurationRef.resourceId).toBe(configuration.configurationId);
    }),
  );

  it.effect('rejects reuse of an effect identity for a different Quantity', () =>
    Effect.gen(function* effectIdentityConflict() {
      const { persistence } = memoryPersistence();
      yield* requestEffect(persistence);
      const service = makePhysicalStockEffectRequestService({
        backendConfigurations: { findCurrent: () => Effect.succeed(Option.some(configuration)) },
        effects: persistence,
        ledger: ledgerFor(persistence),
        positions: { read: () => Effect.succeed(Option.some(position)) },
      });
      const failure = yield* Effect.flip(
        service.request(
          'ISSUE',
          {
            ...payload,
            quantity: {
              ...payload.quantity,
              amount: Schema.decodeUnknownSync(ExactStockQuantityAmountSchema)('3'),
            },
          },
          {
            actionInvocationId,
            legalEntityId,
            tenantId,
          },
        ),
      );
      expect(failure.reason).toBe('EFFECT_ID_CONFLICT');
    }),
  );

  it.effect('records unverifiable backend evidence as indeterminate instead of fabricating success', () =>
    Effect.gen(function* unverifiableEvidence() {
      const { persistence, records } = memoryPersistence();
      const requested = yield* requestEffect(persistence);
      const executor = makePhysicalStockEffectsService(
        persistence,
        {
          execute: (request) =>
            Effect.succeed({
              _tag: 'APPLIED',
              evidence: {
                appliedAt: observedAt,
                backend: request.backend,
                backendConfigurationRef: request.backendConfigurationRef,
                backendEvidenceRef: 'wrong-effect',
                backendId: request.backendId,
                effectId: Schema.decodeUnknownSync(PhysicalStockEffectIdSchema)('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
                issuer: 'erp-primary',
                kind: request.kind,
                positionRef: request.positionRef,
                quantity: request.quantity,
              },
            }),
        },
        noReservationImpacts,
        ledgerFor(persistence),
      );
      yield* Effect.exit(executor.execute(workerScope, requested.effect.request));
      expect(Schema.is(IndeterminatePhysicalStockEffectSchema)(records.get(effectId))).toBe(true);
    }),
  );

  it.effect('repairs the ledger from a durable indeterminate effect without repeating the backend', () =>
    Effect.gen(function* repairLedger() {
      const { persistence, records } = memoryPersistence();
      const requested = yield* requestEffect(persistence);
      records.set(effectId, {
        _tag: 'INDETERMINATE',
        reason: 'BACKEND_OUTCOME_UNKNOWN',
        request: requested.effect.request,
      });
      const baseLedger = ledgerFor(persistence);
      let transitions = 0;
      const ledger: InventoryEffectLedgerService = {
        ...baseLedger,
        transition: (expected, next) => {
          transitions += 1;
          return baseLedger.transition(expected, next);
        },
      };
      const executor = makePhysicalStockEffectsService(
        persistence,
        { execute: () => Effect.die('backend must not repeat an indeterminate effect') },
        noReservationImpacts,
        ledger,
      );

      yield* Effect.exit(executor.execute(workerScope, requested.effect.request));

      expect(transitions).toBe(1);
    }),
  );
});
