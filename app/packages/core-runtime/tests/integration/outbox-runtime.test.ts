import { expect, it } from 'effect-rstest';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema, pipe } from 'effect';
import { makeCoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import {
  domainEvents,
  outboxAttempts,
  outboxDeliveries,
  outboxMessages,
  tenantModuleStates,
  tenants,
  workerCheckpoints,
} from '../../src/db/schema.ts';
import type { CoreDatabaseExecutor } from '../../src/db/types.ts';
import { defineOutboxWorker } from '../../src/outbox/definition.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { AnyOutboxWorkerRegistration } from '../../src/outbox/definition.ts';
import { OutboxClaimLostError } from '../../src/outbox/errors.ts';
import { makeOutboxRepository } from '../../src/outbox/repository.ts';

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
      consumerModuleKey: options.consumerModuleKey ?? 'consumer',
      entrypoint: defineTenantModuleEntrypoint({
        access: 'background',
        authorization: { kind: 'owner_local_background' },
        entrypointKey: workerKey,
        moduleKey: options.consumerModuleKey ?? 'consumer',
        role: 'worker',
      }),
      leaseDurationMs: 1000,
      payloadSchema,
      producerModuleKey: 'producer',
      retryPolicy: {
        initialBackoffMs: 1000,
        maxAttempts: options.maxAttempts ?? 3,
        maxBackoffMs: 4000,
        multiplier: 2,
      },
      topic: options.topic ?? 'producer.message-created',
      workerKey,
    },
    () => Effect.void,
  );
const subscriptionOf = (registration: AnyOutboxWorkerRegistration) => registration.descriptor;
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
    moduleKey: 'consumer',
    state,
    tenantId,
  });
const insertMessage = (
  database: CoreDatabaseExecutor,
  tenantId: string,
  topic = 'producer.message-created',
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
            producerModuleKey: 'producer',
            subjectModuleKey: 'producer',
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
            producerModuleKey: 'producer',
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
    yield* database
      .delete(outboxDeliveries)
      .where(inArray(outboxDeliveries.outboxMessageId, messageIds));
    yield* database.delete(outboxMessages).where(eq(outboxMessages.tenantId, tenantId));
    yield* database.delete(domainEvents).where(eq(domainEvents.tenantId, tenantId));
    yield* database.delete(tenantModuleStates).where(eq(tenantModuleStates.tenantId, tenantId));
    yield* database.delete(tenants).where(eq(tenants.tenantId, tenantId));
  });
