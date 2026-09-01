/* eslint-disable max-lines-per-function, no-await-in-loop -- Live lifecycle scenarios are intentionally sequential and transaction-observable. */
// @effect-diagnostics asyncFunction:off globalDate:off
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { and, asc, eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
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
import { makeOutboxRepository } from '../../src/outbox/repository.ts';

const payloadSchema = Schema.Struct({ messageKey: Schema.String });

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

const withDatabase = <Value>(
  operation: (database: CoreDatabaseExecutor) => Promise<Value>,
): Promise<Value> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* databaseScope() {
        const configuration = yield* loadDatabaseConfig();
        const database = yield* makeCoreDatabase(configuration);
        return yield* Effect.promise(() => operation(database.executor));
      }),
    ),
  );

const insertTenant = async (database: CoreDatabaseExecutor): Promise<string> => {
  const tenantId = randomUUID();
  await database.insert(tenants).values({
    defaultLocale: 'en',
    name: 'Outbox Runtime Integration',
    slug: `outbox-runtime-${tenantId}`,
    status: 'active',
    tenantId,
  });
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
  const [event] = await database
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
    });
  assert.ok(event);
  const [message] = await database
    .insert(outboxMessages)
    .values({
      domainEventId: event.domainEventId,
      payloadJson: { messageKey },
      producerModuleKey: 'producer',
      tenantId,
      topic,
    })
    .returning({ messageId: outboxMessages.outboxMessageId });
  assert.ok(message);
  return { ...event, ...message };
};

const cleanupTenant = async (database: CoreDatabaseExecutor, tenantId: string): Promise<void> => {
  await database.delete(workerCheckpoints).where(eq(workerCheckpoints.tenantId, tenantId));
  const messageRows = await database
    .select({ messageId: outboxMessages.outboxMessageId })
    .from(outboxMessages)
    .where(eq(outboxMessages.tenantId, tenantId));
  for (const { messageId } of messageRows) {
    const deliveries = await database
      .select({ deliveryId: outboxDeliveries.outboxDeliveryId })
      .from(outboxDeliveries)
      .where(eq(outboxDeliveries.outboxMessageId, messageId));
    for (const { deliveryId } of deliveries) {
      await database.delete(outboxAttempts).where(eq(outboxAttempts.outboxDeliveryId, deliveryId));
    }
    await database.delete(outboxDeliveries).where(eq(outboxDeliveries.outboxMessageId, messageId));
  }
  await database.delete(outboxMessages).where(eq(outboxMessages.tenantId, tenantId));
  await database.delete(domainEvents).where(eq(domainEvents.tenantId, tenantId));
  await database.delete(tenantModuleStates).where(eq(tenantModuleStates.tenantId, tenantId));
  await database.delete(tenants).where(eq(tenants.tenantId, tenantId));
};

test('matches zero, one, or multiple exact workers once without historical backfill', async () => {
  await withDatabase(async (database) => {
    const tenantId = await insertTenant(database);
    try {
      await insertMessage(database, tenantId);
      await insertMessage(database, tenantId, 'producer.unmatched');
      const repository = makeOutboxRepository({ executor: database });
      const workers = [makeWorker('consumer.alpha'), makeWorker('consumer.beta')];

      const firstMatch = await Effect.runPromise(
        repository.matchUnmatched(workers.map(subscriptionOf), new Date('2026-08-03T10:00:00Z')),
      );
      assert.equal(firstMatch.deliveriesCreated, 2);
      assert.ok(firstMatch.messagesMatched >= 2);
      const repeatMatch = await Effect.runPromise(
        repository.matchUnmatched(workers.map(subscriptionOf), new Date('2026-08-03T10:01:00Z')),
      );
      assert.equal(repeatMatch.deliveriesCreated, 0);
      const lateWorkerMatch = await Effect.runPromise(
        repository.matchUnmatched(
          [...workers, makeWorker('consumer.late')].map(subscriptionOf),
          new Date('2026-08-03T10:02:00Z'),
        ),
      );
      assert.equal(lateWorkerMatch.deliveriesCreated, 0);
      const deliveries = await database
        .select()
        .from(outboxDeliveries)
        .innerJoin(
          outboxMessages,
          eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId),
        )
        .where(eq(outboxMessages.tenantId, tenantId));
      assert.equal(deliveries.length, 2);
      assert.deepEqual(deliveries.map((row) => row.outbox_deliveries.workerKey).toSorted(), [
        'consumer.alpha',
        'consumer.beta',
      ]);
      const messages = await database
        .select({ matchedAt: outboxMessages.matchedAt })
        .from(outboxMessages)
        .where(eq(outboxMessages.tenantId, tenantId));
      assert.equal(
        messages.every(({ matchedAt }) => matchedAt !== null),
        true,
      );
    } finally {
      await cleanupTenant(database, tenantId);
    }
  });
});

