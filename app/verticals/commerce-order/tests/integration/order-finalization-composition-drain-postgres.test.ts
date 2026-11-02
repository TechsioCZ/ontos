import {
  extractOutboxWorkerSubscriptions,
  findPostgresFailure,
  loadDatabaseConnectionPair,
  matchOutboxMessages,
  OutboxRepositoryLive,
  OutboxRuntimeLive,
  runOutboxCycle,
} from '@app/core-runtime';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { CoreDatabase, testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Effect, Exit, Layer, Option, Redacted, Result, Schema } from 'effect';
import type { Scope } from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import { Reactivity } from 'effect/reactivity';
import { expect, it, rs } from 'effect-rstest';

import { createPrepareOrderCommitmentCommerceOrderFinalizationWorkOutboxMessage } from '../../src/actions/prepare-order-commitment-commerce-order-finalization-work.outbox-message.ts';
import type { OrderCommitmentRejected } from '../../shared/domain/order-commitment.ts';
import { OrderFinalizationWorker } from '../../src/services/order-finalization-worker.service.ts';
import { outboxWorkers } from '../../src/workers/index.ts';
import {
  expiredOrderQuotation,
  failedOrderPreparationWork,
  orderPreparationPayload,
  orderPreparationWorkerLayer,
  pendingOrderPreparationWork,
  pricingTransportFailure,
  failedOrderProofWork,
  orderProofPayload,
  orderProofWorkerLayer,
  pendingOrderProofWork,
} from '../support/order-preparation-work.ts';
import type { OrderPreparationWorkObservation } from '../support/order-preparation-work.ts';
import { orderTenantId, runOrderRevalidation } from '../support/order-revalidation-work.ts';

const owners = rs.hoisted(() => ({
  complete: rs.fn<() => Effect.Effect<unknown>>(),
  issueGateway: rs.fn<(request: { readonly compositionRevision: string }) => Effect.Effect<unknown>>(),
  load: rs.fn<() => Effect.Effect<unknown>>(),
}));
// The genuine Order worker runs under Core delivery; only its owner HTTP transport is replaced.
rs.mock('@app/shared-contracts/server/gateway-context-api-key', () => ({
  issueApiKeyGatewayContext: owners.issueGateway,
}));
rs.mock('../../src/api/order-finalization-work-client.ts', () => ({
  executeOrderFinalizationWorkWithAuthorization: owners.load,
}));
rs.mock('../../src/api/complete-order-preparation-action-client.ts', () => ({
  executeCompleteOrderPreparationWithAuthorization: owners.complete,
}));
rs.mock('../../src/api/record-order-proof-set-action-client.ts', () => ({
  executeRecordOrderProofSetWithAuthorization: owners.complete,
}));

const subscriptions = extractOutboxWorkerSubscriptions(outboxWorkers);

class OrderDrainSetupFailed extends Schema.TaggedError<OrderDrainSetupFailed>()('OrderDrainSetupFailed', {
  reason: Schema.String,
}) {}

