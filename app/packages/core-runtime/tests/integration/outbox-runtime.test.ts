import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
// @effect-diagnostics asyncFunction:off -- Existing compatibility boundary; expires: 2026-12-31.
import { and, asc, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
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
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { AnyOutboxWorkerRegistration } from '../../src/outbox/definition.ts';
import { defineOutboxWorker } from '../../src/outbox/definition.ts';
import { OutboxClaimLostError } from '../../src/outbox/errors.ts';
import type { OutboxClaim, OutboxRepositoryService } from '../../src/outbox/repository.ts';
import { makeOutboxRepository } from '../../src/outbox/repository.ts';

const MessageKeySchema = Schema.String.pipe(Schema.brand('MessageKey'));
const payloadSchema = Schema.Struct({ messageKey: MessageKeySchema });

const dateAt = (instant: string): Date => DateTime.toDateUtc(DateTime.makeUnsafe(instant));

const advanceDate = (date: Date, milliseconds: number): Date =>
  DateTime.makeUnsafe(date).pipe(DateTime.add({ milliseconds }), DateTime.toDateUtc);

const claimNext = async (
  repository: OutboxRepositoryService,
  registrations: readonly AnyOutboxWorkerRegistration[],
  claimOwner: string,
  now: Date,
): Promise<Option.Option<OutboxClaim>> =>
  await runEffectTestPromise(repository.claimNext(registrations, claimOwner, now));

const forEachSequential = async <Value>(
  values: readonly Value[],
  operation: (value: Value) => PromiseLike<void>,
  index = 0,
): Promise<void> => {
  const value = values[index];
  if (value === undefined) {
    return;
  }
  await operation(value);
  await forEachSequential(values, operation, index + 1);
};

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

const withDatabase = async <Value>(
  operation: (database: CoreDatabaseExecutor) => Promise<Value>,
): Promise<Value> =>
  await runEffectTestPromise(
    Effect.scoped(
      Effect.gen(function* databaseScope() {
        const configuration = yield* loadDatabaseConfig();
        const database = yield* makeCoreDatabase(configuration);
        return yield* Effect.promise(async () => await operation(database.executor));
      }),
    ),
  );

const insertTenant = async (database: CoreDatabaseExecutor): Promise<string> => {
  const tenantId = randomUUID();
  await runEffectTestPromise(
    database.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Outbox Runtime Integration',
      slug: `outbox-runtime-${tenantId}`,
      status: 'active',
      tenantId,
    }),
  );
  return tenantId;
};

const activateConsumer = (database: CoreDatabaseExecutor, tenantId: string, state = 'active') =>
  database.insert(tenantModuleStates).values({
    moduleKey: 'consumer',
    state,
    tenantId,
  });

const insertMessage = async (
  database: CoreDatabaseExecutor,
  tenantId: string,
  topic = 'producer.message-created',
  messageKey = randomUUID(),
) => {
  const [event] = await runEffectTestPromise(
    database
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
      }),
  );
  assert.ok(event);
  const [message] = await runEffectTestPromise(
    database
      .insert(outboxMessages)
      .values({
        domainEventId: event.domainEventId,
        payloadJson: { messageKey },
        producerModuleKey: 'producer',
        tenantId,
        topic,
      })
      .returning({ messageId: outboxMessages.outboxMessageId }),
  );
  assert.ok(message);
  return { ...event, ...message };
};

