import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { OutboxWorkerLegalEntityScopeFanout } from '@app/core-runtime/outbox/worker';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import type { ActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import type { DomainEventContractMap } from '../../../../packages/core-runtime/src/actions/events.ts';
import {
  PhysicalStockEffectIndeterminate,
  PhysicalStockEffectConflict,
  PhysicalStockEffectPayloadSchema,
  PhysicalStockEffectRequestSchema,
  RequestedPhysicalStockEffectSchema,
} from '../../shared/domain/physical-stock-effect.ts';
import type { PhysicalStockEffectKind, PhysicalStockEffectRecord } from '../../shared/domain/physical-stock-effect.ts';
import { handleStockIssue, stockIssueAction } from '../../src/actions/stock-issue.action.ts';
import { handleStockReceipt, stockReceiptAction } from '../../src/actions/stock-receipt.action.ts';
import { mapStockIssueActionProblem } from '../../api/stock-issue-action-problems.ts';
import { mapStockReceiptActionProblem } from '../../api/stock-receipt-action-problems.ts';
import type { PhysicalStockEffectRequestService } from '../../src/services/physical-stock-effects.service.ts';
import { PhysicalStockEffects } from '../../src/services/physical-stock-effects.service.ts';
import { handleExecuteStockIssue } from '../../src/workers/execute-stock-issue.worker.ts';
import { handleExecuteStockReceipt } from '../../src/workers/execute-stock-receipt.worker.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const actionInvocationId = '99999999-9999-4999-8999-999999999999';
const effectId = '88888888-8888-4888-8888-888888888888';
const positionId = '33333333-3333-4333-8333-333333333333';
const itemId = '44444444-4444-4444-8444-444444444444';
const locationId = '55555555-5555-4555-8555-555555555555';
const unitId = '66666666-6666-4666-8666-666666666666';
const configurationId = '77777777-7777-4777-8777-777777777777';
const requestedAt = '2026-09-24T12:00:00.000Z';
const appliedAt = '2026-09-24T12:05:00.000Z';

const payload = Schema.decodeUnknownSync(PhysicalStockEffectPayloadSchema)({
  customerConfigurationId: 'customer-configuration:primary',
  effectId,
  positionRef: {
    moduleId: 'commerce.inventory',
    resourceId: positionId,
    resourceType: 'commerce.inventory.stock-position',
    tenantId,
  },
  quantity: {
    amount: '2',
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: unitId,
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    },
  },
  reason: { code: 'ORDER_FULFILLMENT', reference: 'order:42/line:1' },
  stockItemRef: {
    moduleId: 'commerce.inventory',
    resourceId: itemId,
    resourceType: 'commerce.inventory.stock-item',
    tenantId,
  },
});

const requestFor = (kind: PhysicalStockEffectKind) =>
  Schema.decodeUnknownSync(PhysicalStockEffectRequestSchema)({
    actionInvocationId,
    backend: 'external_business_system',
    backendConfigurationRef: {
      moduleId: 'commerce.inventory',
      resourceId: configurationId,
      resourceType: 'commerce.inventory.inventory-backend-configuration',
      tenantId,
    },
    backendId: 'erp-primary',
    customerConfigurationId: payload.customerConfigurationId,
    effectId,
    kind,
    legalEntityId,
    positionRef: payload.positionRef,
    quantity: payload.quantity,
    reason: payload.reason,
    requestedAt,
    stockItemRef: payload.stockItemRef,
    stockLocationRef: {
      moduleId: 'commerce.inventory',
      resourceId: locationId,
      resourceType: 'commerce.inventory.stock-location',
      tenantId,
    },
  });

const appliedFor = (kind: PhysicalStockEffectKind) => {
  const request = requestFor(kind);
  return {
    _tag: 'APPLIED' as const,
    evidence: {
      appliedAt,
      backend: request.backend,
      backendConfigurationRef: request.backendConfigurationRef,
      backendEvidenceRef: `erp:${kind.toLowerCase()}:42`,
      backendId: request.backendId,
      effectId: request.effectId,
      issuer: 'erp-primary',
      kind,
      positionRef: request.positionRef,
      quantity: request.quantity,
    },
    request,
  };
};

const actionContext = <DomainEvents extends DomainEventContractMap>(
  collector: ActionCollector<DomainEvents>,
  services: PhysicalStockEffectRequestService,
) => ({
  actionInvocationId,
  addDomainEvent: collector.addDomainEvent,
  addOutboxMessage: collector.addOutboxMessage,
  recordAuditEvidence: collector.recordAuditEvidence,
  recordDataAccess: collector.recordDataAccess,
  scope: trustVerifiedGatewayPrincipalContext({
    authBindingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    authContextRef: 'test:physical-stock-effect',
    authMethod: 'api_key' as const,
    correlationId: 'physical-stock-effect-test',
    legalEntityId,
    principalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    tenantId,
  }),
  services,
});

