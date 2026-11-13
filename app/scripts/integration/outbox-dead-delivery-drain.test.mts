import { createHash } from 'node:crypto';

import { applicationCompositionContentRevision } from '@app/core-runtime';
import { NodeChildProcessSpawner, NodeServices } from '@effect/platform-node';
import { eq, sql } from 'drizzle-orm';
import { Crypto, DateTime, Deferred, Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CoreDatabase, makeCoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import {
  applicationCompositionAuthority,
  applicationCompositionDurableWork,
  domainEvents,
  outboxDeliveries,
  outboxMessages,
  tenantModuleStates,
  tenants,
} from '../../packages/core-runtime/src/db/schema.ts';
import { ApplicationCompositionAuthorityError } from '../../packages/core-runtime/src/modules/application-composition-authority.ts';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import { OntosModuleDeploymentContractSchema } from '../../packages/core-runtime/src/modules/manifest.ts';
import {
  LegacyCompletionPublication,
  LegacyCompletionTransactionIdSchema,
} from '../../packages/core-runtime/src/modules/legacy-completion-publication.ts';
import { defineTenantModuleEntrypoint } from '../../packages/core-runtime/src/modules/module-entrypoint.ts';
import { resolveDeadOutboxDelivery } from '../../packages/core-runtime/src/outbox/dead-delivery-resolution.ts';
import {
  defineOutboxWorker,
  extractOutboxWorkerSubscriptions,
} from '../../packages/core-runtime/src/outbox/definition.ts';
import { makeOutboxRepository } from '../../packages/core-runtime/src/outbox/repository.ts';
import { defineOutboxWorkerEntry } from '../../packages/core-runtime/src/outbox/process.ts';
import { makeOutboxRuntime, OutboxRuntime } from '../../packages/core-runtime/src/outbox/runtime.ts';
import { makeIsolatedNativeDatabaseFixture } from '../../packages/core-runtime/src/testing/isolated-native-database.ts';
import {
  makeApplicationCompositionSnapshotFixture,
  makeModuleContractFixture,
} from '../../packages/core-runtime/src/testing/module-contract.ts';
import { runApplicationCompositionMigration } from '../application-composition-authority-publication.mts';

const services = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));
const producer = 'producer.fixture';
const consumer = 'consumer.fixture';
const topic = 'producer.fixture.accepted';
class DeadDeliveryFixtureFailure extends Schema.TaggedError<DeadDeliveryFixtureFailure>()(
  'DeadDeliveryFixtureFailure',
  { reason: Schema.String },
) {}
const worker = (suffix: string) =>
  defineOutboxWorker(
    {
      consumerModuleKey: consumer,
      entrypoint: defineTenantModuleEntrypoint({
        access: 'background',
        authorization: { kind: 'owner_local_background' },
        entrypointKey: `${consumer}.${suffix}`,
        moduleKey: consumer,
        role: 'worker',
      }),
      leaseDurationMs: 1000,
      payloadSchema: Schema.Struct({ id: Schema.String }),
      producerModuleKey: producer,
      retryPolicy: { initialBackoffMs: 0, maxAttempts: 1, maxBackoffMs: 0, multiplier: 1 },
      topic,
      workerKey: `${consumer}.${suffix}`,
    },
    () =>
      suffix === 'secondary'
        ? Effect.fail(new DeadDeliveryFixtureFailure({ reason: 'Owner temporarily refused' }))
        : Effect.void,
  );
const workers = [worker('primary'), worker('secondary')];
const FIXTURE_NAME = 'dead-delivery-drain';

