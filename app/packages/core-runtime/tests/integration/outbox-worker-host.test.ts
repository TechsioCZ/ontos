import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { ConfigProvider, DateTime, Deferred, Effect, Fiber, Layer, Option, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CoreDatabaseLive, makeCoreDatabase } from '../../src/db/client.ts';
import { DatabaseConfigLive, loadDatabaseConfig } from '../../src/db/config.ts';
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
import { defineOutboxWorker, extractOutboxWorkerSubscriptions } from '../../src/outbox/definition.ts';
import { defineOutboxWorkerEntry, runOutboxWorkerHost } from '../../src/outbox/process.ts';
import { OutboxRepositoryLive } from '../../src/outbox/repository.ts';
import { OutboxRuntimeLive } from '../../src/outbox/runtime.ts';
import { purgeFixtureRows } from '../support/fixture-cleanup.ts';

const TOPIC = 'producer.host-message-created';
const MESSAGES_PER_TOPIC = 6;
const MessageKeySchema = Schema.String.pipe(Schema.brand('MessageKey'));
const payloadSchema = Schema.Struct({ messageKey: MessageKeySchema });

interface HandledDelivery {
  readonly claimId: string;
  readonly deliveryId: string;
  readonly workerKey: string;
}

interface Handled {
  readonly all: Deferred.Deferred<null>;
  readonly deliveries: Ref.Ref<readonly HandledDelivery[]>;
}

/** One consumer module's worker, recording which claim handled each delivery it received. */
const recordingWorker = (consumerModuleKey: string, handled: Handled) => {
  const workerKey = `${consumerModuleKey}.host-projector`;
  return defineOutboxWorker(
    {
      consumerModuleKey,
      entrypoint: defineTenantModuleEntrypoint({
        access: 'background',
        authorization: { kind: 'owner_local_background' },
        entrypointKey: workerKey,
        moduleKey: consumerModuleKey,
        role: 'worker',
      }),
      leaseDurationMs: 60_000,
      payloadSchema,
      producerModuleKey: 'producer',
      retryPolicy: { initialBackoffMs: 1000, maxAttempts: 3, maxBackoffMs: 4000, multiplier: 2 },
      topic: TOPIC,
      workerKey,
    },
    (_payload, context) =>
      Ref.updateAndGet(handled.deliveries, (deliveries) => [
        ...deliveries,
        { claimId: context.claimId, deliveryId: context.deliveryId, workerKey },
      ]).pipe(
        Effect.flatMap((deliveries) =>
          deliveries.length === MESSAGES_PER_TOPIC * 2 ? Deferred.succeed(handled.all, null) : Effect.void,
        ),
        Effect.asVoid,
      ),
  );
};

/**
 * Inserts one already-matched message with one pending delivery per owner. The test proves claiming, not
 * matching: a one-shot matcher here would share the global unmatched queue with concurrently running
 * integration files, whose matchers mark any unmatched message matched without this test's deliveries.
 */
const insertMatchedMessage = (
  database: CoreDatabaseExecutor,
  tenantId: string,
  workers: readonly ReturnType<typeof recordingWorker>[],
) =>
  Effect.gen(function* insertMatchedMessageEffect() {
    const messageKey = randomUUID();
    const now = yield* DateTime.nowAsDate;
    const [event] = yield* database
      .insert(domainEvents)
      .values({
        eventType: TOPIC,
        payloadJson: { messageKey },
        producerModuleKey: 'producer',
        subjectModuleKey: 'producer',
        subjectResourceId: messageKey,
        subjectResourceType: 'outbox-host-test',
        tenantId,
      })
      .returning({ domainEventId: domainEvents.domainEventId });
    const domainEventId = Option.getOrThrow(Option.fromNullishOr(event?.domainEventId));
    const [message] = yield* database
      .insert(outboxMessages)
      .values({
        domainEventId,
        matchedAt: now,
        payloadJson: { messageKey },
        producerModuleKey: 'producer',
        tenantId,
        topic: TOPIC,
      })
      .returning({ messageId: outboxMessages.outboxMessageId });
    const outboxMessageId = Option.getOrThrow(Option.fromNullishOr(message?.messageId));
    yield* database.insert(outboxDeliveries).values(
      workers.map(({ descriptor }) => ({
        availableAt: now,
        consumerModuleKey: descriptor.consumerModuleKey,
        outboxMessageId,
        workerKey: descriptor.workerKey,
      })),
    );
  });

const cleanupTenant = (database: CoreDatabaseExecutor, tenantId: string) =>
  Effect.gen(function* cleanupTenantEffect() {
    yield* database.delete(workerCheckpoints).where(eq(workerCheckpoints.tenantId, tenantId));
    const messageIds = (yield* database
      .select({ messageId: outboxMessages.outboxMessageId })
      .from(outboxMessages)
      .where(eq(outboxMessages.tenantId, tenantId))).map(({ messageId }) => messageId);
    const deliveryIds = (yield* database
      .select({ deliveryId: outboxDeliveries.outboxDeliveryId })
      .from(outboxDeliveries)
      .where(inArray(outboxDeliveries.outboxMessageId, messageIds))).map(({ deliveryId }) => deliveryId);
    yield* database.delete(outboxAttempts).where(inArray(outboxAttempts.outboxDeliveryId, deliveryIds));
    yield* database.delete(outboxDeliveries).where(inArray(outboxDeliveries.outboxMessageId, messageIds));
    yield* purgeFixtureRows([
      database.delete(outboxMessages).where(eq(outboxMessages.tenantId, tenantId)),
      database.delete(domainEvents).where(eq(domainEvents.tenantId, tenantId)),
      database.delete(tenantModuleStates).where(eq(tenantModuleStates.tenantId, tenantId)),
      database.delete(tenants).where(eq(tenants.tenantId, tenantId)),
    ]);
  });