const runStockIssueAction = (effect: PhysicalStockEffectRecord, outcome: 'EXACT_REPLAY' | 'REQUESTED') => {
  const collector = createActionCollector(
    stockIssueAction.descriptor.domainEvents,
    'commerce.inventory',
    stockIssueAction.descriptor.accessEvidencePolicy,
    stockIssueAction.descriptor.auditEvidenceSchema,
  );
  const services: PhysicalStockEffectRequestService = { request: () => Effect.succeed({ effect, outcome }) };
  return handleStockIssue(payload, actionContext(collector, services)).pipe(
    Effect.map((result) => ({ material: collector.snapshot(), result })),
  );
};

const runStockReceiptAction = (effect: PhysicalStockEffectRecord, outcome: 'EXACT_REPLAY' | 'REQUESTED') => {
  const collector = createActionCollector(
    stockReceiptAction.descriptor.domainEvents,
    'commerce.inventory',
    stockReceiptAction.descriptor.accessEvidencePolicy,
    stockReceiptAction.descriptor.auditEvidenceSchema,
  );
  const services: PhysicalStockEffectRequestService = { request: () => Effect.succeed({ effect, outcome }) };
  return handleStockReceipt(payload, actionContext(collector, services)).pipe(
    Effect.map((result) => ({ material: collector.snapshot(), result })),
  );
};

const workerScope: OutboxWorkerLegalEntityScope = {
  completionPublisher: {
    publish: () => Effect.succeed({ domainEventId: effectId, outcome: 'PUBLISHED' as const }),
  },
  legalEntityId,
  routineInvoker: { invoke: () => Effect.die('unused test routine invoker') },
  tenantId,
};

const workerContext = (kind: PhysicalStockEffectKind): OutboxWorkerHandlerContext => ({
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
  topic: `commerce.inventory.stock-${kind === 'ISSUE' ? 'issue' : 'receipt'}-requested.v1`,
  workerKey: `commerce.inventory.execute-stock-${kind === 'ISSUE' ? 'issue' : 'receipt'}`,
});