test('matches the complete subscription catalog before owner-local processes claim work', async () => {
  await withDatabase(async (database) => {
    const tenantId = await insertTenant(database);
    try {
      await activateConsumer(database, tenantId);
      await database.insert(tenantModuleStates).values({
        moduleKey: 'reporting',
        state: 'active',
        tenantId,
      });
      await insertMessage(database, tenantId);
      const consumerWorker = makeWorker('consumer.local');
      const reportingWorker = makeWorker('reporting.local', {
        consumerModuleKey: 'reporting',
      });
      const repository = makeOutboxRepository({ executor: database });
      const subscriptions = [consumerWorker, reportingWorker].map(subscriptionOf);

      const matched = await Effect.runPromise(
        repository.matchUnmatched(subscriptions, new Date('2026-08-03T10:00:00Z')),
      );
      assert.equal(matched.deliveriesCreated, 2);

      const consumerClaim = await Effect.runPromise(
        repository.claimNext([consumerWorker], 'consumer-process', new Date()),
      );
      const reportingClaim = await Effect.runPromise(
        repository.claimNext([reportingWorker], 'reporting-process', new Date()),
      );
      assert.equal(consumerClaim?.workerKey, 'consumer.local');
      assert.equal(reportingClaim?.workerKey, 'reporting.local');
    } finally {
      await cleanupTenant(database, tenantId);
    }
  });
});

test('gates claims on every non-active consumer state and permits one concurrent live claim', async () => {
  await withDatabase(async (database) => {
    const tenantId = await insertTenant(database);
    try {
      await insertMessage(database, tenantId);
      const registration = makeWorker('consumer.module-gated');
      const repository = makeOutboxRepository({ executor: database });
      await Effect.runPromise(
        repository.matchUnmatched([subscriptionOf(registration)], new Date('2026-08-03T11:00:00Z')),
      );
      const claimAt = new Date(Date.now() + 1000);
      assert.equal(
        await Effect.runPromise(repository.claimNext([registration], 'runtime-a', claimAt)),
        null,
      );
      await activateConsumer(database, tenantId, 'inactive');
      for (const state of [
        'inactive',
        'read_only',
        'suspended',
        'quarantined',
        'deprecated',
        'archived',
      ]) {
        await database
          .update(tenantModuleStates)
          .set({ state })
          .where(
            and(
              eq(tenantModuleStates.tenantId, tenantId),
              eq(tenantModuleStates.moduleKey, 'consumer'),
            ),
          );
        assert.equal(
          await Effect.runPromise(
            repository.claimNext([registration], `runtime-${state}`, claimAt),
          ),
          null,
        );
      }
      await database
        .update(tenantModuleStates)
        .set({ state: 'active' })
        .where(
          and(
            eq(tenantModuleStates.tenantId, tenantId),
            eq(tenantModuleStates.moduleKey, 'consumer'),
          ),
        );
      const claims = await Promise.all([
        Effect.runPromise(repository.claimNext([registration], 'runtime-a', claimAt)),
        Effect.runPromise(repository.claimNext([registration], 'runtime-b', claimAt)),
      ]);
      assert.equal(claims.filter((candidate) => candidate !== null).length, 1);
      const claimed = claims.find((candidate) => candidate !== null);
      assert.ok(claimed);
      const [attempt] = await database
        .select()
        .from(outboxAttempts)
        .where(eq(outboxAttempts.outboxDeliveryId, claimed.deliveryId));
      assert.ok(attempt);
      assert.equal(attempt.finishedAt, null);
    } finally {
      await cleanupTenant(database, tenantId);
    }
  });
});