const cleanupTenant = async (database: CoreDatabaseExecutor, tenantId: string): Promise<void> => {
  await runEffectTestPromise(
    database.delete(workerCheckpoints).where(eq(workerCheckpoints.tenantId, tenantId)),
  );
  const messageRows = await runEffectTestPromise(
    database
      .select({ messageId: outboxMessages.outboxMessageId })
      .from(outboxMessages)
      .where(eq(outboxMessages.tenantId, tenantId)),
  );
  await forEachSequential(messageRows, async ({ messageId }) => {
    const deliveries = await runEffectTestPromise(
      database
        .select({ deliveryId: outboxDeliveries.outboxDeliveryId })
        .from(outboxDeliveries)
        .where(eq(outboxDeliveries.outboxMessageId, messageId)),
    );
    await forEachSequential(deliveries, async ({ deliveryId }) => {
      await runEffectTestPromise(
        database.delete(outboxAttempts).where(eq(outboxAttempts.outboxDeliveryId, deliveryId)),
      );
    });
    await runEffectTestPromise(
      database.delete(outboxDeliveries).where(eq(outboxDeliveries.outboxMessageId, messageId)),
    );
  });
  await runEffectTestPromise(
    database.delete(outboxMessages).where(eq(outboxMessages.tenantId, tenantId)),
  );
  await runEffectTestPromise(
    database.delete(domainEvents).where(eq(domainEvents.tenantId, tenantId)),
  );
  await runEffectTestPromise(
    database.delete(tenantModuleStates).where(eq(tenantModuleStates.tenantId, tenantId)),
  );
  await runEffectTestPromise(database.delete(tenants).where(eq(tenants.tenantId, tenantId)));
};

void test('matches zero, one, or multiple exact workers once without historical backfill', async () => {
  await withDatabase(async (database) => {
    const tenantId = await insertTenant(database);
    try {
      await insertMessage(database, tenantId);
      await insertMessage(database, tenantId, 'producer.unmatched');
      const repository = makeOutboxRepository(database);
      const workers = [makeWorker('consumer.alpha'), makeWorker('consumer.beta')];

      const firstMatch = await runEffectTestPromise(
        repository.matchUnmatched(workers.map(subscriptionOf), dateAt('2026-08-03T10:00:00Z')),
      );
      assert.equal(firstMatch.deliveriesCreated, 2);
      assert.ok(firstMatch.messagesMatched >= 2);
      const repeatMatch = await runEffectTestPromise(
        repository.matchUnmatched(workers.map(subscriptionOf), dateAt('2026-08-03T10:01:00Z')),
      );
      assert.equal(repeatMatch.deliveriesCreated, 0);
      const lateWorkerMatch = await runEffectTestPromise(
        repository.matchUnmatched(
          [...workers, makeWorker('consumer.late')].map(subscriptionOf),
          dateAt('2026-08-03T10:02:00Z'),
        ),
      );
      assert.equal(lateWorkerMatch.deliveriesCreated, 0);
      const deliveries = await runEffectTestPromise(
        database
          .select()
          .from(outboxDeliveries)
          .innerJoin(
            outboxMessages,
            eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId),
          )
          .where(eq(outboxMessages.tenantId, tenantId)),
      );
      assert.equal(deliveries.length, 2);
      assert.deepEqual(deliveries.map((row) => row.outbox_deliveries.workerKey).toSorted(), [
        'consumer.alpha',
        'consumer.beta',
      ]);
      const messages = await runEffectTestPromise(
        database
          .select({ matchedAt: outboxMessages.matchedAt })
          .from(outboxMessages)
          .where(eq(outboxMessages.tenantId, tenantId)),
      );
      assert.equal(
        messages.every(({ matchedAt }) => matchedAt !== null),
        true,
      );
    } finally {
      await cleanupTenant(database, tenantId);
    }
  });
});

