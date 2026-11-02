import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { Clock, Crypto, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, pipe } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { makeCoreDatabase } from '../../src/db/client.ts';
import {
  applicationCompositionAuthority,
  domainEvents,
  outboxAttempts,
  outboxDeliveries,
  outboxMessages,
  tenantModuleStates,
  tenants,
  workerCheckpoints,
} from '../../src/db/schema.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../../src/db/types.ts';
import {
  ApplicationCompositionAuthorityError,
  lockApplicationCompositionAuthority,
  lockApplicationCompositionPublication,
} from '../../src/modules/application-composition-authority.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineOutboxWorker, extractOutboxWorkerSubscriptions } from '../../src/outbox/definition.ts';
import type { AnyOutboxWorkerRegistration, OutboxWorkerSubscription } from '../../src/outbox/definition.ts';
import type { OutboxClaim, OutboxRepositoryService } from '../../src/outbox/repository.ts';
import { OutboxClaimLostError } from '../../src/outbox/errors.ts';
import { makeOutboxRepository } from '../../src/outbox/repository.ts';
import { makeOutboxRuntime } from '../../src/outbox/runtime.ts';
import { makeIsolatedNativeDatabaseFixture } from '../../src/testing/isolated-native-database.ts';
import { makeApplicationCompositionSnapshotFixture } from '../../src/testing/module-contract.ts';
import { purgeFixtureRows } from '../support/fixture-cleanup.ts';

const MessageKeySchema = Schema.String.pipe(Schema.brand('MessageKey'));
const payloadSchema = Schema.Struct({ messageKey: MessageKeySchema });
const dateAt = (instant: string): Date => DateTime.toDateUtc(DateTime.makeUnsafe(instant));
const advanceDate = (date: Date, milliseconds: number): Date =>
  DateTime.makeUnsafe(date).pipe(DateTime.add({ milliseconds }), DateTime.toDateUtc);
const makeWorker = (
  workerKey: string,
  options: {
    readonly consumerModuleKey?: string;
    readonly maxAttempts?: number;
    readonly topic?: string;
  } = {},
) =>
  defineOutboxWorker(
    {
      consumerModuleKey: options.consumerModuleKey ?? 'consumer.fixture',
      entrypoint: defineTenantModuleEntrypoint({
        access: 'background',
        authorization: { kind: 'owner_local_background' },
        entrypointKey: workerKey,
        moduleKey: options.consumerModuleKey ?? 'consumer.fixture',
        role: 'worker',
      }),
      leaseDurationMs: 1000,
      payloadSchema,
      producerModuleKey: 'producer.fixture',
      retryPolicy: {
        initialBackoffMs: 1000,
        maxAttempts: options.maxAttempts ?? 3,
        maxBackoffMs: 4000,
        multiplier: 2,
      },
      topic: options.topic ?? 'producer.fixture.message-created',
      workerKey,
    },
    () => Effect.void,
  );
const subscriptionOf = (registration: AnyOutboxWorkerRegistration) =>
  Option.getOrThrow(Option.fromNullishOr(extractOutboxWorkerSubscriptions([registration])[0]));
const compositionRevision = 'a'.repeat(64);
const promotedCompositionRevision = 'b'.repeat(64);
const publishAuthority = Effect.fn(function* publishAuthority(
  database: CoreDatabaseExecutor,
  subscriptions: readonly OutboxWorkerSubscription[],
  options: {
    readonly phase?: 'active' | 'draining';
    readonly revision?: string;
    readonly validUntil?: Date;
  } = {},
) {
  const now = yield* DateTime.nowAsDate;
  const values = {
    authorityKey: 'active',
    phase: options.phase ?? 'active',
    revision: options.revision ?? compositionRevision,
    subscriptionsJson: subscriptions,
    updatedAt: now,
    validUntil: options.validUntil ?? advanceDate(now, 3_600_000),
  };
  yield* database.insert(applicationCompositionAuthority).values(values).onConflictDoUpdate({
    set: values,
    target: applicationCompositionAuthority.authorityKey,
  });
});
const insertTenant = (database: CoreDatabaseExecutor) =>
  Effect.gen(function* insertTenantEffect() {
    const tenantId = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
    yield* database.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Outbox Runtime Integration',
      slug: `outbox-runtime-${tenantId}`,
      status: 'active',
      tenantId,
    });
    return tenantId;
  });
const activateConsumer = (database: CoreDatabaseExecutor, tenantId: string, state = 'active') =>
  database.insert(tenantModuleStates).values({
    moduleKey: 'consumer.fixture',
    state,
    tenantId,
  });
const insertMessage = (
  database: CoreDatabaseExecutor,
  tenantId: string,
  topic = 'producer.fixture.message-created',
  invalidPayload = false,
) =>
  Effect.gen(function* insertMessageEffect() {
    const messageKey = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
    const event = Option.getOrThrow(
      Option.fromNullishOr(
        (yield* database
          .insert(domainEvents)
          .values({
            eventType: topic,
            payloadJson: { messageKey: invalidPayload ? 42 : messageKey },
            producerModuleKey: 'producer.fixture',
            subjectModuleKey: 'producer.fixture',
            subjectResourceId: messageKey,
            subjectResourceType: 'outbox-test',
            tenantId,
          })
          .returning({
            domainEventId: domainEvents.domainEventId,
            tenantSequenceNo: domainEvents.tenantSequenceNo,
          }))[0],
      ),
    );
    expect(event).toBeDefined();
    const message = Option.getOrThrow(
      Option.fromNullishOr(
        (yield* database
          .insert(outboxMessages)
          .values({
            domainEventId: event.domainEventId,
            payloadJson: { messageKey: invalidPayload ? 42 : messageKey },
            producerModuleKey: 'producer.fixture',
            tenantId,
            topic,
          })
          .returning({ messageId: outboxMessages.outboxMessageId }))[0],
      ),
    );
    expect(message).toBeDefined();
    return { ...event, ...message };
  });