const fixture = Effect.gen(function* deadDeliveryDrainFixture() {
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'stabilization-1258-privacy-drain',
  });
  yield* isolated.migrateCoreSchema();
  const base = yield* makeApplicationCompositionSnapshotFixture([FIXTURE_NAME], FIXTURE_NAME);
  const subscriptions = extractOutboxWorkerSubscriptions(workers);
  // This test owner declares only its two real workers, with their exact compiled subscriptions.
  const contract = yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)(
    makeModuleContractFixture({
      appId: FIXTURE_NAME,
      buildMarker: FIXTURE_NAME,
      moduleId: consumer,
      outboxSubscriptions: subscriptions,
    }),
  );
  const contractDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
    contract,
  );
  const sha256 = createHash('sha256').update(contractDocument, 'utf-8').digest('hex');
  const composition = {
    ...base.composition,
    modules: base.composition.modules.map((module) => ({
      ...module,
      contract: { ...module.contract, sha256 },
      contractDocument,
      moduleId: consumer,
      publicContract: { id: consumer, sha256, version: contract.schemaVersion },
    })),
  };
  const snapshot = yield* validateActiveApplicationCompositionSnapshot({
    ...base,
    composition: { ...composition, revision: yield* applicationCompositionContentRevision(composition) },
  });
  yield* isolated.publishInitialComposition(snapshot);
  const admin = yield* makeCoreDatabase(isolated.connections.admin);
  const { executor: runtime } = yield* makeCoreDatabase(isolated.connections.runtime);
  const [identity] = yield* admin.executor.execute<{
    readonly databaseName: string;
    readonly databaseOid: string;
    readonly databaseUser: string;
    readonly runtimeRoleOid: string;
    readonly systemIdentifier: string;
  }>(
    sql`select current_database() as "databaseName", (select oid::text from pg_database where datname=current_database()) as "databaseOid",
    current_user as "databaseUser", (select oid::text from pg_roles where rolname=${isolated.connections.runtime.user}) as "runtimeRoleOid",
    (pg_control_system()).system_identifier::text as "systemIdentifier"`,
    'objects',
  );
  if (identity === undefined) {
    return yield* Effect.die('Missing native test identity');
  }
  const runtimeTarget = {
    databaseName: isolated.connections.runtime.database,
    host: isolated.connections.runtime.host,
    port: isolated.connections.runtime.port,
    user: isolated.connections.runtime.user,
  };
  const binding = {
    ...identity,
    observedAt: yield* DateTime.now,
    runtimeTarget,
    runtimeUser: runtimeTarget.user,
    transactionId: yield* Schema.decodeUnknownEffect(LegacyCompletionTransactionIdSchema)('native-dead-delivery-owner'),
  };
  // The legacy owner gate is not under test here; one artificial owner attests absence.
  const owners = Layer.succeed(LegacyCompletionPublication, {
    owners: [
      {
        producerModuleKey: 'fixture.owner',
        topic: 'fixture.completed',
        withLease: (run) =>
          run({
            binding,
            verify: (observation) =>
              Effect.succeed({
                binding: observation.binding,
                evidenceReference: observation.evidenceReference,
                status: 'VERIFIED_ABSENT',
              }),
          }),
      },
    ],
    retainEvidence: () => Effect.void,
    runtimeTarget,
    runtimeUser: runtimeTarget.user,
  });
  const tenantId = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
  yield* runtime.insert(tenants).values({
    defaultLocale: 'en',
    name: 'Dead delivery drain fixture',
    slug: `${FIXTURE_NAME}-${tenantId}`,
    status: 'active',
    tenantId,
  });
  yield* runtime.insert(tenantModuleStates).values({ moduleKey: consumer, state: 'active', tenantId });
  const { revision } = snapshot.composition;
  const messageId = yield* runtime.transaction(
    Effect.fn(function* acceptTrackedWork(transaction) {
      const [event] = yield* transaction
        .insert(domainEvents)
        .values({
          eventType: topic,
          payloadJson: {},
          producerModuleKey: producer,
          subjectModuleKey: producer,
          subjectResourceId: tenantId,
          subjectResourceType: FIXTURE_NAME,
          tenantId,
        })
        .returning({ id: domainEvents.domainEventId });
      const [message] = yield* transaction
        .insert(outboxMessages)
        .values({
          completionConsumerModuleKey: consumer,
          completionOriginalRevision: revision,
          domainEventId: Option.getOrThrow(Option.fromNullishOr(event)).id,
          payloadJson: { id: tenantId },
          producerModuleKey: producer,
          tenantId,
          topic,
        })
        .returning({ id: outboxMessages.outboxMessageId });
      return Option.getOrThrow(Option.fromNullishOr(message)).id;
    }),
  );
  const repository = makeOutboxRepository(runtime, yield* Crypto.Crypto);
  const completed = yield* Deferred.make<true, DeadDeliveryFixtureFailure>();
  const entry = defineOutboxWorkerEntry({
    claimOwnerPrefix: FIXTURE_NAME,
    expectedDeployment: contract.deployment,
    layer: Layer.mergeAll(
      Layer.succeed(OutboxRuntime, makeOutboxRuntime(repository)),
      Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
    ),
    registrations: workers,
    subscriptions,
  });
  yield* repository.matchUnmatched(revision, yield* DateTime.nowAsDate);
  yield* Effect.raceFirst(
    entry.runLoop({
      config: { claimOwner: FIXTURE_NAME, maxDeliveries: 2, pollIntervalMs: 10 },
      health: {
        cycleFailed: Deferred.fail(
          completed,
          new DeadDeliveryFixtureFailure({ reason: 'The genuine test-owner worker cycle failed' }),
        ).pipe(Effect.asVoid),
        cycleSucceeded: Deferred.succeed(completed, true).pipe(Effect.asVoid),
      },
    }),
    Deferred.await(completed),
  );
  const deliveries = yield* runtime
    .select()
    .from(outboxDeliveries)
    .where(eq(outboxDeliveries.outboxMessageId, messageId));
  expect(deliveries).toHaveLength(2);
  expect(deliveries.find((delivery) => delivery.workerKey === `${consumer}.primary`)).toMatchObject({
    attemptsCount: 1,
    status: 'done',
  });
  const dead = deliveries.find((delivery) => delivery.workerKey === `${consumer}.secondary`);
  expect(dead).toMatchObject({ attemptsCount: 1, status: 'dead' });
  if (dead === undefined) {
    return yield* new DeadDeliveryFixtureFailure({ reason: 'The real secondary worker delivery is missing' });
  }
  return {
    admin,
    layer: Layer.merge(owners, Layer.succeed(CoreDatabase, admin)),
    messageId,
    runtime,
    tenantId,
    workerKey: dead.workerKey,
  };
});