it.live('matches zero, one, or multiple exact workers once without historical backfill', () =>
  Effect.gen(function* matchesZeroOneOrMultiple() {
    const configuration = yield* loadDatabaseConfig();
    const { executor: database } = yield* makeCoreDatabase(configuration);
    const tenantId = yield* Effect.acquireRelease(insertTenant(database), (id) =>
      cleanupTenant(database, id).pipe(Effect.orDie),
    );
    yield* insertMessage(database, tenantId);
    yield* insertMessage(database, tenantId, 'producer.unmatched');
    const repository = makeOutboxRepository(database);
    const workers = [makeWorker('consumer.alpha'), makeWorker('consumer.beta')];
    const firstMatch = yield* repository.matchUnmatched(
      workers.map(subscriptionOf),
      dateAt('2026-08-03T10:00:00Z'),
    );
    expect(firstMatch.deliveriesCreated).toBe(2);
    expect(firstMatch.messagesMatched >= 2).toBe(true);
    const repeatMatch = yield* repository.matchUnmatched(
      workers.map(subscriptionOf),
      dateAt('2026-08-03T10:01:00Z'),
    );
    expect(repeatMatch.deliveriesCreated).toBe(0);
    const lateWorkerMatch = yield* repository.matchUnmatched(
      [...workers, makeWorker('consumer.late')].map(subscriptionOf),
      dateAt('2026-08-03T10:02:00Z'),
    );
    expect(lateWorkerMatch.deliveriesCreated).toBe(0);
    const deliveries = yield* database
      .select()
      .from(outboxDeliveries)
      .innerJoin(
        outboxMessages,
        eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId),
      )
      .where(eq(outboxMessages.tenantId, tenantId));
    expect(deliveries.length).toBe(2);
    expect(deliveries.map((row) => row.outbox_deliveries.workerKey).toSorted()).toEqual([
      'consumer.alpha',
      'consumer.beta',
    ]);
    const messages = yield* database
      .select({ matchedAt: outboxMessages.matchedAt })
      .from(outboxMessages)
      .where(eq(outboxMessages.tenantId, tenantId));
    expect(messages.every(({ matchedAt }) => matchedAt !== null)).toBe(true);
  }),
);
it.live('matches the complete subscription catalog before owner-local processes claim work', () =>
  Effect.gen(function* matchesTheCompleteSubscriptionCatalog() {
    const configuration = yield* loadDatabaseConfig();
    const { executor: database } = yield* makeCoreDatabase(configuration);
    const tenantId = yield* Effect.acquireRelease(insertTenant(database), (id) =>
      cleanupTenant(database, id).pipe(Effect.orDie),
    );
    yield* activateConsumer(database, tenantId);
    yield* database.insert(tenantModuleStates).values({
      moduleKey: 'reporting',
      state: 'active',
      tenantId,
    });
    yield* insertMessage(database, tenantId);
    const consumerWorker = makeWorker('consumer.local');
    const reportingWorker = makeWorker('reporting.local', {
      consumerModuleKey: 'reporting',
    });
    const repository = makeOutboxRepository(database);
    const subscriptions = [consumerWorker, reportingWorker].map(subscriptionOf);
    const matched = yield* repository.matchUnmatched(subscriptions, dateAt('2026-08-03T10:00:00Z'));
    expect(matched.deliveriesCreated).toBe(2);
    const claimAt = yield* DateTime.nowAsDate;
    const consumerClaim = Option.getOrNull(
      yield* repository.claimNext([consumerWorker], 'consumer-process', claimAt),
    );
    const reportingClaim = Option.getOrNull(
      yield* repository.claimNext([reportingWorker], 'reporting-process', claimAt),
    );
    expect(consumerClaim?.workerKey).toBe('consumer.local');
    expect(reportingClaim?.workerKey).toBe('reporting.local');
  }),
);
it.live(
  'gates claims on every non-active consumer state and permits one concurrent live claim',
  () =>
    Effect.gen(function* gatesClaimsOnEveryNonactive() {
      const configuration = yield* loadDatabaseConfig();
      const { executor: database } = yield* makeCoreDatabase(configuration);
      const tenantId = yield* Effect.acquireRelease(insertTenant(database), (id) =>
        cleanupTenant(database, id).pipe(Effect.orDie),
      );
      yield* insertMessage(database, tenantId);
      const registration = makeWorker('consumer.module-gated');
      const repository = makeOutboxRepository(database);
      yield* repository.matchUnmatched(
        [subscriptionOf(registration)],
        dateAt('2026-08-03T11:00:00Z'),
      );
      const claimAt = advanceDate(yield* DateTime.nowAsDate, 1000);
      expect(
        Option.getOrNull(yield* repository.claimNext([registration], 'runtime-a', claimAt)),
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
                and(
                  eq(tenantModuleStates.tenantId, tenantId),
                  eq(tenantModuleStates.moduleKey, 'consumer'),
                ),
              );
            expect(
              Option.getOrNull(
                yield* repository.claimNext([registration], `runtime-${state}`, claimAt),
              ),
            ).toBe(null);
          }),
        ),
      );
      yield* database
        .update(tenantModuleStates)
        .set({ state: 'active' })
        .where(
          and(
            eq(tenantModuleStates.tenantId, tenantId),
            eq(tenantModuleStates.moduleKey, 'consumer'),
          ),
        );
      const claimOptions = yield* Effect.all(
        [
          repository.claimNext([registration], 'runtime-a', claimAt),
          repository.claimNext([registration], 'runtime-b', claimAt),
        ],
        { concurrency: 'unbounded' },
      );
      const claims = claimOptions.map(Option.getOrNull);
      expect(claims.filter((candidate) => candidate !== null).length).toBe(1);
      const claimed = Option.getOrThrow(
        Option.fromNullishOr(claims.find((candidate) => candidate !== null)),
      );
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
it.live(
  'reclaims only expired leases, abandons the old attempt, and rejects stale finalization',
  () =>
    Effect.gen(function* reclaimsOnlyExpiredLeasesAbandons() {
      const configuration = yield* loadDatabaseConfig();
      const { executor: database } = yield* makeCoreDatabase(configuration);
      const tenantId = yield* Effect.acquireRelease(insertTenant(database), (id) =>
        cleanupTenant(database, id).pipe(Effect.orDie),
      );
      yield* activateConsumer(database, tenantId);
      yield* insertMessage(database, tenantId);
      const registration = makeWorker('consumer.lease-proof');
      const repository = makeOutboxRepository(database);
      const started = advanceDate(yield* DateTime.nowAsDate, 1000);
      yield* repository.matchUnmatched([subscriptionOf(registration)], started);
      const first = Option.getOrThrow(
        yield* repository.claimNext([registration], 'runtime-a', started),
      );
      expect(first).toBeDefined();
      expect(
        Option.getOrNull(
          yield* repository.claimNext([registration], 'runtime-b', advanceDate(started, 999)),
        ),
      ).toBe(null);
      const second = Option.getOrThrow(
        yield* repository.claimNext([registration], 'runtime-b', advanceDate(started, 1001)),
      );
      expect(second).toBeDefined();
      expect(second.claimId).not.toBe(first.claimId);
      expect(
        Schema.is(OutboxClaimLostError)(
          yield* Effect.flip(repository.complete(first, advanceDate(started, 1002))),
        ),
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
    const configuration = yield* loadDatabaseConfig();
    const { executor: database } = yield* makeCoreDatabase(configuration);
    const tenantId = yield* Effect.acquireRelease(insertTenant(database), (id) =>
      cleanupTenant(database, id).pipe(Effect.orDie),
    );
    yield* activateConsumer(database, tenantId);
    yield* insertMessage(database, tenantId);
    const registration = makeWorker('consumer.final-lease', { maxAttempts: 1 });
    const repository = makeOutboxRepository(database);
    const started = advanceDate(yield* DateTime.nowAsDate, 1000);
    yield* repository.matchUnmatched([subscriptionOf(registration)], started);
    const claim = Option.getOrThrow(
      yield* repository.claimNext([registration], 'runtime-a', started),
    );
    expect(claim).toBeDefined();
    expect(
      Option.getOrNull(
        yield* repository.claimNext([registration], 'runtime-b', advanceDate(started, 1001)),
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
it.live('finalizes success atomically and advances only through contiguous done deliveries', () =>
  Effect.gen(function* finalizesSuccessAtomicallyAndAdvances() {
    const configuration = yield* loadDatabaseConfig();
    const { executor: database } = yield* makeCoreDatabase(configuration);
    const tenantId = yield* Effect.acquireRelease(insertTenant(database), (id) =>
      cleanupTenant(database, id).pipe(Effect.orDie),
    );
    yield* activateConsumer(database, tenantId);
    const firstMessage = yield* insertMessage(database, tenantId);
    const secondMessage = yield* insertMessage(database, tenantId);
    const registration = makeWorker('consumer.checkpoint-proof');
    const repository = makeOutboxRepository(database);
    const now = advanceDate(yield* DateTime.nowAsDate, 1000);
    yield* repository.matchUnmatched([subscriptionOf(registration)], now);
    const first = Option.getOrThrow(yield* repository.claimNext([registration], 'runtime-a', now));
    const second = Option.getOrThrow(yield* repository.claimNext([registration], 'runtime-b', now));
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    yield* repository.complete(second, advanceDate(now, 1));
    expect(
      yield* database
        .select()
        .from(workerCheckpoints)
        .where(eq(workerCheckpoints.tenantId, tenantId)),
    ).toEqual([]);
    yield* repository.complete(first, advanceDate(now, 2));
    const checkpoint = Option.getOrThrow(
      Option.fromNullishOr(
        (yield* database
          .select()
          .from(workerCheckpoints)
          .where(eq(workerCheckpoints.tenantId, tenantId)))[0],
      ),
    );
    expect(checkpoint).toBeDefined();
    expect(checkpoint.consumerName).toBe(registration.descriptor.workerKey);
    expect(checkpoint.streamKey).toBe('producer:producer.message-created');
    expect(checkpoint.lastTenantSequenceNo).toBe(secondMessage.tenantSequenceNo);
    expect(
      Option.getOrThrow(Option.fromNullishOr(checkpoint.lastTenantSequenceNo)) >
        firstMessage.tenantSequenceNo,
    ).toBe(true);
    const deliveries = yield* database
      .select()
      .from(outboxDeliveries)
      .innerJoin(
        outboxMessages,
        eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId),
      )
      .where(eq(outboxMessages.tenantId, tenantId));
    expect(deliveries.every((row) => row.outbox_deliveries.status === 'done')).toBe(true);
    expect(deliveries.every((row) => row.outbox_deliveries.claimedBy === null)).toBe(true);
  }),
);
it.live(
  'schedules bounded retry, dead-letters exhaustion, stores safe errors, and never checkpoints failure',
  () =>
    Effect.gen(function* schedulesBoundedRetryDeadlettersExhaustion() {
      const configuration = yield* loadDatabaseConfig();
      const { executor: database } = yield* makeCoreDatabase(configuration);
      const tenantId = yield* Effect.acquireRelease(insertTenant(database), (id) =>
        cleanupTenant(database, id).pipe(Effect.orDie),
      );
      yield* activateConsumer(database, tenantId);
      yield* insertMessage(database, tenantId);
      const registration = makeWorker('consumer.retry-proof', { maxAttempts: 2 });
      const repository = makeOutboxRepository(database);
      const now = advanceDate(yield* DateTime.nowAsDate, 1000);
      yield* repository.matchUnmatched([subscriptionOf(registration)], now);
      const first = Option.getOrThrow(
        yield* repository.claimNext([registration], 'runtime-a', now),
      );
      expect(first).toBeDefined();
      expect(yield* repository.fail(first, ' safe\nretry\tmessage ', advanceDate(now, 1))).toBe(
        'pending',
      );
      expect(
        Option.getOrNull(
          yield* repository.claimNext([registration], 'runtime-b', advanceDate(now, 999)),
        ),
      ).toBe(null);
      const second = Option.getOrThrow(
        yield* repository.claimNext([registration], 'runtime-b', advanceDate(now, 1001)),
      );
      expect(second).toBeDefined();
      expect(yield* repository.fail(second, 'terminal safe failure', advanceDate(now, 1002))).toBe(
        'dead',
      );
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
        yield* database
          .select()
          .from(workerCheckpoints)
          .where(eq(workerCheckpoints.tenantId, tenantId)),
      ).toEqual([]);
    }),
);
it('keeps test descriptor arrays compatible with the erased startup registry surface', () => {
  const registry: readonly AnyOutboxWorkerRegistration[] = [makeWorker('consumer.registry-proof')];
  expect(registry[0]?.descriptor.workerKey).toBe('consumer.registry-proof');
});
