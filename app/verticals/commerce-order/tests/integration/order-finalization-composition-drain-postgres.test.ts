import { defineOutboxWorkerEntry } from '@app/core-runtime/outbox/worker';
import type { OutboxCycleError, OutboxCycleResult } from '@app/core-runtime';
import { HttpApi } from 'effect/http-api';
import { Hex } from 'effect/encoding';
import { commerceOrderManifest } from '../../vertical.manifest.ts';
import { commerceOrderRegistration } from '../../vertical.registration.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import {
  ActiveApplicationCompositionService,
  canonicalizeApplicationComposition,
  canonicalOntosPublicApiKey,
  extractVerticalRuntimeSafeDescriptors,
  OntosModuleDeploymentContractSchema,
  OutboxRuntime,
  validateActiveApplicationCompositionSnapshot,
  extractOutboxWorkerSubscriptions,
  findPostgresFailure,
  loadDatabaseConnectionPair,
  matchOutboxMessages,
  OutboxRepositoryLive,
  OutboxRuntimeLive,
} from '@app/core-runtime';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { CoreDatabase, testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import {
  Array as EffectArray,
  Context,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
} from 'effect';
import type { Scope } from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { createPrepareOrderCommitmentCommerceOrderFinalizationWorkOutboxMessage } from '../../src/actions/prepare-order-commitment-commerce-order-finalization-work.outbox-message.ts';
import type { OrderCommitmentRejected } from '../../shared/domain/order-commitment.ts';
import { OrderFinalizationWorker } from '../../src/services/order-finalization-worker.service.ts';
import { outboxWorkers } from '../../src/workers/index.ts';
import { gatewayQuotation, makeGatewayRevalidationState } from '../support/order-approval-gateway-state.ts';
import {
  completeOrderPreparationPath,
  failedOrderPreparationAnswer,
  failedPreparationProgressAnswer,
  makeOrderOwnerTransport,
  orderProofAnswers,
  orderWorkPath,
  ownerTransportLayer,
  pendingOrderPreparationAnswer,
  recordOrderProofSetPath,
} from '../support/order-owner-transport.ts';
import type { OwnerReply } from '../support/order-owner-transport.ts';
import {
  expiredOrderQuotation,
  orderPreparationPayload,
  orderPreparationWorkerLayer,
  orderProofPayload,
  orderProofWorkerLayer,
  pricingTransportFailure,
} from '../support/order-preparation-work.ts';
import { orderTenantId, runOrderRevalidation } from '../support/order-revalidation-work.ts';

const subscriptions = extractOutboxWorkerSubscriptions(outboxWorkers);
// The invocation that enqueued every delivered event; asynchronous work acts for it (DESIGN D7).
const invocationId = '80000000-0000-4000-8000-0000000000b1';
const claimOwner = 'order-finalization-drain';

class OrderDrainSetupFailed extends Schema.TaggedError<OrderDrainSetupFailed>()('OrderDrainSetupFailed', {
  reason: Schema.String,
}) {}

const metadataDigest = Effect.fn('OrderFinalizationDrainTests.metadataDigest')(function* metadataDigest(
  document: string,
) {
  const crypto = yield* Crypto.Crypto;
  return Hex.encode(new Uint8Array(yield* crypto.digest('SHA-256', new TextEncoder().encode(document))));
});
const compareOperationKeys = (left: string, right: string): -1 | 0 | 1 => {
  const compared = left.localeCompare(right);
  if (compared < 0) {
    return -1;
  }
  if (compared > 0) {
    return 1;
  }
  return 0;
};

/** Full controlled SOURCE owner metadata, independent of any packaged receiver claim. */
const makeOrderDrainSnapshot = Effect.fn('OrderFinalizationDrainTests.sourceSnapshot')(function* sourceSnapshot() {
  const snapshot = yield* makeApplicationCompositionSnapshotFixture(
    [ultramodernApiMarker.appId],
    ultramodernApiMarker.buildMarker,
  );
  const owner = yield* Effect.try({
    catch: () => new OrderDrainSetupFailed({ reason: 'The genuine Order owner registration is unavailable' }),
    try: () => extractVerticalRuntimeSafeDescriptors(commerceOrderRegistration),
  });
  const manifest = commerceOrderManifest;
  const events = yield* Effect.all(
    manifest.publicSurface.events.map((event) =>
      Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))(
        Schema.toJsonSchemaDocument(event.payloadSchema),
      ).pipe(
        Effect.flatMap((document) => metadataDigest(`${document}\n`)),
        Effect.map((payloadContract) => ({
          key: event.key,
          owningModuleId: event.owningModuleId,
          payloadContract,
          referencesResourceTypes: event.referencesResourceTypes,
          tense: event.tense,
          visibility: event.visibility,
        })),
      ),
    ),
  );
  const apis = yield* Effect.forEach(Object.entries(manifest.publicSurface.api), ([key, api]) => {
    if (!HttpApi.isHttpApi(api)) {
      return Effect.fail(new OrderDrainSetupFailed({ reason: 'The actual Order owner API is not an HttpApi' }));
    }
    return Effect.succeed({
      key: canonicalOntosPublicApiKey(owner.moduleId, key),
      operationKeys: EffectArray.sort(
        Object.values(api.groups).flatMap((group) =>
          Object.values(group.endpoints).map((endpoint) =>
            group.topLevel ? endpoint.identifier : `${group.identifier}.${endpoint.identifier}`,
          ),
        ),
        compareOperationKeys,
      ),
    });
  });
  const authoredManifest = {
    activation: manifest.activation,
    module: manifest.module,
    publicSurface: {
      actions: owner.actions,
      api: apis,
      businessPermissions: manifest.publicSurface.businessPermissions ?? [],
      components: Object.values(manifest.publicSurface.components),
      events,
      operationContracts: owner.operationContracts,
      reports: manifest.publicSurface.reports,
      resourceTypes: manifest.publicSurface.resourceTypes,
      search: manifest.publicSurface.search,
      shellContributions: owner.shellContributions,
    },
  };
  if (owner.requirements !== undefined) {
    Object.assign(authoredManifest, { requirements: owner.requirements });
  }
  const contract = yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema, {
    onExcessProperty: 'error',
  })({
    deployment: { appId: ultramodernApiMarker.appId, buildMarker: ultramodernApiMarker.buildMarker },
    manifest: authoredManifest,
    runtime: { outboxSubscriptions: owner.outboxSubscriptions },
    schemaVersion: '2',
  });
  const contractDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
    contract,
  );
  const sha256 = yield* metadataDigest(contractDocument);
  const composition = {
    ...snapshot.composition,
    modules: snapshot.composition.modules.map((module) => ({
      ...module,
      allowedContributions: Object.values(owner.shellContributions).flatMap((items) =>
        items.map(({ contributionKey }) => contributionKey),
      ),
      contract: { ...module.contract, sha256 },
      contractDocument,
      dependencies: EffectArray.sort(
        (owner.requirements?.intrinsic ?? []).map(({ moduleId }) => moduleId),
        compareOperationKeys,
      ),
      deployment: contract.deployment,
      moduleId: contract.manifest.module.id,
      publicContract: { id: contract.manifest.module.id, sha256, version: contract.schemaVersion },
      requiredCoreCapabilities: owner.requirements?.coreCapabilities ?? [],
    })),
    revision: '0'.repeat(64),
  };
  const revision = yield* metadataDigest(canonicalizeApplicationComposition(composition));
  return yield* validateActiveApplicationCompositionSnapshot({
    ...snapshot,
    composition: { ...composition, revision },
  });
});