/** Each hosted entry builds its own PostgreSQL pool, exactly as the deployed host does. */
const ownerWorkerLayer = OutboxRuntimeLive.pipe(
  Layer.provide(OutboxRepositoryLive),
  Layer.provide(CoreDatabaseLive),
  Layer.provide(DatabaseConfigLive),
);

it.live('two hosts each running both owners claim only their own deliveries under their own claim owners', () =>
  Effect.gen(function* noCrossClaiming() {
    const { executor: database } = yield* makeCoreDatabase(yield* loadDatabaseConfig());
    const suffix = randomUUID().slice(0, 8);
    const tenantId = yield* Effect.acquireRelease(
      Effect.gen(function* insertTenant() {
        const id = randomUUID();
        yield* database.insert(tenants).values({
          defaultLocale: 'en',
          name: 'Outbox Worker Host Integration',
          slug: `outbox-worker-host-${id}`,
          status: 'active',
          tenantId: id,
        });
        return id;
      }),
      (id) => cleanupTenant(database, id).pipe(Effect.orDie),
    );
    const alphaModule = `alpha${suffix}`;
    const betaModule = `beta${suffix}`;
    yield* database.insert(tenantModuleStates).values([
      { moduleKey: alphaModule, state: 'active', tenantId },
      { moduleKey: betaModule, state: 'active', tenantId },
    ]);
    const handled: Handled = {
      all: yield* Deferred.make<null>(),
      deliveries: yield* Ref.make<readonly HandledDelivery[]>([]),
    };
    const alphaWorker = recordingWorker(alphaModule, handled);
    const betaWorker = recordingWorker(betaModule, handled);
    yield* Effect.forEach(
      Array.from({ length: MESSAGES_PER_TOPIC }),
      () => insertMatchedMessage(database, tenantId, [alphaWorker, betaWorker]),
      { discard: true },
    );
    // Both owners subscribe to the same topic, so every message has one delivery per owner; each hosted
    // entry carries exactly its owner's registrations and deployed descriptor snapshot, as generated.
    const entries = [
      defineOutboxWorkerEntry({
        claimOwnerPrefix: `${alphaModule}-outbox-worker`,
        layer: ownerWorkerLayer,
        registrations: [alphaWorker],
        subscriptions: extractOutboxWorkerSubscriptions([alphaWorker]),
      }),
      defineOutboxWorkerEntry({
        claimOwnerPrefix: `${betaModule}-outbox-worker`,
        layer: ownerWorkerLayer,
        registrations: [betaWorker],
        subscriptions: extractOutboxWorkerSubscriptions([betaWorker]),
      }),
    ];
    const host = (identity: string) =>
      runOutboxWorkerHost({ entries }).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.orElse(
            ConfigProvider.fromUnknown({
              OUTBOX_WORKER_MAX_DELIVERIES: '2',
              OUTBOX_WORKER_POLL_INTERVAL_MS: '25',
              OUTBOX_WORKER_PROCESS_IDENTITY: identity,
            }),
            ConfigProvider.fromEnv(),
          ),
        ),
        Effect.forkChild,
      );
    const hosts = [yield* host('host-a'), yield* host('host-b')];

    // Every delivery handled once completes the proof; the integration test timeout bounds the wait.
    yield* Deferred.await(handled.all);
    yield* Effect.forEach(hosts, Fiber.interrupt, { discard: true });

    const deliveries = yield* database
      .select({ status: outboxDeliveries.status, workerKey: outboxDeliveries.workerKey })
      .from(outboxDeliveries)
      .innerJoin(outboxMessages, eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId))
      .where(eq(outboxMessages.tenantId, tenantId));
    expect(deliveries).toHaveLength(MESSAGES_PER_TOPIC * 2);
    // The last handled delivery may still be finalizing when the hosts stop; its lease then expires.
    expect(deliveries.filter(({ status }) => status === 'pending' || status === 'dead')).toEqual([]);
    expect(deliveries.filter(({ workerKey }) => workerKey === alphaWorker.descriptor.workerKey)).toHaveLength(
      MESSAGES_PER_TOPIC,
    );
    const records = yield* Ref.get(handled.deliveries);
    // Leases hand each delivery to exactly one claim, and only to a loop of the delivery's owner.
    expect(new Set(records.map(({ deliveryId }) => deliveryId)).size).toBe(records.length);
    expect(records).toHaveLength(MESSAGES_PER_TOPIC * 2);
    for (const { claimId, workerKey } of records) {
      const owner = workerKey === alphaWorker.descriptor.workerKey ? alphaModule : betaModule;
      expect(claimId).toMatch(new RegExp(`^${owner}-outbox-worker:host-[ab]:`, 'u'));
    }
    const claimingHosts = new Set(records.map(({ claimId }) => claimId.split(':')[1]));
    expect([...claimingHosts].every((identity) => identity === 'host-a' || identity === 'host-b')).toBe(true);
  }),
);
