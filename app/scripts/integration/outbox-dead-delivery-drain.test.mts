import { NodeChildProcessSpawner, NodeServices } from '@effect/platform-node';
import { sql } from 'drizzle-orm';
import { Crypto, DateTime, Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CoreDatabase, makeCoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import {
  applicationCompositionAuthority,
  applicationCompositionDurableWork,
  domainEvents,
  outboxMessages,
  tenantModuleStates,
  tenants,
} from '../../packages/core-runtime/src/db/schema.ts';
import { ApplicationCompositionAuthorityError } from '../../packages/core-runtime/src/modules/application-composition-authority.ts';
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
import { makeIsolatedNativeDatabaseFixture } from '../../packages/core-runtime/src/testing/isolated-native-database.ts';
import { makeApplicationCompositionSnapshotFixture } from '../../packages/core-runtime/src/testing/module-contract.ts';
import { runApplicationCompositionMigration } from '../application-composition-authority-publication.mts';

const services = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));
const producer = 'producer.fixture';
const consumer = 'consumer.fixture';
const topic = 'producer.fixture.accepted';
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
    () => Effect.void,
  );
const workers = [worker('primary'), worker('secondary')];
const FIXTURE_NAME = 'dead-delivery-drain';

const fixture = Effect.gen(function* deadDeliveryDrainFixture() {
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'stabilization-1258-privacy-drain',
  });
  yield* isolated.migrateCoreSchema();
  const snapshot = yield* makeApplicationCompositionSnapshotFixture([], FIXTURE_NAME);
  yield* isolated.publishInitialComposition(snapshot);
  const admin = yield* makeCoreDatabase(isolated.connections.admin);
  const { executor: runtime } = yield* makeCoreDatabase(isolated.connections.runtime);
  // Native infrastructure fixture: validated test workers stand in for an owner such as Order.
  yield* admin.executor
    .update(applicationCompositionAuthority)
    .set({ subscriptionsJson: extractOutboxWorkerSubscriptions(workers) });
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
  const claim = Effect.fn('DeadDeliveryDrain.claim')(function* claim(index: number) {
    const registration = Option.getOrThrow(Option.fromNullishOr(workers[index]));
    const now = DateTime.makeUnsafe(yield* DateTime.nowAsDate).pipe(DateTime.add({ seconds: 1 }), DateTime.toDateUtc);
    return Option.getOrThrow(yield* repository.claimNext([registration], FIXTURE_NAME, now, revision));
  });
  yield* repository.matchUnmatched(revision, yield* DateTime.nowAsDate);
  yield* repository.complete(yield* claim(0), yield* DateTime.nowAsDate);
  const dead = yield* claim(1);
  expect(yield* repository.fail(dead, 'Owner temporarily refused', yield* DateTime.nowAsDate)).toBe('dead');
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
        expect(reason).toContain('did not finish within its freshness lease');
        expect(reason).toContain('Dead tracked Outbox deliveries block the drain');
        expect(reason).toContain(
          `--tenant-id ${f.tenantId} --message-id ${f.messageId} --worker-key ${f.workerKey} (attempts 1)`,
        );
        // The failed drain changed nothing but durable admission; the debt still waits for the operator.
        expect((yield* f.runtime.select().from(applicationCompositionAuthority))[0]?.phase).toBe('active');
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