const cleanupTenant = (database: CoreDatabaseExecutor, tenantId: string) =>
  Effect.gen(function* cleanupTenantEffect() {
    yield* database.delete(workerCheckpoints).where(eq(workerCheckpoints.tenantId, tenantId));
    const messageRows = yield* database
      .select({ messageId: outboxMessages.outboxMessageId })
      .from(outboxMessages)
      .where(eq(outboxMessages.tenantId, tenantId));
    const messageIds = messageRows.map(({ messageId }) => messageId);
    const deliveries = yield* database
      .select({ deliveryId: outboxDeliveries.outboxDeliveryId })
      .from(outboxDeliveries)
      .where(inArray(outboxDeliveries.outboxMessageId, messageIds));
    yield* database.delete(outboxAttempts).where(
      inArray(
        outboxAttempts.outboxDeliveryId,
        deliveries.map(({ deliveryId }) => deliveryId),
      ),
    );
    yield* database.delete(outboxDeliveries).where(inArray(outboxDeliveries.outboxMessageId, messageIds));
    yield* purgeFixtureRows([
      database.delete(outboxMessages).where(eq(outboxMessages.tenantId, tenantId)),
      database.delete(domainEvents).where(eq(domainEvents.tenantId, tenantId)),
      database.delete(tenantModuleStates).where(eq(tenantModuleStates.tenantId, tenantId)),
      database.delete(tenants).where(eq(tenants.tenantId, tenantId)),
    ]);
  });
/** Each test owns the database and tenant until its scoped finalizers complete. */
const tenantFixture = Effect.gen(function* tenantFixture() {
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'stabilization-1234-outbox-clock',
  });
  yield* isolated.migrateCoreSchema();
  yield* isolated.publishInitialComposition(
    yield* makeApplicationCompositionSnapshotFixture([], 'outbox-clock-fixture'),
  );
  const configuration = isolated.connections;
  const { executor: database } = yield* makeCoreDatabase(configuration.runtime);
  const { executor: adminDatabase } = yield* makeCoreDatabase(configuration.admin);
  yield* Effect.acquireRelease(Effect.void, () =>
    adminDatabase
      .delete(applicationCompositionAuthority)
      .where(eq(applicationCompositionAuthority.authorityKey, 'active'))
      .pipe(Effect.orDie),
  );
  const tenantId = yield* Effect.acquireRelease(insertTenant(database), (id) =>
    cleanupTenant(database, id).pipe(Effect.orDie),
  );
  return { adminDatabase, configuration, database, tenantId };
});

/** Seed and match one worker against a clock advanced beyond its pending rows. */
const matchedWorker = Effect.fn(function* matchedWorker(
  adminDatabase: CoreDatabaseExecutor,
  database: CoreDatabaseExecutor,
  tenantId: string,
  workerKey: string,
  options: Parameters<typeof makeWorker>[1] & {
    readonly invalidLastPayload?: boolean;
    readonly messages?: number;
  } = {},
) {
  yield* activateConsumer(database, tenantId);
  const messages = yield* Effect.forEach(Array.from({ length: options.messages ?? 1 }), (_value, index) =>
    insertMessage(
      database,
      tenantId,
      'producer.fixture.message-created',
      options.invalidLastPayload === true && index === (options.messages ?? 1) - 1,
    ),
  );
  const registration = makeWorker(workerKey, options);
  const repository = makeOutboxRepository(database, yield* Crypto.Crypto);
  const now = advanceDate(yield* DateTime.nowAsDate, 1000);
  yield* publishAuthority(adminDatabase, [subscriptionOf(registration)]);
  yield* repository.matchUnmatched(compositionRevision, now);
  return { messages, now, registration, repository };
});

const observeClaims = (
  repository: OutboxRepositoryService,
  entered: Deferred.Deferred<OutboxClaim>,
): OutboxRepositoryService => ({
  ...repository,
  claimNext: (...args) =>
    repository
      .claimNext(...args)
      .pipe(Effect.tap((option) => (Option.isSome(option) ? Deferred.succeed(entered, option.value) : Effect.void))),
});

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