const fixture = Effect.fn('OrderFinalizationDrainTests.fixture')(function* fixture() {
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'stabilization-1257-approval-fresh-proof',
    sourceConnections: yield* loadDatabaseConnectionPair(),
  });
  yield* isolated.migrateCoreSchema();
  const snapshot = yield* makeApplicationCompositionSnapshotFixture([], 'order-finalization-drain');
  yield* isolated.publishInitialComposition(snapshot);
  const { revision } = snapshot.composition;
  const admin = yield* PgClient.makeClient({ url: Redacted.make(isolated.connections.admin.connectionString) });
  const runtime = yield* PgClient.makeClient({ url: Redacted.make(isolated.connections.runtime.connectionString) });
  // The release admits Order's actual validated worker subscription and nothing else.
  yield* admin.unsafe(
    "update core.application_composition_authority set subscriptions_json=$1::jsonb where authority_key='active'",
    [JSON.stringify(subscriptions)],
  );
  yield* runtime.unsafe(
    "insert into core.tenants(tenant_id,name,slug,status,default_locale) values($1,$2,$3,'active','en')",
    [orderTenantId, 'Order finalization drain fixture', `order-drain-${orderTenantId}`],
  );
  yield* runtime.unsafe(
    "insert into core.tenant_module_states(tenant_id,module_key,state) values($1,'commerce.order','active')",
    [orderTenantId],
  );
  // Persist exactly what the registered Order Action collected, as Core's Action repository does.
  // Only the original revision is this database's release; the in-memory harness admits a fixed one.
  const [committed] = yield* runOrderRevalidation('PROOFS_PENDING');
  const collected = committed?.evidence.outboxMessages[0];
  const event = collected === undefined ? undefined : committed?.evidence.domainEvents[collected.domainEventIndex];
  if (collected === undefined || event === undefined) {
    return yield* new OrderDrainSetupFailed({ reason: 'The Order Action collected no finalization work' });
  }
  // Preparation work is collected by the same enqueue helper; only its stage and intent differ.
  const proofWork = { collected, event };
  const preparationWork = {
    collected: {
      ...collected,
      message: createPrepareOrderCommitmentCommerceOrderFinalizationWorkOutboxMessage(orderPreparationPayload),
    },
    event: {
      ...event,
      payloadJson: orderPreparationPayload,
      subjectResourceId: orderPreparationPayload.intentRef.resourceId,
      subjectResourceType: orderPreparationPayload.intentRef.resourceType,
    },
  };
  const expiredProofWork = {
    collected: {
      ...collected,
      message: createPrepareOrderCommitmentCommerceOrderFinalizationWorkOutboxMessage(orderProofPayload),
    },
    event: {
      ...event,
      payloadJson: orderProofPayload,
      subjectResourceId: orderProofPayload.intentRef.resourceId,
      subjectResourceType: orderProofPayload.intentRef.resourceType,
    },
  };
  const accept = (work = proofWork) =>
    Effect.gen(function* acceptOrderWork() {
      const [inserted] = yield* runtime.unsafe<{ readonly id: string }>(
        'insert into core.domain_events(tenant_id,producer_module_key,event_type,subject_module_key,subject_resource_type,subject_resource_id,payload_json) values($1,$2,$3,$4,$5,$6,$7::jsonb) returning domain_event_id as id',
        [
          orderTenantId,
          work.event.producerModuleKey,
          work.event.eventType,
          work.event.subjectModuleKey,
          work.event.subjectResourceType,
          work.event.subjectResourceId,
          JSON.stringify(work.event.payloadJson),
        ],
      );
      const [message] = yield* runtime.unsafe<{ readonly id: string }>(
        'insert into core.outbox_messages(tenant_id,domain_event_id,producer_module_key,topic,payload_json,completion_consumer_module_key,completion_original_revision) values($1,$2,$3,$4,$5::jsonb,$6,$7) returning outbox_message_id as id',
        [
          orderTenantId,
          inserted?.id,
          work.collected.message.producerModuleKey,
          work.collected.message.topic,
          JSON.stringify(work.collected.message.payloadJson),
          work.collected.completion?.consumerModuleKey ?? null,
          work.collected.completion === undefined ? null : revision,
        ],
      );
      return Option.getOrThrow(Option.fromNullishOr(message)).id;
    }).pipe(runtime.withTransaction);
  const eventCount = admin
    .unsafe<{ readonly count: number }>('select count(*)::integer as count from core.domain_events')
    .pipe(Effect.map(([row]) => row?.count));
  const executor = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, runtime));
  const outbox = OutboxRuntimeLive.pipe(
    Layer.provide(OutboxRepositoryLive),
    Layer.provide(Layer.mergeAll(Layer.succeed(CoreDatabase, { executor }), NodeCrypto.layer)),
  );
  // The real Order worker registration is delivered by Core; only its owner business work is inert.
  const cycle = Effect.gen(function* deliverOrderWork() {
    yield* matchOutboxMessages({ compositionRevision: revision });
    return yield* runOutboxCycle({
      claimOwner: 'order-finalization-drain',
      compositionRevision: revision,
      registrations: outboxWorkers,
      subscriptions,
    });
  });
  const deliver = cycle.pipe(
    Effect.provideService(OrderFinalizationWorker, { execute: () => Effect.void }),
    Effect.provide(outbox),
  );
  const deliverPreparation = (prepare: () => Effect.Effect<typeof expiredOrderQuotation, OrderCommitmentRejected>) =>
    cycle.pipe(Effect.provide(orderPreparationWorkerLayer(prepare)), Effect.provide(outbox));
  const deliverExpiredProof = cycle.pipe(
    Effect.provide(
      orderProofWorkerLayer(
        () => Effect.succeed(Option.some(expiredOrderQuotation)),
        () => Effect.die('Expired proof work never revalidates its approval'),
      ),
    ),
    Effect.provide(outbox),
  );
  return {
    accept,
    composition: isolated.composition,
    deliver,
    deliverExpiredProof,
    deliverPreparation,
    eventCount,
    expiredProofWork,
    preparationWork,
    revision,
  };
});

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Reactivity.layer),
);
const nativeTest = (
  name: string,
  body: (
    test: Effect.Success<ReturnType<typeof fixture>>,
  ) => Effect.Effect<void, unknown, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>,
) => it.live(name, () => fixture().pipe(Effect.flatMap(body), Effect.scoped, Effect.provide(services)));