test('reclaims only expired leases, abandons the old attempt, and rejects stale finalization', async () => {
  await withDatabase(async (database) => {
    const tenantId = await insertTenant(database);
    try {
      await activateConsumer(database, tenantId);
      await insertMessage(database, tenantId);
      const registration = makeWorker('consumer.lease-proof');
      const repository = makeOutboxRepository({ executor: database });
      const started = new Date(Date.now() + 1000);
      await Effect.runPromise(repository.matchUnmatched([subscriptionOf(registration)], started));
      const first = await Effect.runPromise(
        repository.claimNext([registration], 'runtime-a', started),
      );
      assert.ok(first);
      assert.equal(
        await Effect.runPromise(
          repository.claimNext([registration], 'runtime-b', new Date(started.getTime() + 999)),
        ),
        null,
      );
      const second = await Effect.runPromise(
        repository.claimNext([registration], 'runtime-b', new Date(started.getTime() + 1001)),
      );
      assert.ok(second);
      assert.notEqual(second.claimId, first.claimId);
      await assert.rejects(
        Effect.runPromise(repository.complete(first, new Date(started.getTime() + 1002))),
        (error: { readonly _tag?: string }) => error._tag === 'OutboxClaimLostError',
      );
      const attempts = await database
        .select()
        .from(outboxAttempts)
        .where(eq(outboxAttempts.outboxDeliveryId, first.deliveryId))
        .orderBy(asc(outboxAttempts.startedAt));
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0]?.errorMessage, 'Outbox Worker lease expired before completion');
      assert.ok(attempts[0]?.finishedAt);
      assert.equal(attempts[1]?.finishedAt, null);
    } finally {
      await cleanupTenant(database, tenantId);
    }
  });
});

test('finishes an abandoned final attempt before dead-lettering its expired delivery', async () => {
  await withDatabase(async (database) => {
    const tenantId = await insertTenant(database);
    try {
      await activateConsumer(database, tenantId);
      await insertMessage(database, tenantId);
      const registration = makeWorker('consumer.final-lease', { maxAttempts: 1 });
      const repository = makeOutboxRepository({ executor: database });
      const started = new Date(Date.now() + 1000);
      await Effect.runPromise(repository.matchUnmatched([subscriptionOf(registration)], started));
      const claim = await Effect.runPromise(
        repository.claimNext([registration], 'runtime-a', started),
      );
      assert.ok(claim);

      assert.equal(
        await Effect.runPromise(
          repository.claimNext([registration], 'runtime-b', new Date(started.getTime() + 1001)),
        ),
        null,
      );
      const [delivery] = await database
        .select()
        .from(outboxDeliveries)
        .where(eq(outboxDeliveries.outboxDeliveryId, claim.deliveryId));
      const [attempt] = await database
        .select()
        .from(outboxAttempts)
        .where(eq(outboxAttempts.outboxDeliveryId, claim.deliveryId));
      assert.equal(delivery?.status, 'dead');
      assert.equal(attempt?.errorMessage, 'Outbox Worker lease expired before completion');
      assert.ok(attempt?.finishedAt);
    } finally {
      await cleanupTenant(database, tenantId);
    }
  });
});