/**
 * The authored SOURCE metadata and the work the Order Action collected. Both are pure products of
 * the genuine registration and manifest — per-event JSON-schema encoding, digests, canonicalisation
 * and the in-memory revalidation Action — so the suite derives them once and every case publishes
 * them into its own database. Each case closes admission and drains its composition, so the
 * composition itself stays private to a case.
 */
const openAuthoredWork = Effect.gen(function* openAuthoredOrderDrainWork() {
  const snapshot = yield* makeOrderDrainSnapshot();
  // Persist exactly what the registered Order Action collected, as Core's Action repository does.
  // Only the original revision is this database's release; the harness admits its actual owner composition.
  const {
    committed: [committed],
  } = yield* runOrderRevalidation('PROOFS_PENDING');
  const collected = committed?.evidence.outboxMessages[0];
  const event = collected === undefined ? undefined : committed?.evidence.domainEvents[collected.domainEventIndex];
  if (collected === undefined || event === undefined) {
    return yield* new OrderDrainSetupFailed({ reason: 'The Order Action collected no finalization work' });
  }
  return { collected, event, snapshot };
});

const OrderDrainAuthoredWork = Context.Service<Effect.Success<typeof openAuthoredWork>>(
  'OrderFinalizationDrain.authoredWork',
);

type OrderOwnerTransport = ReturnType<typeof makeOrderOwnerTransport>;
const overHttp = (transport: OrderOwnerTransport) =>
  ownerTransportLayer(async (input, init) => transport.answer(input, init));

/** Completes the observed delivery cycle with the exact exit the native cycle produced. */
const settle =
  (completed: Deferred.Deferred<OutboxCycleResult, OutboxCycleError>) =>
  (exit: Exit.Exit<OutboxCycleResult, OutboxCycleError>) =>
    Deferred.done(completed, exit);