void test('matches the complete subscription catalog before owner-local processes claim work', async () => {
  await withDatabase(async (database) => {
    const tenantId = await insertTenant(database);
    try {
      await runEffectTestPromise(activateConsumer(database, tenantId));
      await runEffectTestPromise(
        database.insert(tenantModuleStates).values({
          moduleKey: 'reporting',
          state: 'active',
          tenantId,
        }),
      );
      await insertMessage(database, tenantId);
      const consumerWorker = makeWorker('consumer.local');
      const reportingWorker = makeWorker('reporting.local', {
        consumerModuleKey: 'reporting',
      });
      const repository = makeOutboxRepository(database);
      const subscriptions = [consumerWorker, reportingWorker].map(subscriptionOf);

      const matched = await runEffectTestPromise(
        repository.matchUnmatched(subscriptions, dateAt('2026-08-03T10:00:00Z')),
      );
      assert.equal(matched.deliveriesCreated, 2);

      const claimAt = await runEffectTestPromise(DateTime.nowAsDate);
      const consumerClaim = Option.getOrNull(
        await claimNext(repository, [consumerWorker], 'consumer-process', claimAt),
      );
      const reportingClaim = Option.getOrNull(
        await claimNext(repository, [reportingWorker], 'reporting-process', claimAt),
      );
      assert.equal(consumerClaim?.workerKey, 'consumer.local');
      assert.equal(reportingClaim?.workerKey, 'reporting.local');
    } finally {
      await cleanupTenant(database, tenantId);
    }
  });
});

void test('gates claims on every non-active consumer state and permits one concurrent live claim', async () => {
  await withDatabase(async (database) => {
    const tenantId = await insertTenant(database);
    try {
      await insertMessage(database, tenantId);
      const registration = makeWorker('consumer.module-gated');
      const repository = makeOutboxRepository(database);
      await runEffectTestPromise(
        repository.matchUnmatched([subscriptionOf(registration)], dateAt('2026-08-03T11:00:00Z')),
      );
      const claimAt = advanceDate(await runEffectTestPromise(DateTime.nowAsDate), 1000);
      assert.equal(
        Option.getOrNull(await claimNext(repository, [registration], 'runtime-a', claimAt)),
        null,
      );
      await runEffectTestPromise(activateConsumer(database, tenantId, 'inactive'));
      await forEachSequential(
        ['inactive', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived'] as const,
        async (state) => {
          await runEffectTestPromise(
            database
              .update(tenantModuleStates)
              .set({ state })
              .where(
                and(
                  eq(tenantModuleStates.tenantId, tenantId),
                  eq(tenantModuleStates.moduleKey, 'consumer'),
                ),
              ),
          );
          assert.equal(
            Option.getOrNull(
              await claimNext(repository, [registration], `runtime-${state}`, claimAt),
            ),
            null,
          );
        },
      );
      await runEffectTestPromise(
        database
          .update(tenantModuleStates)
          .set({ state: 'active' })
          .where(
            and(
              eq(tenantModuleStates.tenantId, tenantId),
              eq(tenantModuleStates.moduleKey, 'consumer'),
            ),
          ),
      );
      const claimOptions = await Promise.all([
        claimNext(repository, [registration], 'runtime-a', claimAt),
        claimNext(repository, [registration], 'runtime-b', claimAt),
      ]);
      const claims = claimOptions.map(Option.getOrNull);
      assert.equal(claims.filter((candidate) => candidate !== null).length, 1);
      const claimed = claims.find((candidate) => candidate !== null);
      assert.ok(claimed);
      const [attempt] = await runEffectTestPromise(
        database
          .select()
          .from(outboxAttempts)
          .where(eq(outboxAttempts.outboxDeliveryId, claimed.deliveryId)),
      );
      assert.ok(attempt);
      assert.equal(attempt.finishedAt, null);
    } finally {
      await cleanupTenant(database, tenantId);
    }
  });
});

void test('reclaims only expired leases, abandons the old attempt, and rejects stale finalization', async () => {
  await withDatabase(async (database) => {
    const tenantId = await insertTenant(database);
    try {
      await runEffectTestPromise(activateConsumer(database, tenantId));
      await insertMessage(database, tenantId);
      const registration = makeWorker('consumer.lease-proof');
      const repository = makeOutboxRepository(database);
      const started = advanceDate(await runEffectTestPromise(DateTime.nowAsDate), 1000);
      await runEffectTestPromise(
        repository.matchUnmatched([subscriptionOf(registration)], started),
      );
      const first = Option.getOrNull(
        await claimNext(repository, [registration], 'runtime-a', started),
      );
      assert.ok(first);
      assert.equal(
        Option.getOrNull(
          await claimNext(repository, [registration], 'runtime-b', advanceDate(started, 999)),
        ),
        null,
      );
      const second = Option.getOrNull(
        await claimNext(repository, [registration], 'runtime-b', advanceDate(started, 1001)),
      );
      assert.ok(second);
      assert.notEqual(second.claimId, first.claimId);
      await assert.rejects(
        runEffectTestPromise(repository.complete(first, advanceDate(started, 1002))),
        Schema.is(OutboxClaimLostError),
      );
      const attempts = await runEffectTestPromise(
        database
          .select()
          .from(outboxAttempts)
          .where(eq(outboxAttempts.outboxDeliveryId, first.deliveryId))
          .orderBy(asc(outboxAttempts.startedAt)),
      );
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0]?.errorMessage, 'Outbox Worker lease expired before completion');
      assert.ok(attempts[0]?.finishedAt);
      assert.equal(attempts[1]?.finishedAt, null);
    } finally {
      await cleanupTenant(database, tenantId);
    }
  });
});