it.layer(services, { excludeTestServices: true })('composition drain with a dead tracked delivery', (suite) => {
  suite.effect(
    'names the dead tracked delivery when the drain times out, then completes after an operator release',
    () =>
      Effect.gen(function* namesDeadDelivery() {
        const f = yield* fixture;
        // A short freshness lease bounds the drain wait at about ten seconds.
        yield* f.admin.executor
          .update(applicationCompositionAuthority)
          .set({ validUntil: sql`clock_timestamp() + interval '40 seconds'` });
        const failure = yield* runApplicationCompositionMigration(Effect.void, Effect.void).pipe(
          Effect.provide(f.layer),
          Effect.flip,
        );
        expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
        const reason = Schema.is(ApplicationCompositionAuthorityError)(failure) ? failure.reason : '';
        // The pre-flight now refuses before durable admission closes, so the old release never stops serving.
        expect(reason).toContain('drain was not started: durable admission is unchanged');
        expect(reason).toContain('Dead Outbox deliveries block the drain');
        expect(reason).toContain(
          `--tenant-id ${f.tenantId} --message-id ${f.messageId} --worker-key ${f.workerKey} (attempts 1)`,
        );
        // The refused drain changed nothing at all; the debt still waits for the operator.
        expect((yield* f.runtime.select().from(applicationCompositionAuthority))[0]).toMatchObject({
          durableWorkAdmission: 'open',
          phase: 'active',
        });
        expect(yield* f.runtime.select().from(applicationCompositionDurableWork)).toHaveLength(1);

        yield* f.admin.executor
          .update(applicationCompositionAuthority)
          .set({ validUntil: sql`clock_timestamp() + interval '1 hour'` });
        yield* f.admin.executor.transaction((transaction) =>
          resolveDeadOutboxDelivery(transaction, {
            action: 'release',
            operatorName: 'operator@example.test',
            outboxMessageId: f.messageId,
            reason: 'Buyer-facing Order reconciled by hand; the approval was revised after commit',
            tenantId: f.tenantId,
            workerKey: f.workerKey,
          }),
        );
        yield* runApplicationCompositionMigration(Effect.void, Effect.void).pipe(Effect.provide(f.layer));
        expect((yield* f.runtime.select().from(applicationCompositionAuthority))[0]?.phase).toBe('migrated');
      }),
  );
});