test('finalizes success atomically and advances only through contiguous done deliveries', async () => {
  await withDatabase(async (database) => {
    const tenantId = await insertTenant(database);
    try {
      await activateConsumer(database, tenantId);
      const firstMessage = await insertMessage(database, tenantId);
      const secondMessage = await insertMessage(database, tenantId);
      const registration = makeWorker('consumer.checkpoint-proof');
      const repository = makeOutboxRepository({ executor: database });
      const now = new Date(Date.now() + 1000);
      await Effect.runPromise(repository.matchUnmatched([subscriptionOf(registration)], now));
      const first = await Effect.runPromise(repository.claimNext([registration], 'runtime-a', now));
      const second = await Effect.runPromise(
        repository.claimNext([registration], 'runtime-b', now),
      );
      assert.ok(first);
      assert.ok(second);
      await Effect.runPromise(repository.complete(second, new Date(now.getTime() + 1)));
      assert.deepEqual(
        await database
          .select()
          .from(workerCheckpoints)
          .where(eq(workerCheckpoints.tenantId, tenantId)),
        [],
      );
      await Effect.runPromise(repository.complete(first, new Date(now.getTime() + 2)));
      const [checkpoint] = await database
        .select()
        .from(workerCheckpoints)
        .where(eq(workerCheckpoints.tenantId, tenantId));
      assert.ok(checkpoint);
      assert.equal(checkpoint.consumerName, registration.descriptor.workerKey);
      assert.equal(checkpoint.streamKey, 'producer:producer.message-created');
      assert.equal(checkpoint.lastTenantSequenceNo, secondMessage.tenantSequenceNo);
      assert.ok(checkpoint.lastTenantSequenceNo > firstMessage.tenantSequenceNo);
      const deliveries = await database
        .select()
        .from(outboxDeliveries)
        .innerJoin(
          outboxMessages,
          eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId),
        )
        .where(eq(outboxMessages.tenantId, tenantId));
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

test('schedules bounded retry, dead-letters exhaustion, stores safe errors, and never checkpoints failure', async () => {
  await withDatabase(async (database) => {
    const tenantId = await insertTenant(database);
    try {
      await activateConsumer(database, tenantId);
      await insertMessage(database, tenantId);
      const registration = makeWorker('consumer.retry-proof', { maxAttempts: 2 });
      const repository = makeOutboxRepository({ executor: database });
      const now = new Date(Date.now() + 1000);
      await Effect.runPromise(repository.matchUnmatched([subscriptionOf(registration)], now));
      const first = await Effect.runPromise(repository.claimNext([registration], 'runtime-a', now));
      assert.ok(first);
      assert.equal(
        await Effect.runPromise(
          repository.fail(first, ' safe\nretry\tmessage ', new Date(now.getTime() + 1)),
        ),
        'pending',
      );
      assert.equal(
        await Effect.runPromise(
          repository.claimNext([registration], 'runtime-b', new Date(now.getTime() + 999)),
        ),
        null,
      );
      const second = await Effect.runPromise(
        repository.claimNext([registration], 'runtime-b', new Date(now.getTime() + 1001)),
      );
      assert.ok(second);
      assert.equal(
        await Effect.runPromise(
          repository.fail(second, 'terminal safe failure', new Date(now.getTime() + 1002)),
        ),
        'dead',
      );
      const [delivery] = await database
        .select()
        .from(outboxDeliveries)
        .where(eq(outboxDeliveries.outboxDeliveryId, second.deliveryId));
      assert.equal(delivery?.status, 'dead');
      assert.equal(delivery?.attemptsCount, 2);
      const attempts = await database
        .select()
        .from(outboxAttempts)
        .where(eq(outboxAttempts.outboxDeliveryId, second.deliveryId))
        .orderBy(asc(outboxAttempts.startedAt));
      assert.deepEqual(
        attempts.map(({ errorMessage }) => errorMessage),
        ['safe retry message', 'terminal safe failure'],
      );
      assert.deepEqual(
        await database
          .select()
          .from(workerCheckpoints)
          .where(eq(workerCheckpoints.tenantId, tenantId)),
        [],
      );
    } finally {
      await cleanupTenant(database, tenantId);
    }
  });
});

test('keeps test descriptor arrays compatible with the erased startup registry surface', () => {
  const registry: readonly AnyOutboxWorkerRegistration[] = [makeWorker('consumer.registry-proof')];
  assert.equal(registry[0]?.descriptor.workerKey, 'consumer.registry-proof');
});