const fixture = Effect.fn('OrderFinalizationDrainTests.fixture')(function* fixture() {
  const { collected, event, snapshot } = yield* OrderDrainAuthoredWork;
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'stabilization-1257-approval-fresh-proof',
    sourceConnections: yield* loadDatabaseConnectionPair(),
  });
  yield* isolated.migrateCoreSchema();
  yield* isolated.publishInitialComposition(snapshot);
  const { revision } = snapshot.composition;
  const admin = yield* PgClient.makeClient({ url: Redacted.make(isolated.connections.admin.connectionString) });
  const runtime = yield* PgClient.makeClient({ url: Redacted.make(isolated.connections.runtime.connectionString) });
  yield* runtime.unsafe(
    "insert into core.tenants(tenant_id,name,slug,status,default_locale) values($1,$2,$3,'active','en')",
    [orderTenantId, 'Order finalization drain fixture', `order-drain-${orderTenantId}`],
  );
  yield* runtime.unsafe(
    "insert into core.tenant_module_states(tenant_id,module_key,state) values($1,'commerce.order','active')",
    [orderTenantId],
  );
  yield* runtime.unsafe(
    "insert into core.action_invocations(action_invocation_id,tenant_id,action_key,status,request_hash) values($1,$2,'commerce.order.drain-fixture','succeeded',$3)",
    [invocationId, orderTenantId, 'd'.repeat(64)],
  );
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
        'insert into core.domain_events(tenant_id,producer_module_key,event_type,subject_module_key,subject_resource_type,subject_resource_id,payload_json,action_invocation_id) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8) returning domain_event_id as id',
        [
          orderTenantId,
          work.event.producerModuleKey,
          work.event.eventType,
          work.event.subjectModuleKey,
          work.event.subjectResourceType,
          work.event.subjectResourceId,
          JSON.stringify(work.event.payloadJson),
          invocationId,
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
  // The real Order worker registration is delivered by Core over its actual owner HTTP clients; only their
  // peers are fakes, provided where the delivered worker runs.
  const cycle = <Transport>(transport: Layer.Layer<Transport>) =>
    Effect.gen(function* deliverOrderWork() {
      yield* matchOutboxMessages({ compositionRevision: revision });
      const outboxRuntime = yield* OutboxRuntime;
      const worker = yield* OrderFinalizationWorker;
      const completed = yield* Deferred.make<OutboxCycleResult, OutboxCycleError>();
      const entry = defineOutboxWorkerEntry({
        claimOwnerPrefix: claimOwner,
        expectedDeployment: ultramodernApiMarker,
        layer: Layer.mergeAll(
          Layer.succeed(OrderFinalizationWorker, worker),
          Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
          Layer.succeed(OutboxRuntime, {
            ...outboxRuntime,
            // Preserve the exact native cycle; the public entry owns genuine receiving admission.
            runCycle: () =>
              outboxRuntime
                .runCycle({
                  claimOwner,
                  compositionRevision: revision,
                  registrations: outboxWorkers,
                  subscriptions,
                })
                .pipe(
                  Effect.provideService(OrderFinalizationWorker, worker),
                  Effect.provide(transport),
                  Effect.onExit(settle(completed)),
                ),
          }),
        ),
        ownerRegistration: commerceOrderRegistration,
        registrations: outboxWorkers,
        subscriptions,
      });
      return yield* Deferred.await(completed).pipe(
        Effect.raceFirst(
          entry
            .runLoop({ config: { claimOwner, maxDeliveries: 1, pollIntervalMs: 1000 } })
            .pipe(Effect.andThen(Effect.never)),
        ),
      );
    }).pipe(Effect.scoped);
  const deliver = cycle(Layer.empty).pipe(
    Effect.provideService(OrderFinalizationWorker, { execute: () => Effect.void }),
    Effect.provide(outbox),
  );
  const deliverPreparation = (
    prepare: () => Effect.Effect<typeof expiredOrderQuotation, OrderCommitmentRejected>,
    transport: OrderOwnerTransport,
  ) => cycle(overHttp(transport)).pipe(Effect.provide(orderPreparationWorkerLayer(prepare)), Effect.provide(outbox));
  const deliverExpiredProof = (transport: OrderOwnerTransport) =>
    cycle(overHttp(transport)).pipe(
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
    invocationId,
    preparationWork,
    revision,
  };
});

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Reactivity.layer),
);
const drainLayer = Layer.effect(OrderDrainAuthoredWork, openAuthoredWork).pipe(Layer.provideMerge(services));

/**
 * The Shell and Order owner peers of one delivery. The Shell binds its assertion to the release the
 * originating invocation was admitted under, with a fixed far-future expiry (2099-01-01) so this live
 * test stays independent of its clock; the Order read answers the pending work, then what it observes
 * after a completion attempt.
 */