void test('finishes an abandoned final attempt before dead-lettering its expired delivery', async () => {
  await withDatabase(async (database) => {
    const tenantId = await insertTenant(database);
    try {
      await runEffectTestPromise(activateConsumer(database, tenantId));
      await insertMessage(database, tenantId);
      const registration = makeWorker('consumer.final-lease', { maxAttempts: 1 });
      const repository = makeOutboxRepository(database);
      const started = advanceDate(await runEffectTestPromise(DateTime.nowAsDate), 1000);
      await runEffectTestPromise(
        repository.matchUnmatched([subscriptionOf(registration)], started),
      );
      const claim = Option.getOrNull(
        await claimNext(repository, [registration], 'runtime-a', started),
      );
      assert.ok(claim);

      assert.equal(
        Option.getOrNull(
          await claimNext(repository, [registration], 'runtime-b', advanceDate(started, 1001)),
        ),
        null,
      );
      const [delivery] = await runEffectTestPromise(
        database
          .select()
          .from(outboxDeliveries)
          .where(eq(outboxDeliveries.outboxDeliveryId, claim.deliveryId)),
      );
      const [attempt] = await runEffectTestPromise(
        database
          .select()
          .from(outboxAttempts)
          .where(eq(outboxAttempts.outboxDeliveryId, claim.deliveryId)),
      );
      assert.equal(delivery?.status, 'dead');
      assert.equal(attempt?.errorMessage, 'Outbox Worker lease expired before completion');
      assert.ok(attempt?.finishedAt);
    } finally {
      await cleanupTenant(database, tenantId);
    }
  });
});