nativeTest('holds composition publication until tracked Order finalization work is delivered', (test) =>
  Effect.gen(function* trackedOrderWork() {
    const id = yield* test.accept();
    const workId = `outbox:${id}:commerce.order`;
    expect((yield* test.composition.observe()).pendingDurableWork).toEqual([
      { originalRevision: test.revision, ownerModuleKey: 'commerce.order', workId },
    ]);
    yield* test.composition.closeAdmission();
    // A buyer Action that would enqueue more work after admission closes rolls back whole.
    const refused = yield* test.accept().pipe(Effect.result);
    expect(Result.isFailure(refused)).toBe(true);
    if (Result.isFailure(refused)) {
      expect(Option.map(findPostgresFailure(refused.failure), ({ code }) => code)).toEqual(Option.some('55000'));
    }
    expect(yield* test.eventCount).toBe(1);
    expect(Exit.isFailure(yield* test.composition.drain().pipe(Effect.exit))).toBe(true);
    expect(yield* test.composition.observe()).toMatchObject({
      durableWorkAdmission: 'closed',
      pendingDurableWork: [{ workId }],
      phase: 'active',
    });
    expect(yield* test.deliver).toMatchObject({ claimed: 1, dead: 0, succeeded: 1 });
    expect((yield* test.composition.observe()).pendingDurableWork).toEqual([]);
    yield* test.composition.drain();
    expect((yield* test.composition.observe()).phase).toBe('draining');
  }),
);

const ownerTransport = (
  observedAfterCompletion: OrderPreparationWorkObservation | typeof failedOrderProofWork,
  pending: typeof pendingOrderPreparationWork | typeof pendingOrderProofWork = pendingOrderPreparationWork,
) => {
  owners.issueGateway.mockReset();
  // A fixed far-future assertion expiry (2099-01-01) keeps this live test independent of its clock.
  owners.issueGateway.mockImplementation(({ compositionRevision }) =>
    Effect.succeed({ apiBaseUrl: '/order-api', compositionRevision, expiresAt: 4_070_908_800, token: 'drain-token' }),
  );
  owners.load.mockReset();
  owners.load.mockReturnValueOnce(Effect.succeed(pending));
  owners.load.mockReturnValue(Effect.succeed(observedAfterCompletion));
  owners.complete.mockReset();
  owners.complete.mockReturnValue(
    Effect.succeed({ binding: null, intentRef: orderPreparationPayload.intentRef, status: 'FAILED' }),
  );
};

nativeTest('acknowledges an expired preparation delivery done so composition drain completes', (test) =>
  Effect.gen(function* expiredPreparationWork() {
    ownerTransport(failedOrderPreparationWork);
    const id = yield* test.accept(test.preparationWork);
    const workId = `outbox:${id}:commerce.order`;
    expect((yield* test.composition.observe()).pendingDurableWork).toEqual([
      { originalRevision: test.revision, ownerModuleKey: 'commerce.order', workId },
    ]);
    yield* test.composition.closeAdmission();
    expect(Exit.isFailure(yield* test.composition.drain().pipe(Effect.exit))).toBe(true);
    expect(yield* test.deliverPreparation(() => Effect.succeed(expiredOrderQuotation))).toMatchObject({
      claimed: 1,
      dead: 0,
      succeeded: 1,
    });
    expect(owners.complete).toHaveBeenCalledOnce();
    expect((yield* test.composition.observe()).pendingDurableWork).toEqual([]);
    yield* test.composition.drain();
    expect((yield* test.composition.observe()).phase).toBe('draining');
  }),
);

nativeTest('keeps preparation debt pending while Pricing cannot prove expiry', (test) =>
  Effect.gen(function* unprovenPreparationWork() {
    ownerTransport(pendingOrderPreparationWork);
    const id = yield* test.accept(test.preparationWork);
    yield* test.composition.closeAdmission();
    expect(yield* test.deliverPreparation(() => Effect.fail(pricingTransportFailure()))).toMatchObject({
      claimed: 1,
      dead: 0,
      succeeded: 0,
    });
    expect(owners.complete).not.toHaveBeenCalled();
    expect((yield* test.composition.observe()).pendingDurableWork).toEqual([
      { originalRevision: test.revision, ownerModuleKey: 'commerce.order', workId: `outbox:${id}:commerce.order` },
    ]);
    expect(Exit.isFailure(yield* test.composition.drain().pipe(Effect.exit))).toBe(true);
  }),
);

nativeTest('acknowledges an expired proof delivery without a Confirmation so composition drain completes', (test) =>
  Effect.gen(function* expiredProofWork() {
    ownerTransport(failedOrderProofWork, pendingOrderProofWork);
    const id = yield* test.accept(test.expiredProofWork);
    expect((yield* test.composition.observe()).pendingDurableWork).toEqual([
      { originalRevision: test.revision, ownerModuleKey: 'commerce.order', workId: `outbox:${id}:commerce.order` },
    ]);
    yield* test.composition.closeAdmission();
    expect(Exit.isFailure(yield* test.composition.drain().pipe(Effect.exit))).toBe(true);
    expect(yield* test.deliverExpiredProof).toMatchObject({ claimed: 1, dead: 0, succeeded: 1 });
    expect(owners.complete).toHaveBeenCalledOnce();
    expect((yield* test.composition.observe()).pendingDurableWork).toEqual([]);
    yield* test.composition.drain();
    expect((yield* test.composition.observe()).phase).toBe('draining');
  }),
);