const ownerTransport = (compositionRevision: string, pending: OwnerReply, observedAfterCompletion: OwnerReply) => {
  const transport = makeOrderOwnerTransport({ compositionRevision, expiresAt: 4_070_908_800, token: 'drain-token' });
  transport.reply(orderWorkPath, pending, observedAfterCompletion);
  transport.reply(completeOrderPreparationPath, failedPreparationProgressAnswer);
  return transport;
};

it.layer(drainLayer, { excludeTestServices: true, timeout: 120_000 })((suite) => {
  const nativeTest = (
    name: string,
    body: (
      test: Effect.Success<ReturnType<typeof fixture>>,
    ) => Effect.Effect<void, unknown, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>,
  ) => suite.effect(name, () => fixture().pipe(Effect.flatMap(body), Effect.scoped));

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

  nativeTest('acknowledges an expired preparation delivery done so composition drain completes', (test) =>
    Effect.gen(function* expiredPreparationWork() {
      const transport = ownerTransport(test.revision, pendingOrderPreparationAnswer, failedOrderPreparationAnswer);
      const id = yield* test.accept(test.preparationWork);
      const workId = `outbox:${id}:commerce.order`;
      expect((yield* test.composition.observe()).pendingDurableWork).toEqual([
        { originalRevision: test.revision, ownerModuleKey: 'commerce.order', workId },
      ]);
      yield* test.composition.closeAdmission();
      expect(Exit.isFailure(yield* test.composition.drain().pipe(Effect.exit))).toBe(true);
      expect(yield* test.deliverPreparation(() => Effect.succeed(expiredOrderQuotation), transport)).toMatchObject({
        claimed: 1,
        dead: 0,
        succeeded: 1,
      });
      expect(transport.sentTo(completeOrderPreparationPath)).toHaveLength(1);
      // The delegation acts for the invocation that enqueued the delivered work, not for the worker, under the
      // release that invocation was admitted in; the wire carries that release beside the subject.
      expect(yield* transport.delegations()).toContainEqual(
        expect.objectContaining({
          compositionRevision: test.revision,
          subject: { _tag: 'Originator', actionInvocationId: test.invocationId, tenantId: orderTenantId },
        }),
      );
      expect((yield* test.composition.observe()).pendingDurableWork).toEqual([]);
      yield* test.composition.drain();
      expect((yield* test.composition.observe()).phase).toBe('draining');
    }),
  );

  nativeTest('keeps preparation debt pending while Pricing cannot prove expiry', (test) =>
    Effect.gen(function* unprovenPreparationWork() {
      const transport = ownerTransport(test.revision, pendingOrderPreparationAnswer, pendingOrderPreparationAnswer);
      const id = yield* test.accept(test.preparationWork);
      yield* test.composition.closeAdmission();
      expect(yield* test.deliverPreparation(() => Effect.fail(pricingTransportFailure()), transport)).toMatchObject({
        claimed: 1,
        dead: 0,
        succeeded: 0,
      });
      expect(transport.sentTo(completeOrderPreparationPath)).toHaveLength(0);
      expect((yield* test.composition.observe()).pendingDurableWork).toEqual([
        { originalRevision: test.revision, ownerModuleKey: 'commerce.order', workId: `outbox:${id}:commerce.order` },
      ]);
      expect(Exit.isFailure(yield* test.composition.drain().pipe(Effect.exit))).toBe(true);
    }),
  );

  nativeTest('acknowledges an expired proof delivery without a Confirmation so composition drain completes', (test) =>
    Effect.gen(function* expiredProofWork() {
      const proof = orderProofAnswers(makeGatewayRevalidationState(gatewayQuotation));
      const transport = ownerTransport(test.revision, proof.pending, proof.failed);
      transport.reply(recordOrderProofSetPath, proof.failedProgress);
      const id = yield* test.accept(test.expiredProofWork);
      expect((yield* test.composition.observe()).pendingDurableWork).toEqual([
        { originalRevision: test.revision, ownerModuleKey: 'commerce.order', workId: `outbox:${id}:commerce.order` },
      ]);
      yield* test.composition.closeAdmission();
      expect(Exit.isFailure(yield* test.composition.drain().pipe(Effect.exit))).toBe(true);
      expect(yield* test.deliverExpiredProof(transport)).toMatchObject({ claimed: 1, dead: 0, succeeded: 1 });
      expect(transport.sentTo(recordOrderProofSetPath)).toHaveLength(1);
      expect((yield* test.composition.observe()).pendingDurableWork).toEqual([]);
      yield* test.composition.drain();
      expect((yield* test.composition.observe()).phase).toBe('draining');
    }),
  );
});