void test('finalizes success atomically and advances only through contiguous done deliveries', async () => {
  await withDatabase(async (database) => {
    const tenantId = await insertTenant(database);
    try {
      await runEffectTestPromise(activateConsumer(database, tenantId));
      const firstMessage = await insertMessage(database, tenantId);
      const secondMessage = await insertMessage(database, tenantId);
      const registration = makeWorker('consumer.checkpoint-proof');
      const repository = makeOutboxRepository(database);
      const now = advanceDate(await runEffectTestPromise(DateTime.nowAsDate), 1000);
      await runEffectTestPromise(repository.matchUnmatched([subscriptionOf(registration)], now));
      const first = Option.getOrNull(await claimNext(repository, [registration], 'runtime-a', now));
      const second = Option.getOrNull(
        await claimNext(repository, [registration], 'runtime-b', now),
      );
      assert.ok(first);
      assert.ok(second);
      await runEffectTestPromise(repository.complete(second, advanceDate(now, 1)));
      assert.deepEqual(
        await runEffectTestPromise(
          database.select().from(workerCheckpoints).where(eq(workerCheckpoints.tenantId, tenantId)),
        ),
        [],
      );
      await runEffectTestPromise(repository.complete(first, advanceDate(now, 2)));
      const [checkpoint] = await runEffectTestPromise(
        database.select().from(workerCheckpoints).where(eq(workerCheckpoints.tenantId, tenantId)),
      );
      assert.ok(checkpoint);
      assert.equal(checkpoint.consumerName, registration.descriptor.workerKey);
      assert.equal(checkpoint.streamKey, 'producer:producer.message-created');
      assert.equal(checkpoint.lastTenantSequenceNo, secondMessage.tenantSequenceNo);
      assert.ok(checkpoint.lastTenantSequenceNo > firstMessage.tenantSequenceNo);
      const deliveries = await runEffectTestPromise(
        database
          .select()
          .from(outboxDeliveries)
          .innerJoin(
            outboxMessages,
            eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId),
          )
          .where(eq(outboxMessages.tenantId, tenantId)),
      );
      assert.equal(
        deliveries.every((row) => row.outbox_deliveries.status === 'done'),
        true,
      );
      assert.equal(
        deliveries.every((row) => row.outbox_deliveries.claimedBy === null),
        true,
      );
    } finally {
      await cleanupTenant(database, tenantId);
    }
  });
});

void test('schedules bounded retry, dead-letters exhaustion, stores safe errors, and never checkpoints failure', async () => {
  await withDatabase(async (database) => {
    const tenantId = await insertTenant(database);
    try {
      await runEffectTestPromise(activateConsumer(database, tenantId));
      await insertMessage(database, tenantId);
      const registration = makeWorker('consumer.retry-proof', { maxAttempts: 2 });
      const repository = makeOutboxRepository(database);
      const now = advanceDate(await runEffectTestPromise(DateTime.nowAsDate), 1000);
      await runEffectTestPromise(repository.matchUnmatched([subscriptionOf(registration)], now));
      const first = Option.getOrNull(await claimNext(repository, [registration], 'runtime-a', now));
      assert.ok(first);
      assert.equal(
        await runEffectTestPromise(
          repository.fail(first, ' safe\nretry\tmessage ', advanceDate(now, 1)),
        ),
        'pending',
      );
      assert.equal(
        Option.getOrNull(
          await claimNext(repository, [registration], 'runtime-b', advanceDate(now, 999)),
        ),
        null,
      );
      const second = Option.getOrNull(
        await claimNext(repository, [registration], 'runtime-b', advanceDate(now, 1001)),
      );
      assert.ok(second);
      assert.equal(
        await runEffectTestPromise(
          repository.fail(second, 'terminal safe failure', advanceDate(now, 1002)),
        ),
        'dead',
      );
      const [delivery] = await runEffectTestPromise(
        database
          .select()
          .from(outboxDeliveries)
          .where(eq(outboxDeliveries.outboxDeliveryId, second.deliveryId)),
      );
      assert.equal(delivery?.status, 'dead');
      assert.equal(delivery?.attemptsCount, 2);
      const attempts = await runEffectTestPromise(
        database
          .select()
          .from(outboxAttempts)
          .where(eq(outboxAttempts.outboxDeliveryId, second.deliveryId))
          .orderBy(asc(outboxAttempts.startedAt)),
      );
      assert.deepEqual(
        attempts.map(({ errorMessage }) => errorMessage),
        ['safe retry message', 'terminal safe failure'],
      );
      assert.deepEqual(
        await runEffectTestPromise(
          database.select().from(workerCheckpoints).where(eq(workerCheckpoints.tenantId, tenantId)),
        ),
        [],
      );
    } finally {
      await cleanupTenant(database, tenantId);
    }
  });
});

void test('keeps test descriptor arrays compatible with the erased startup registry surface', () => {
  const registry: readonly AnyOutboxWorkerRegistration[] = [makeWorker('consumer.registry-proof')];
  assert.equal(registry[0]?.descriptor.workerKey, 'consumer.registry-proof');
});
