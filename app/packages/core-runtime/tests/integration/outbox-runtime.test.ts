import { randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DateTime, Deferred, Effect, Exit, Fiber, Option, Schema, pipe } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeCoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
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
import { OutboxClaimLostError } from '../../src/outbox/errors.ts';
import { makeOutboxRepository } from '../../src/outbox/repository.ts';
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
    const tenantId = randomUUID();
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
  messageKey = randomUUID(),
) =>
  Effect.gen(function* insertMessageEffect() {
    const event = Option.getOrThrow(
      Option.fromNullishOr(
        (yield* database
          .insert(domainEvents)
          .values({
            eventType: topic,
            payloadJson: { messageKey },
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
            payloadJson: { messageKey },
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
  const configuration = yield* loadDatabaseConnectionPair();
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
  return { adminDatabase, database, tenantId };
});

/** Seed and match one worker against a clock advanced beyond its pending rows. */
const matchedWorker = Effect.fn(function* matchedWorker(
  adminDatabase: CoreDatabaseExecutor,
  database: CoreDatabaseExecutor,
  tenantId: string,
  workerKey: string,
  options: Parameters<typeof makeWorker>[1] & {
    readonly messages?: number;
  } = {},
) {
  yield* activateConsumer(database, tenantId);
  const messages = yield* Effect.forEach(Array.from({ length: options.messages ?? 1 }), () =>
    insertMessage(database, tenantId),
  );
  const registration = makeWorker(workerKey, options);
  const repository = makeOutboxRepository(database);
  const now = advanceDate(yield* DateTime.nowAsDate, 1000);
  yield* publishAuthority(adminDatabase, [subscriptionOf(registration)]);
  yield* repository.matchUnmatched(compositionRevision, now);
  return { messages, now, registration, repository };
});

it.live('matches zero, one, or multiple exact workers once without historical backfill', () =>
  Effect.gen(function* matchesZeroOneOrMultiple() {
    const { adminDatabase, database, tenantId } = yield* tenantFixture;
    yield* insertMessage(database, tenantId);
    yield* insertMessage(database, tenantId, 'producer.fixture.unmatched');
    const repository = makeOutboxRepository(database);
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
it.live('matches complete authority subscriptions while owner-local consumer processes are offline', () =>
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
    const repository = makeOutboxRepository(database);
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
it.live('keeps messages unmatched while authority is missing, expired, or superseded and resumes safely', () =>
  Effect.gen(function* preservesMessagesWithoutCurrentAuthority() {
    const { adminDatabase, database, tenantId } = yield* tenantFixture;
    const { messageId } = yield* insertMessage(database, tenantId);
    const workers = [makeWorker('consumer.fixture.authority'), makeWorker('consumer.fixture.offline')];
    const subscriptions = workers.map(subscriptionOf);
    const repository = makeOutboxRepository(database);
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
it.live('matches a complete empty authority once without backfilling a later installed consumer', () =>
  Effect.gen(function* preservesEmptyAuthorityMatching() {
    const { adminDatabase, database, tenantId } = yield* tenantFixture;
    const { messageId } = yield* insertMessage(database, tenantId);
    const repository = makeOutboxRepository(database);
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
it.live('materializes every old subscription during draining before owner-local delivery execution', () =>
  Effect.gen(function* preservesDrainingBacklog() {
    const { adminDatabase, database, tenantId } = yield* tenantFixture;
    yield* activateConsumer(database, tenantId);
    const { messageId } = yield* insertMessage(database, tenantId);
    const workers = [
      makeWorker('consumer.fixture.draining'),
      makeWorker('reporting.fixture.draining', { consumerModuleKey: 'reporting.fixture' }),
    ];
    const repository = makeOutboxRepository(database);
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
it.live('prevents the application runtime from publishing or changing composition authority', () =>
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
it.live('serializes matching behind promotion and rejects the superseded matcher before message mutation', () =>
  Effect.gen(function* serializesMatchingWithPromotion() {
    const { adminDatabase, database, tenantId } = yield* tenantFixture;
    yield* activateConsumer(database, tenantId);
    const { messageId } = yield* insertMessage(database, tenantId);
    const registration = makeWorker('consumer.fixture.serialized');
    yield* publishAuthority(adminDatabase, [subscriptionOf(registration)]);
    const repository = makeOutboxRepository(database);
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
      Option.isSome(yield* repository.claimNext([registration], 'current-worker', dueAt, promotedCompositionRevision)),
    ).toBe(true);
  }),
);
it.live('rejects snapshot isolation for matching and publication before changing durable state', () =>
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
      (yield* makeOutboxRepository(database).matchUnmatched(compositionRevision, yield* DateTime.nowAsDate))
        .deliveriesCreated,
    ).toBe(1);
  }),
);
it.live('gates claims on every non-active consumer state and permits one concurrent live claim', () =>
  Effect.gen(function* gatesClaimsOnEveryNonactive() {
    const { adminDatabase, database, tenantId } = yield* tenantFixture;
    yield* insertMessage(database, tenantId);
    const registration = makeWorker('consumer.fixture.module-gated');
    const repository = makeOutboxRepository(database);
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
it.live('reclaims only expired leases, abandons the old attempt, and rejects stale finalization', () =>
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
it.live('finishes an abandoned final attempt before dead-lettering its expired delivery', () =>
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
        (yield* database.select().from(outboxAttempts).where(eq(outboxAttempts.outboxDeliveryId, claim.deliveryId)))[0],
      ),
    );
    expect(delivery?.status).toBe('dead');
    expect(attempt?.errorMessage).toBe('Outbox Worker lease expired before completion');
    expect(Option.isSome(Option.fromNullishOr(attempt?.finishedAt))).toBe(true);
  }),
);
it.live('finalizes success atomically and advances only through contiguous done deliveries', () =>
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
    const first = Option.getOrThrow(yield* repository.claimNext([registration], 'runtime-a', now, compositionRevision));
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
it.live('schedules bounded retry, dead-letters exhaustion, stores safe errors, and never checkpoints failure', () =>
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
    const first = Option.getOrThrow(yield* repository.claimNext([registration], 'runtime-a', now, compositionRevision));
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
    expect(attempts.map(({ errorMessage }) => errorMessage)).toEqual(['safe retry message', 'terminal safe failure']);
    expect(yield* database.select().from(workerCheckpoints).where(eq(workerCheckpoints.tenantId, tenantId))).toEqual(
      [],
    );
  }),
);
it('keeps test descriptor arrays compatible with the erased startup registry surface', () => {
  const registry: readonly AnyOutboxWorkerRegistration[] = [makeWorker('consumer.fixture.registry-proof')];
  expect(registry[0]?.descriptor.workerKey).toBe('consumer.fixture.registry-proof');
});