describe('Inventory physical effect Actions and workers', () => {
  it('maps effect identity reuse conflict to HTTP 409 for both Actions', () => {
    const conflict = new PhysicalStockEffectConflict({
      code: 'physical_stock_effect_conflict',
      effectId: payload.effectId,
      reason: 'EFFECT_ID_CONFLICT',
    });
    expect(mapStockIssueActionProblem(conflict).status).toBe(409);
    expect(mapStockReceiptActionProblem(conflict).status).toBe(409);
  });

  for (const [kind, runAction, topic] of [
    ['ISSUE', runStockIssueAction, 'commerce.inventory.stock-issue-requested.v1'],
    ['RECEIPT', runStockReceiptAction, 'commerce.inventory.stock-receipt-requested.v1'],
  ] as const) {
    it.effect(`${kind} Action emits one linked request and emits nothing on exact replay`, () =>
      Effect.gen(function* actionOutboxContract() {
        const request = requestFor(kind);
        const first = yield* runAction({ _tag: 'REQUESTED', request }, 'REQUESTED');
        expect(Schema.is(RequestedPhysicalStockEffectSchema)(first.result.effect)).toBe(true);
        expect(first.material.domainEvents).toHaveLength(1);
        expect(first.material.outboxMessages).toHaveLength(1);
        expect(first.material.outboxMessages[0]?.domainEventIndex).toBe(0);
        expect(first.material.outboxMessages[0]?.message.topic).toBe(topic);
        expect(first.material.outboxMessages[0]?.message.payloadJson).toEqual({ request });

        const replay = yield* runAction(
          {
            _tag: 'APPLIED',
            evidence: {
              appliedAt: requestedAt,
              backend: request.backend,
              backendConfigurationRef: request.backendConfigurationRef,
              backendEvidenceRef: 'erp:evidence:1',
              backendId: request.backendId,
              effectId: request.effectId,
              issuer: 'erp-primary',
              kind,
              positionRef: request.positionRef,
              quantity: request.quantity,
            },
            request,
          },
          'EXACT_REPLAY',
        );
        expect(replay.material.domainEvents).toHaveLength(0);
        expect(replay.material.outboxMessages).toHaveLength(0);
      }),
    );
  }

  it.effect('both owner-local workers execute only their exact effect kind', () =>
    Effect.gen(function* workerDispatch() {
      const executed: PhysicalStockEffectKind[] = [];
      const services = {
        execute: (_scope: OutboxWorkerLegalEntityScope, request: ReturnType<typeof requestFor>) =>
          Effect.sync(() => {
            executed.push(request.kind);
            return appliedFor(request.kind);
          }),
      };
      const fanout = {
        forEachScope: (
          _context: OutboxWorkerHandlerContext,
          observe: (scope: OutboxWorkerLegalEntityScope) => Effect.Effect<void, unknown, unknown>,
        ) => observe(workerScope),
      };
      yield* handleExecuteStockIssue({ request: requestFor('ISSUE') }, workerContext('ISSUE')).pipe(
        Effect.provideService(PhysicalStockEffects, services),
        Effect.provideService(OutboxWorkerLegalEntityScopeFanout, fanout),
      );
      yield* handleExecuteStockReceipt({ request: requestFor('RECEIPT') }, workerContext('RECEIPT')).pipe(
        Effect.provideService(PhysicalStockEffects, services),
        Effect.provideService(OutboxWorkerLegalEntityScopeFanout, fanout),
      );
      expect(executed).toEqual(['ISSUE', 'RECEIPT']);
    }),
  );

  for (const [kind, handle] of [
    ['ISSUE', handleExecuteStockIssue],
    ['RECEIPT', handleExecuteStockReceipt],
  ] as const) {
    it.effect(`${kind} worker publishes one replay-stable Stock Position evidence change from the applied effect`, () =>
      Effect.gen(function* publishAppliedEffect() {
        const publications: { readonly input: unknown; readonly topic: string }[] = [];
        const publishingScope: OutboxWorkerLegalEntityScope = {
          ...workerScope,
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
        };
        const services = { execute: () => Effect.succeed(appliedFor(kind)) };
        const fanout = {
          forEachScope: (
            _context: OutboxWorkerHandlerContext,
            observe: (scope: OutboxWorkerLegalEntityScope) => Effect.Effect<void, unknown, unknown>,
          ) => observe(publishingScope),
        };
        const worker = handle({ request: requestFor(kind) }, workerContext(kind)).pipe(
          Effect.provideService(PhysicalStockEffects, services),
          Effect.provideService(OutboxWorkerLegalEntityScopeFanout, fanout),
        );

        yield* worker;
        yield* worker;

        expect(publications).toHaveLength(2);
        expect(publications[0]).toEqual(publications[1]);
        expect(publications[0]).toMatchObject({ topic: 'commerce.inventory.stock-position-evidence-changed.v1' });
        expect(publications[0]?.input).toMatchObject({
          completionId: effectId,
          occurredAt: new Date(appliedAt),
          payloadJson: {
            ordering: { _tag: 'IMMUTABLE_OCCURRENCE_IDENTITY', occurrenceId: effectId },
            state: kind === 'ISSUE' ? 'ISSUE_APPLIED' : 'RECEIPT_APPLIED',
            subjectRef: payload.positionRef,
          },
        });
      }),
    );
  }

  it.effect('does not publish a Stock Position evidence change for an indeterminate effect', () =>
    Effect.gen(function* rejectIndeterminatePublication() {
      let publications = 0;
      const publishingScope: OutboxWorkerLegalEntityScope = {
        ...workerScope,
        completionPublisher: {
          publish: () =>
            Effect.sync(() => {
              publications += 1;
              return { domainEventId: effectId, outcome: 'PUBLISHED' as const };
            }),
        },
      };
      const failure = yield* handleExecuteStockIssue({ request: requestFor('ISSUE') }, workerContext('ISSUE')).pipe(
        Effect.provideService(PhysicalStockEffects, {
          execute: () =>
            Effect.fail(
              new PhysicalStockEffectIndeterminate({
                code: 'physical_stock_effect_indeterminate',
                effectId: payload.effectId,
                reason: 'BACKEND_OUTCOME_UNKNOWN',
                retryable: true,
              }),
            ),
        }),
        Effect.provideService(OutboxWorkerLegalEntityScopeFanout, {
          forEachScope: (_context, observe) => observe(publishingScope),
        }),
        Effect.flip,
      );

      expect(failure.reason).toBe('BACKEND_OUTCOME_UNKNOWN');
      expect(publications).toBe(0);
    }),
  );

  it.effect('workers fail closed before execution when delivery context mismatches', () =>
    Effect.gen(function* workerContextMismatch() {
      let executions = 0;
      const services = {
        execute: () =>
          Effect.sync(() => {
            executions += 1;
            return appliedFor('ISSUE');
          }),
      };
      const context = { ...workerContext('ISSUE'), tenantId: 'aaaaaaaa-0000-4000-8000-000000000000' };
      const failure = yield* Effect.flip(
        handleExecuteStockIssue({ request: requestFor('ISSUE') }, context).pipe(
          Effect.provideService(PhysicalStockEffects, services),
          Effect.provideService(OutboxWorkerLegalEntityScopeFanout, { forEachScope: () => Effect.void }),
        ),
      );
      expect(failure.reason).toBe('WORKER_CONTEXT_MISMATCH');
      expect(executions).toBe(0);
    }),
  );
});