it.layer(nativeServices, { excludeTestServices: true })('outbox runtime', (suite) => {
  suite.effect('matches zero, one, or multiple exact workers once without historical backfill', () =>
    Effect.gen(function* matchesZeroOneOrMultiple() {
      const { adminDatabase, database, tenantId } = yield* tenantFixture;
      yield* insertMessage(database, tenantId);
      yield* insertMessage(database, tenantId, 'producer.fixture.unmatched');
      const repository = makeOutboxRepository(database, yield* Crypto.Crypto);
      const workers = [makeWorker('consumer.fixture.alpha'), makeWorker('consumer.fixture.beta')];
      yield* publishAuthority(adminDatabase, workers.map(subscriptionOf));
      const firstMatch = yield* repository.matchUnmatched(compositionRevision, dateAt('2026-08-03T10:00:00Z'));
      expect(
        firstMatch.deliveriesCreated,
        `Initial matcher batch processed ${firstMatch.messagesMatched} unmatched messages`,
      ).toBe(2);
      expect(firstMatch.messagesMatched >= 2).toBe(true);
      const repeatMatch = yield* repository.matchUnmatched(compositionRevision, dateAt('2026-08-03T10:01:00Z'));
      expect(repeatMatch.deliveriesCreated).toBe(0);
      yield* publishAuthority(adminDatabase, [...workers, makeWorker('consumer.fixture.late')].map(subscriptionOf), {
        revision: promotedCompositionRevision,
      });
      const lateWorkerMatch = yield* repository.matchUnmatched(
        promotedCompositionRevision,
        dateAt('2026-08-03T10:02:00Z'),
      );
      expect(lateWorkerMatch.deliveriesCreated).toBe(0);
      const deliveries = yield* database
        .select()
        .from(outboxDeliveries)
        .innerJoin(outboxMessages, eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId))
        .where(eq(outboxMessages.tenantId, tenantId));
      expect(deliveries.length).toBe(2);
      expect(deliveries.map((row) => row.outbox_deliveries.workerKey).toSorted()).toEqual([
        'consumer.fixture.alpha',
        'consumer.fixture.beta',
      ]);
      const messages = yield* database
        .select({ matchedAt: outboxMessages.matchedAt })
        .from(outboxMessages)
        .where(eq(outboxMessages.tenantId, tenantId));
      expect(messages.every(({ matchedAt }) => matchedAt !== null)).toBe(true);
    }),
  );
  suite.effect('matches complete authority subscriptions while owner-local consumer processes are offline', () =>
    Effect.gen(function* matchesTheCompleteSubscriptionCatalog() {
      const { adminDatabase, database, tenantId } = yield* tenantFixture;
      yield* activateConsumer(database, tenantId);
      yield* database.insert(tenantModuleStates).values({
        moduleKey: 'reporting.fixture',
        state: 'active',
        tenantId,
      });
      const { messageId } = yield* insertMessage(database, tenantId);
      const consumerWorker = makeWorker('consumer.fixture.local');
      const reportingWorker = makeWorker('reporting.fixture.local', {
        consumerModuleKey: 'reporting.fixture',
      });
      const repository = makeOutboxRepository(database, yield* Crypto.Crypto);
      const subscriptions = [consumerWorker, reportingWorker].map(subscriptionOf);
      yield* publishAuthority(adminDatabase, subscriptions);
      const matched = yield* repository.matchUnmatched(compositionRevision, dateAt('2026-08-03T10:00:00Z'));
      expect(
        matched.deliveriesCreated,
        `Catalog matcher batch processed ${matched.messagesMatched} unmatched messages`,
      ).toBe(2);
      const pendingDeliveries = yield* database
        .select({ availableAt: outboxDeliveries.availableAt })
        .from(outboxDeliveries)
        .where(and(eq(outboxDeliveries.outboxMessageId, messageId), eq(outboxDeliveries.status, 'pending')))
        .orderBy(asc(outboxDeliveries.availableAt));
      const { availableAt } = Option.getOrThrow(Option.fromNullishOr(pendingDeliveries.at(-1)));
      // PostgreSQL retains sub-millisecond precision beyond the decoded JavaScript Date.
      const claimAt = advanceDate(availableAt, 1);
      const consumerClaim = Option.getOrNull(
        yield* repository.claimNext([consumerWorker], 'consumer-process', claimAt, compositionRevision),
      );
      const reportingClaim = Option.getOrNull(
        yield* repository.claimNext([reportingWorker], 'reporting-process', claimAt, compositionRevision),
      );
      expect(consumerClaim?.workerKey).toBe('consumer.fixture.local');
      expect(reportingClaim?.workerKey).toBe('reporting.fixture.local');
    }),
  );
  suite.effect('keeps messages unmatched while authority is missing, expired, or superseded and resumes safely', () =>
    Effect.gen(function* preservesMessagesWithoutCurrentAuthority() {
      const { adminDatabase, database, tenantId } = yield* tenantFixture;
      const { messageId } = yield* insertMessage(database, tenantId);
      const workers = [makeWorker('consumer.fixture.authority'), makeWorker('consumer.fixture.offline')];
      const subscriptions = workers.map(subscriptionOf);
      const repository = makeOutboxRepository(database, yield* Crypto.Crypto);
      yield* adminDatabase
        .delete(applicationCompositionAuthority)
        .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
      const expiredAt = advanceDate(yield* DateTime.nowAsDate, -60_000);
      for (const unavailable of ['missing', 'expired', 'superseded'] as const) {
        if (unavailable === 'expired') {
          yield* publishAuthority(adminDatabase, subscriptions, { validUntil: expiredAt });
        } else if (unavailable === 'superseded') {
          yield* publishAuthority(adminDatabase, subscriptions, { revision: promotedCompositionRevision });
        }
        // The caller's old operation clock must not make an expired authority valid.
        const failure = yield* Effect.flip(
          repository.matchUnmatched(compositionRevision, dateAt('2000-01-01T00:00:00Z')),
        );
        expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
        const [message] = yield* database
          .select({ matchedAt: outboxMessages.matchedAt })
          .from(outboxMessages)
          .where(eq(outboxMessages.outboxMessageId, messageId));
        expect(message?.matchedAt).toBe(null);
        const deliveries = yield* database
          .select()
          .from(outboxDeliveries)
          .where(eq(outboxDeliveries.outboxMessageId, messageId));
        expect(deliveries).toEqual([]);
      }
      const matched = yield* repository.matchUnmatched(promotedCompositionRevision, yield* DateTime.nowAsDate);
      expect(matched.deliveriesCreated).toBe(2);
      const deliveries = yield* database
        .select({ workerKey: outboxDeliveries.workerKey })
        .from(outboxDeliveries)
        .where(eq(outboxDeliveries.outboxMessageId, messageId));
      expect(deliveries.map(({ workerKey }) => workerKey).toSorted()).toEqual([
        'consumer.fixture.authority',
        'consumer.fixture.offline',
      ]);
      expect(
        (yield* repository.matchUnmatched(promotedCompositionRevision, yield* DateTime.nowAsDate)).deliveriesCreated,
      ).toBe(0);
    }),
  );
  suite.effect('matches a complete empty authority once without backfilling a later installed consumer', () =>
    Effect.gen(function* preservesEmptyAuthorityMatching() {
      const { adminDatabase, database, tenantId } = yield* tenantFixture;
      const { messageId } = yield* insertMessage(database, tenantId);
      const repository = makeOutboxRepository(database, yield* Crypto.Crypto);
      yield* publishAuthority(adminDatabase, []);
      const matched = yield* repository.matchUnmatched(compositionRevision, yield* DateTime.nowAsDate);
      expect(matched.messagesMatched).toBe(1);
      expect(matched.deliveriesCreated).toBe(0);
      const [message] = yield* database
        .select({ matchedAt: outboxMessages.matchedAt })
        .from(outboxMessages)
        .where(eq(outboxMessages.outboxMessageId, messageId));
      expect(Option.isSome(Option.fromNullishOr(message?.matchedAt))).toBe(true);
      yield* publishAuthority(adminDatabase, [subscriptionOf(makeWorker('consumer.fixture.late'))], {
        revision: promotedCompositionRevision,
      });
      const promotedMatch = yield* repository.matchUnmatched(promotedCompositionRevision, yield* DateTime.nowAsDate);
      expect(promotedMatch.messagesMatched).toBe(0);
      const deliveries = yield* database
        .select()
        .from(outboxDeliveries)
        .where(eq(outboxDeliveries.outboxMessageId, messageId));
      expect(deliveries).toEqual([]);
    }),
  );
  suite.effect('materializes every old subscription during draining before owner-local delivery execution', () =>
    Effect.gen(function* preservesDrainingBacklog() {
      const { adminDatabase, database, tenantId } = yield* tenantFixture;
      yield* activateConsumer(database, tenantId);
      const { messageId } = yield* insertMessage(database, tenantId);
      const workers = [
        makeWorker('consumer.fixture.draining'),
        makeWorker('reporting.fixture.draining', { consumerModuleKey: 'reporting.fixture' }),
      ];
      const repository = makeOutboxRepository(database, yield* Crypto.Crypto);
      yield* publishAuthority(adminDatabase, workers.map(subscriptionOf), { phase: 'draining' });
      const matched = yield* repository.matchUnmatched(compositionRevision, yield* DateTime.nowAsDate);
      expect(matched.deliveriesCreated).toBe(2);
      const deliveries = yield* database
        .select({
          availableAt: outboxDeliveries.availableAt,
          consumerModuleKey: outboxDeliveries.consumerModuleKey,
          status: outboxDeliveries.status,
        })
        .from(outboxDeliveries)
        .where(eq(outboxDeliveries.outboxMessageId, messageId))
        .orderBy(asc(outboxDeliveries.availableAt));
      expect(deliveries.map(({ consumerModuleKey }) => consumerModuleKey).toSorted()).toEqual([
        'consumer.fixture',
        'reporting.fixture',
      ]);
      expect(deliveries.every(({ status }) => status === 'pending')).toBe(true);
      expect((yield* repository.matchUnmatched(compositionRevision, yield* DateTime.nowAsDate)).deliveriesCreated).toBe(
        0,
      );
      const { availableAt } = Option.getOrThrow(Option.fromNullishOr(deliveries.at(-1)));
      const claimAt = advanceDate(availableAt, 1);
      expect(
        Option.isSome(
          yield* repository.claimNext(
            [Option.getOrThrow(Option.fromNullishOr(workers[0]))],
            'draining-consumer',
            claimAt,
            compositionRevision,
          ),
        ),
      ).toBe(true);
    }),
  );
  suite.effect('prevents the application runtime from publishing or changing composition authority', () =>
    Effect.gen(function* enforcesAuthorityPublicationOwnership() {
      const { adminDatabase, database } = yield* tenantFixture;
      yield* publishAuthority(adminDatabase, []);
      const attemptedPublication = yield* database
        .insert(applicationCompositionAuthority)
        .values({
          authorityKey: 'active',
          phase: 'active',
          revision: promotedCompositionRevision,
          subscriptionsJson: [],
          validUntil: advanceDate(yield* DateTime.nowAsDate, 3_600_000),
        })
        .onConflictDoUpdate({
          set: { revision: promotedCompositionRevision },
          target: applicationCompositionAuthority.authorityKey,
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(attemptedPublication)).toBe(true);
      const [authority] = yield* database
        .select({ revision: applicationCompositionAuthority.revision })
        .from(applicationCompositionAuthority)
        .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
      expect(authority?.revision).toBe(compositionRevision);
    }),
  );
  suite.effect('serializes matching behind promotion and rejects the superseded matcher before message mutation', () =>
    Effect.gen(function* serializesMatchingWithPromotion() {
      const { adminDatabase, database, tenantId } = yield* tenantFixture;
      yield* activateConsumer(database, tenantId);
      const { messageId } = yield* insertMessage(database, tenantId);
      const registration = makeWorker('consumer.fixture.serialized');
      yield* publishAuthority(adminDatabase, [subscriptionOf(registration)]);
      const repository = makeOutboxRepository(database, yield* Crypto.Crypto);
      const startMatcher = yield* Deferred.make<null>();
      // Fork before entering the publisher transaction so the matcher owns a separate connection.
      const matcher = yield* Deferred.await(startMatcher).pipe(
        Effect.flatMap(() => repository.matchUnmatched(compositionRevision, dateAt('2026-08-03T10:00:00Z'))),
        Effect.forkScoped,
      );
      yield* adminDatabase.transaction(
        Effect.fn(function* holdPromotionFence(transaction: CoreTransaction) {
          yield* transaction.execute(
            sql`select pg_advisory_xact_lock(hashtextextended('ontos.application-composition-authority', 0))`,
            'objects',
          );
          const [publisher] = yield* transaction.execute<{ readonly pid: number }>(
            sql`select pg_backend_pid() as pid`,
            'objects',
          );
          const publisherPid = Option.getOrThrow(Option.fromNullishOr(publisher)).pid;
          yield* Deferred.succeed(startMatcher, null);
          // Observe the native blocked lock, rather than guessing ordering from elapsed time.
          let blocked = false;
          for (let observation = 0; observation < 1000 && !blocked; observation += 1) {
            const [status] = yield* transaction.execute<{ readonly blocked: boolean }>(
              sql`select exists (
                select 1 from pg_locks
                where locktype = 'advisory' and not granted
                  and ${publisherPid} = any(pg_blocking_pids(pid))
              ) as blocked`,
              'objects',
            );
            blocked = status?.blocked === true;
          }
          expect(blocked).toBe(true);
          yield* transaction
            .update(applicationCompositionAuthority)
            .set({ revision: promotedCompositionRevision })
            .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
        }),
      );
      expect(Schema.is(ApplicationCompositionAuthorityError)(yield* Effect.flip(Fiber.join(matcher)))).toBe(true);
      const [message] = yield* database
        .select({ matchedAt: outboxMessages.matchedAt })
        .from(outboxMessages)
        .where(eq(outboxMessages.outboxMessageId, messageId));
      expect(message?.matchedAt).toBe(null);
      const deliveries = yield* database
        .select()
        .from(outboxDeliveries)
        .where(eq(outboxDeliveries.outboxMessageId, messageId));
      expect(deliveries).toEqual([]);
      expect(
        (yield* repository.matchUnmatched(promotedCompositionRevision, yield* DateTime.nowAsDate)).deliveriesCreated,
      ).toBe(1);
      const [pendingDelivery] = yield* database
        .select({ availableAt: outboxDeliveries.availableAt })
        .from(outboxDeliveries)
        .where(
          and(
            eq(outboxDeliveries.outboxMessageId, messageId),
            eq(outboxDeliveries.workerKey, registration.descriptor.workerKey),
          ),
        );
      const { availableAt } = Option.getOrThrow(Option.fromNullishOr(pendingDelivery));
      // PostgreSQL retains sub-millisecond precision beyond the decoded JavaScript Date.
      const dueAt = advanceDate(availableAt, 1);
      expect(
        Option.isNone(
          yield* repository.claimNext(
            [registration],
            'not-yet-due-worker',
            advanceDate(availableAt, -1),
            promotedCompositionRevision,
          ),
        ),
      ).toBe(true);
      expect(
        Schema.is(ApplicationCompositionAuthorityError)(
          yield* Effect.flip(repository.claimNext([registration], 'stale-worker', dueAt, compositionRevision)),
        ),
      ).toBe(true);
      expect(
        Option.isSome(
          yield* repository.claimNext([registration], 'current-worker', dueAt, promotedCompositionRevision),
        ),
      ).toBe(true);
    }),
  );
  suite.effect('rejects snapshot isolation for matching and publication before changing durable state', () =>
    Effect.gen(function* rejectsSnapshotIsolation() {
      const { adminDatabase, database, tenantId } = yield* tenantFixture;
      const { messageId } = yield* insertMessage(database, tenantId);
      const registration = makeWorker('consumer.fixture.isolation-proof');
      yield* publishAuthority(adminDatabase, [subscriptionOf(registration)]);
      for (const isolation of [
        sql`set transaction isolation level repeatable read`,
        sql`set transaction isolation level serializable`,
      ]) {
        const matchingFailure = yield* Effect.flip(
          database.transaction(
            Effect.fn(function* matchWithSnapshotIsolation(transaction: CoreTransaction) {
              yield* transaction.execute(isolation, 'objects');
              return yield* lockApplicationCompositionAuthority(transaction, compositionRevision, 'match');
            }),
          ),
        );
        expect(Schema.is(ApplicationCompositionAuthorityError)(matchingFailure)).toBe(true);
        const publicationFailure = yield* Effect.flip(
          adminDatabase.transaction(
            Effect.fn(function* publishWithSnapshotIsolation(transaction: CoreTransaction) {
              yield* transaction.execute(isolation, 'objects');
              return yield* lockApplicationCompositionPublication(transaction);
            }),
          ),
        );
        expect(Schema.is(ApplicationCompositionAuthorityError)(publicationFailure)).toBe(true);
      }
      const [message] = yield* database
        .select({ matchedAt: outboxMessages.matchedAt })
        .from(outboxMessages)
        .where(eq(outboxMessages.outboxMessageId, messageId));
      expect(message?.matchedAt).toBe(null);
      const deliveries = yield* database
        .select()
        .from(outboxDeliveries)
        .where(eq(outboxDeliveries.outboxMessageId, messageId));
      expect(deliveries).toEqual([]);
      const [authority] = yield* database
        .select({ revision: applicationCompositionAuthority.revision })
        .from(applicationCompositionAuthority)
        .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
      expect(authority?.revision).toBe(compositionRevision);
      expect(
        (yield* makeOutboxRepository(database, yield* Crypto.Crypto).matchUnmatched(
          compositionRevision,
          yield* DateTime.nowAsDate,
        )).deliveriesCreated,
      ).toBe(1);
    }),
  );
  suite.effect('gates claims on every non-active consumer state and permits one concurrent live claim', () =>
    Effect.gen(function* gatesClaimsOnEveryNonactive() {
      const { adminDatabase, database, tenantId } = yield* tenantFixture;
      yield* insertMessage(database, tenantId);
      const registration = makeWorker('consumer.fixture.module-gated');
      const repository = makeOutboxRepository(database, yield* Crypto.Crypto);
      yield* publishAuthority(adminDatabase, [subscriptionOf(registration)]);
      const matched = yield* repository.matchUnmatched(compositionRevision, dateAt('2026-08-03T11:00:00Z'));
      expect(
        matched.deliveriesCreated,
        `Module-gated matcher batch processed ${matched.messagesMatched} unmatched messages`,
      ).toBe(1);
      const claimAt = advanceDate(yield* DateTime.nowAsDate, 1000);
      expect(
        Option.getOrNull(yield* repository.claimNext([registration], 'runtime-a', claimAt, compositionRevision)),
      ).toBe(null);
      yield* activateConsumer(database, tenantId, 'inactive');
      yield* pipe(
        ['inactive', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived'] as const,
        Effect.forEach((state) =>
          Effect.gen(function* checksInactiveState() {
            yield* database
              .update(tenantModuleStates)
              .set({ state })
              .where(
                and(eq(tenantModuleStates.tenantId, tenantId), eq(tenantModuleStates.moduleKey, 'consumer.fixture')),
              );
            expect(
              Option.getOrNull(
                yield* repository.claimNext([registration], `runtime-${state}`, claimAt, compositionRevision),
              ),
            ).toBe(null);
          }),
        ),
      );
      yield* database
        .update(tenantModuleStates)
        .set({ state: 'active' })
        .where(and(eq(tenantModuleStates.tenantId, tenantId), eq(tenantModuleStates.moduleKey, 'consumer.fixture')));
      const claimOptions = yield* Effect.all(
        [
          repository.claimNext([registration], 'runtime-a', claimAt, compositionRevision),
          repository.claimNext([registration], 'runtime-b', claimAt, compositionRevision),
        ],
        { concurrency: 'unbounded' },
      );
      const claims = claimOptions.map(Option.getOrNull);
      expect(claims.filter((candidate) => candidate !== null).length).toBe(1);
      const claimed = Option.getOrThrow(Option.fromNullishOr(claims.find((candidate) => candidate !== null)));
      expect(claimed).toBeDefined();
      const attempt = Option.getOrThrow(
        Option.fromNullishOr(
          (yield* database
            .select()
            .from(outboxAttempts)
            .where(eq(outboxAttempts.outboxDeliveryId, claimed.deliveryId)))[0],
        ),
      );
      expect(attempt).toBeDefined();
      expect(attempt.finishedAt).toBe(null);
    }),
  );
  suite.effect('reclaims only expired leases, abandons the old attempt, and rejects stale finalization', () =>
    Effect.gen(function* reclaimsOnlyExpiredLeasesAbandons() {
      const { adminDatabase, database, tenantId } = yield* tenantFixture;
      const {
        now: started,
        registration,
        repository,
      } = yield* matchedWorker(adminDatabase, database, tenantId, 'consumer.fixture.lease-proof');
      const first = Option.getOrThrow(
        yield* repository.claimNext([registration], 'runtime-a', started, compositionRevision),
      );
      expect(first).toBeDefined();
      expect(
        Option.getOrNull(
          yield* repository.claimNext([registration], 'runtime-b', advanceDate(started, 999), compositionRevision),
        ),
      ).toBe(null);
      const second = Option.getOrThrow(
        yield* repository.claimNext([registration], 'runtime-b', advanceDate(started, 1001), compositionRevision),
      );
      expect(second).toBeDefined();
      expect(second.claimId).not.toBe(first.claimId);
      expect(
        Schema.is(OutboxClaimLostError)(yield* Effect.flip(repository.complete(first, advanceDate(started, 1002)))),
      ).toBe(true);
      const attempts = yield* database
        .select()
        .from(outboxAttempts)
        .where(eq(outboxAttempts.outboxDeliveryId, first.deliveryId))
        .orderBy(asc(outboxAttempts.startedAt));
      expect(attempts.length).toBe(2);
      expect(attempts[0]?.errorMessage).toBe('Outbox Worker lease expired before completion');
      expect(Option.isSome(Option.fromNullishOr(attempts[0]?.finishedAt))).toBe(true);
      expect(attempts[1]?.finishedAt).toBe(null);
    }),
  );
  suite.effect('finishes an abandoned final attempt before dead-lettering its expired delivery', () =>
    Effect.gen(function* finishesAnAbandonedFinalAttempt() {
      const { adminDatabase, database, tenantId } = yield* tenantFixture;
      const {
        now: started,
        registration,
        repository,
      } = yield* matchedWorker(adminDatabase, database, tenantId, 'consumer.fixture.final-lease', {
        maxAttempts: 1,
      });
      const claim = Option.getOrThrow(
        yield* repository.claimNext([registration], 'runtime-a', started, compositionRevision),
      );
      expect(claim).toBeDefined();
      expect(
        Option.getOrNull(
          yield* repository.claimNext([registration], 'runtime-b', advanceDate(started, 1001), compositionRevision),
        ),
      ).toBe(null);
      const [delivery] = yield* database
        .select()
        .from(outboxDeliveries)
        .where(eq(outboxDeliveries.outboxDeliveryId, claim.deliveryId));
      const attempt = Option.getOrThrow(
        Option.fromNullishOr(
          (yield* database
            .select()
            .from(outboxAttempts)
            .where(eq(outboxAttempts.outboxDeliveryId, claim.deliveryId)))[0],
        ),
      );
      expect(delivery?.status).toBe('dead');
      expect(attempt?.errorMessage).toBe('Outbox Worker lease expired before completion');
      expect(Option.isSome(Option.fromNullishOr(attempt?.finishedAt))).toBe(true);
    }),
  );
  suite.effect('finalizes success atomically and advances only through contiguous done deliveries', () =>
    Effect.gen(function* finalizesSuccessAtomicallyAndAdvances() {
      const { adminDatabase, database, tenantId } = yield* tenantFixture;
      const { messages, now, registration, repository } = yield* matchedWorker(
        adminDatabase,
        database,
        tenantId,
        'consumer.fixture.checkpoint-proof',
        { messages: 2 },
      );
      const firstMessage = Option.getOrThrow(Option.fromNullishOr(messages[0]));
      const secondMessage = Option.getOrThrow(Option.fromNullishOr(messages[1]));
      const first = Option.getOrThrow(
        yield* repository.claimNext([registration], 'runtime-a', now, compositionRevision),
      );
      const second = Option.getOrThrow(
        yield* repository.claimNext([registration], 'runtime-b', now, compositionRevision),
      );
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      yield* repository.complete(second, advanceDate(now, 1));
      expect(yield* database.select().from(workerCheckpoints).where(eq(workerCheckpoints.tenantId, tenantId))).toEqual(
        [],
      );
      yield* repository.complete(first, advanceDate(now, 2));
      const checkpoint = Option.getOrThrow(
        Option.fromNullishOr(
          (yield* database.select().from(workerCheckpoints).where(eq(workerCheckpoints.tenantId, tenantId)))[0],
        ),
      );
      expect(checkpoint).toBeDefined();
      expect(checkpoint.consumerName).toBe(registration.descriptor.workerKey);
      expect(checkpoint.streamKey).toBe('producer.fixture:producer.fixture.message-created');
      expect(checkpoint.lastTenantSequenceNo).toBe(secondMessage.tenantSequenceNo);
      expect(
        Option.getOrThrow(Option.fromNullishOr(checkpoint.lastTenantSequenceNo)) > firstMessage.tenantSequenceNo,
      ).toBe(true);
      const deliveries = yield* database
        .select()
        .from(outboxDeliveries)
        .innerJoin(outboxMessages, eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId))
        .where(eq(outboxMessages.tenantId, tenantId));
      expect(deliveries.every((row) => row.outbox_deliveries.status === 'done')).toBe(true);
      expect(deliveries.every((row) => row.outbox_deliveries.claimedBy === null)).toBe(true);
    }),
  );
  suite.effect(
    'schedules bounded retry, dead-letters exhaustion, stores safe errors, and never checkpoints failure',
    () =>
      Effect.gen(function* schedulesBoundedRetryDeadlettersExhaustion() {
        const { adminDatabase, database, tenantId } = yield* tenantFixture;
        const { now, registration, repository } = yield* matchedWorker(
          adminDatabase,
          database,
          tenantId,
          'consumer.fixture.retry-proof',
          {
            maxAttempts: 2,
          },
        );
        const first = Option.getOrThrow(
          yield* repository.claimNext([registration], 'runtime-a', now, compositionRevision),
        );
        expect(first).toBeDefined();
        expect(yield* repository.fail(first, ' safe\nretry\tmessage ', advanceDate(now, 1))).toBe('pending');
        expect(
          Option.getOrNull(
            yield* repository.claimNext([registration], 'runtime-b', advanceDate(now, 999), compositionRevision),
          ),
        ).toBe(null);
        const second = Option.getOrThrow(
          yield* repository.claimNext([registration], 'runtime-b', advanceDate(now, 1001), compositionRevision),
        );
        expect(second).toBeDefined();
        expect(yield* repository.fail(second, 'terminal safe failure', advanceDate(now, 1002))).toBe('dead');
        const [delivery] = yield* database
          .select()
          .from(outboxDeliveries)
          .where(eq(outboxDeliveries.outboxDeliveryId, second.deliveryId));
        expect(delivery?.status).toBe('dead');
        expect(delivery?.attemptsCount).toBe(2);
        const attempts = yield* database
          .select()
          .from(outboxAttempts)
          .where(eq(outboxAttempts.outboxDeliveryId, second.deliveryId))
          .orderBy(asc(outboxAttempts.startedAt));
        expect(attempts.map(({ errorMessage }) => errorMessage)).toEqual([
          'safe retry message',
          'terminal safe failure',
        ]);
        expect(
          yield* database.select().from(workerCheckpoints).where(eq(workerCheckpoints.tenantId, tenantId)),
        ).toEqual([]);
      }),
  );
  suite.effect('a long sequential production cycle persists each full lease and completion instant', () =>
    Effect.gen(function* sequentialNativeClock() {
      const { adminDatabase, configuration, database, tenantId } = yield* tenantFixture;
      const {
        messages,
        now,
        registration: descriptorWorker,
        repository,
      } = yield* matchedWorker(adminDatabase, database, tenantId, 'consumer.fixture.operation-clock', { messages: 5 });
      const clock = yield* TestClock.make();
      yield* clock.setTime(now.getTime());
      const { executor: competitorExecutor } = yield* makeCoreDatabase(configuration.runtime);
      const competitor = makeOutboxRuntime(makeOutboxRepository(competitorExecutor, yield* Crypto.Crypto));
      const originalMessages = yield* database
        .select()
        .from(outboxMessages)
        .where(eq(outboxMessages.tenantId, tenantId));
      const originalEvents = yield* database.select().from(domainEvents).where(eq(domainEvents.tenantId, tenantId));
      let handled = 0;
      const registration = defineOutboxWorker(
        { ...descriptorWorker.descriptor, leaseDurationMs: 30_000 },
        (_payload, context) =>
          Effect.gen(function* timedNativeHandler() {
            const claimedAt = yield* clock.currentTimeMillis;
            const [delivery] = yield* database
              .select()
              .from(outboxDeliveries)
              .where(eq(outboxDeliveries.outboxDeliveryId, context.deliveryId));
            expect(delivery?.claimedAt?.getTime()).toBe(claimedAt);
            expect(delivery?.updatedAt.getTime()).toBe(claimedAt);
            expect(delivery?.claimExpiresAt?.getTime()).toBe(claimedAt + 30_000);
            handled += 1;
            if (handled === 5) {
              const competing = yield* competitor
                .runCycle({
                  claimOwner: 'same-owner-instance-b',
                  compositionRevision,
                  maxDeliveries: 1,
                  registrations: [descriptorWorker],
                  subscriptions: [descriptorWorker.descriptor],
                })
                .pipe(Effect.provideService(Clock.Clock, clock));
              expect(competing.claimed).toBe(0);
            }
            yield* clock.adjust('8 seconds');
          }),
      );
      const result = yield* makeOutboxRuntime(repository)
        .runCycle({
          claimOwner: 'same-owner-instance-a',
          compositionRevision,
          maxDeliveries: 5,
          registrations: [registration],
          subscriptions: [registration.descriptor],
        })
        .pipe(Effect.provideService(Clock.Clock, clock));
      expect(result.succeeded).toBe(5);
      expect(yield* database.select().from(outboxMessages).where(eq(outboxMessages.tenantId, tenantId))).toEqual(
        originalMessages,
      );
      expect(yield* database.select().from(domainEvents).where(eq(domainEvents.tenantId, tenantId))).toEqual(
        originalEvents,
      );
      const attempts = yield* database
        .select()
        .from(outboxAttempts)
        .innerJoin(outboxDeliveries, eq(outboxDeliveries.outboxDeliveryId, outboxAttempts.outboxDeliveryId))
        .innerJoin(outboxMessages, eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId))
        .where(eq(outboxMessages.tenantId, tenantId))
        .orderBy(asc(outboxAttempts.startedAt));
      expect(attempts.map((row) => row.outbox_attempts.startedAt.getTime() - now.getTime())).toEqual([
        0, 8000, 16_000, 24_000, 32_000,
      ]);
      expect(attempts.map((row) => row.outbox_attempts.finishedAt?.getTime())).toEqual(
        [8000, 16_000, 24_000, 32_000, 40_000].map((offset) => now.getTime() + offset),
      );
      expect(attempts.map((row) => row.outbox_deliveries.updatedAt.getTime())).toEqual(
        [8000, 16_000, 24_000, 32_000, 40_000].map((offset) => now.getTime() + offset),
      );
      const [checkpoint] = yield* database
        .select()
        .from(workerCheckpoints)
        .where(eq(workerCheckpoints.tenantId, tenantId));
      expect(checkpoint?.lastTenantSequenceNo).toBe(messages.at(-1)?.tenantSequenceNo);
      expect(checkpoint?.lastProcessedAt?.getTime()).toBe(now.getTime() + 40_000);
      expect(checkpoint?.updatedAt.getTime()).toBe(now.getTime() + 40_000);
    }),
  );

  for (const outcome of ['declared', 'defect', 'decode'] as const) {
    suite.effect(`a later production ${outcome} failure schedules native retry from failure time`, () =>
      Effect.gen(function* failureNativeClock() {
        const { adminDatabase, database, tenantId } = yield* tenantFixture;
        const {
          now,
          registration: descriptorWorker,
          repository,
        } = yield* matchedWorker(adminDatabase, database, tenantId, 'consumer.fixture.failure-clock', {
          invalidLastPayload: outcome === 'decode',
          maxAttempts: 2,
          messages: 2,
        });
        const clock = yield* TestClock.make();
        yield* clock.setTime(now.getTime());
        let handled = 0;
        const registration = defineOutboxWorker(descriptorWorker.descriptor, () =>
          Effect.gen(function* delayedNativeFailure() {
            handled += 1;
            yield* clock.adjust(handled === 1 ? '8 seconds' : '1 second');
            if (handled === 2) {
              return yield* outcome === 'defect'
                ? Effect.die(new Error('private handler detail'))
                : Effect.fail(
                    new OutboxClaimLostError({ code: 'outbox_claim_lost', reason: 'private handler detail' }),
                  );
            }
            return yield* Effect.void;
          }),
        );
        const result = yield* makeOutboxRuntime(repository)
          .runCycle({
            claimOwner: 'failure-runtime',
            compositionRevision,
            maxDeliveries: 2,
            registrations: [registration],
            subscriptions: [registration.descriptor],
          })
          .pipe(Effect.provideService(Clock.Clock, clock));
        expect(result).toMatchObject({ failed: 1, retried: 1, succeeded: 1 });
        expect(handled).toBe(outcome === 'decode' ? 1 : 2);
        const failureOffset = outcome === 'decode' ? 8000 : 9000;
        const retryOffset = failureOffset + 1000;
        const [failed] = yield* database.select().from(outboxDeliveries).where(eq(outboxDeliveries.status, 'pending'));
        expect(failed?.updatedAt.getTime()).toBe(now.getTime() + failureOffset);
        expect(failed?.availableAt.getTime()).toBe(now.getTime() + retryOffset);
        expect(
          Option.isNone(
            yield* repository.claimNext(
              [registration],
              'retry-too-soon',
              advanceDate(now, retryOffset - 1),
              compositionRevision,
            ),
          ),
        ).toBe(true);
        const retried = Option.getOrThrow(
          yield* repository.claimNext(
            [registration],
            'retry-boundary',
            advanceDate(now, retryOffset),
            compositionRevision,
          ),
        );
        expect(retried.attemptNumber).toBe(2);
        expect(yield* repository.fail(retried, 'safe terminal failure', advanceDate(now, 11_000))).toBe('dead');
        const attempts = yield* database
          .select()
          .from(outboxAttempts)
          .where(eq(outboxAttempts.outboxDeliveryId, retried.deliveryId))
          .orderBy(asc(outboxAttempts.startedAt));
        expect(attempts[0]?.startedAt.getTime()).toBe(now.getTime() + 8000);
        expect(attempts[0]?.finishedAt?.getTime()).toBe(now.getTime() + failureOffset);
        const expectedReasons = {
          declared: 'The Outbox Worker handler returned a declared failure',
          decode: 'The Outbox Message payload does not match its published schema',
          defect: 'The Outbox Worker handler failed unexpectedly',
        };
        expect(attempts[0]?.errorMessage).toBe(expectedReasons[outcome]);
        expect(attempts[1]?.finishedAt?.getTime()).toBe(now.getTime() + 11_000);
      }),
    );
  }

  suite.effect('runtime restart reclaims exactly at expiry and rejects both stale finalizers', () =>
    Effect.gen(function* nativeClockRestart() {
      const { adminDatabase, configuration, database, tenantId } = yield* tenantFixture;
      const {
        now,
        registration: descriptorWorker,
        repository,
      } = yield* matchedWorker(adminDatabase, database, tenantId, 'consumer.fixture.restart-clock');
      const clock = yield* TestClock.make();
      yield* clock.setTime(now.getTime());
      const entered = yield* Deferred.make<Parameters<typeof repository.complete>[0]>();
      const effects = new Set<string>();
      const handlerEntered = yield* Deferred.make<null>();
      const registration = defineOutboxWorker(descriptorWorker.descriptor, (_payload, context) =>
        Effect.gen(function* restartableHandler() {
          effects.add(context.deliveryId);
          const stale = yield* Deferred.await(entered);
          expect(context.claimId).not.toBe(stale.claimId);
          const finishedAt = yield* DateTime.nowAsDate;
          expect(Schema.is(OutboxClaimLostError)(yield* Effect.flip(repository.complete(stale, finishedAt)))).toBe(
            true,
          );
          expect(
            Schema.is(OutboxClaimLostError)(yield* Effect.flip(repository.fail(stale, 'stale failure', finishedAt))),
          ).toBe(true);
          const [owned] = yield* database
            .select()
            .from(outboxDeliveries)
            .where(eq(outboxDeliveries.outboxDeliveryId, context.deliveryId));
          expect(owned?.status).toBe('processing');
          expect(owned?.claimedBy).toBe(context.claimId);
          const [attempt] = yield* database
            .select()
            .from(outboxAttempts)
            .where(eq(outboxAttempts.outboxDeliveryId, context.deliveryId))
            .orderBy(asc(outboxAttempts.startedAt));
          expect(attempt).toBeDefined();
        }),
      );
      const interruptedRegistration = defineOutboxWorker(registration.descriptor, (_payload, context) =>
        Effect.gen(function* interruptedNativeHandler() {
          effects.add(context.deliveryId);
          yield* Deferred.succeed(handlerEntered, null);
          return yield* Effect.never;
        }),
      );
      const first = yield* Effect.scoped(
        Effect.gen(function* firstRuntimeScope() {
          const { executor } = yield* makeCoreDatabase(configuration.runtime);
          const originalRepository = makeOutboxRepository(executor, yield* Crypto.Crypto);
          const probeRepository = observeClaims(originalRepository, entered);
          const running = yield* makeOutboxRuntime(probeRepository)
            .runCycle({
              claimOwner: 'before-restart',
              compositionRevision,
              maxDeliveries: 1,
              registrations: [interruptedRegistration],
              subscriptions: [interruptedRegistration.descriptor],
            })
            .pipe(Effect.provideService(Clock.Clock, clock), Effect.forkChild);
          const claimed = yield* Deferred.await(entered);
          yield* Deferred.await(handlerEntered);
          yield* Fiber.interrupt(running);
          return claimed;
        }),
      );
      yield* clock.setTime(now.getTime() + 999);
      const { executor: restartedExecutor } = yield* makeCoreDatabase(configuration.runtime);
      const restarted = makeOutboxRepository(restartedExecutor, yield* Crypto.Crypto);
      const input = {
        claimOwner: 'after-restart',
        compositionRevision,
        maxDeliveries: 1,
        registrations: [registration],
        subscriptions: [registration.descriptor],
      };
      expect(
        (yield* makeOutboxRuntime(restarted).runCycle(input).pipe(Effect.provideService(Clock.Clock, clock))).claimed,
      ).toBe(0);
      yield* clock.setTime(now.getTime() + 1000);
      const result = yield* makeOutboxRuntime(restarted)
        .runCycle(input)
        .pipe(Effect.provideService(Clock.Clock, clock));
      expect(result.succeeded).toBe(1);
      expect(
        Schema.is(OutboxClaimLostError)(yield* Effect.flip(repository.complete(first, advanceDate(now, 1001)))),
      ).toBe(true);
      expect(
        Schema.is(OutboxClaimLostError)(
          yield* Effect.flip(repository.fail(first, 'stale failure', advanceDate(now, 1001))),
        ),
      ).toBe(true);
      const attempts = yield* database
        .select()
        .from(outboxAttempts)
        .where(eq(outboxAttempts.outboxDeliveryId, first.deliveryId))
        .orderBy(asc(outboxAttempts.startedAt));
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.finishedAt?.getTime()).toBe(now.getTime() + 1000);
      expect(attempts[1]?.startedAt.getTime()).toBe(now.getTime() + 1000);
      expect(attempts[1]?.finishedAt?.getTime()).toBe(now.getTime() + 1000);
      expect(effects.size).toBe(1);
    }),
  );

  it('keeps test descriptor arrays compatible with the erased startup registry surface', () => {
    const registry: readonly AnyOutboxWorkerRegistration[] = [makeWorker('consumer.fixture.registry-proof')];
    expect(registry[0]?.descriptor.workerKey).toBe('consumer.fixture.registry-proof');
  });
});
