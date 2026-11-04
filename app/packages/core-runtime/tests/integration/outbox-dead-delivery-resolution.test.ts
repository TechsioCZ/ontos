import { and, eq, sql } from 'drizzle-orm';
import { NodeChildProcessSpawner, NodeServices } from '@effect/platform-node';
import { Crypto, DateTime, Effect, Exit, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeCoreDatabase } from '../../src/db/client.ts';
import {
  applicationCompositionDurableWork,
  domainEvents,
  outboxDeliveries,
  outboxDeliveryResolutions,
  outboxMessages,
  tenantModuleStates,
  tenants,
} from '../../src/db/schema.ts';
import {
  closeApplicationCompositionDurableAdmission,
  drainApplicationCompositionAuthority,
  isApplicationCompositionWorkDrained,
} from '../../src/modules/application-composition-authority.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import {
  OutboxDeliveryResolutionError,
  listDeadOutboxDeliveries,
  resolveDeadOutboxDelivery,
} from '../../src/outbox/dead-delivery-resolution.ts';
import type { OutboxDeliveryResolutionInput } from '../../src/outbox/dead-delivery-resolution.ts';
import { defineOutboxWorker } from '../../src/outbox/definition.ts';
import { makeOutboxRepository } from '../../src/outbox/repository.ts';
import { makeIsolatedNativeDatabaseFixture } from '../../src/testing/isolated-native-database.ts';
import { makeNativeOutboxWorkerFixture } from '../support/outbox-worker-native-fixture.ts';

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
const secondaryWorkerKey = `${consumer}.secondary`;
const nativeServices = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));
const OPERATOR = 'operator@example.test';
const REASON = 'Order reconciled with the buyer by hand after the approval was revised';

const fails = <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
  effect.pipe(
    Effect.exit,
    Effect.map((exit) => Exit.isFailure(exit)),
  );

const fixture = Effect.gen(function* resolutionFixture() {
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'stabilization-1258-privacy-drain',
  });
  yield* isolated.migrateCoreSchema();
  const claimFixture = makeNativeOutboxWorkerFixture(workers);
  const snapshot = yield* claimFixture.authority.load;
  yield* isolated.publishInitialComposition(snapshot);
  const { executor: admin } = yield* makeCoreDatabase(isolated.connections.admin);
  const { executor: runtime } = yield* makeCoreDatabase(isolated.connections.runtime);
  const tenantId = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
  yield* runtime.insert(tenants).values({
    defaultLocale: 'en',
    name: 'Outbox dead-delivery fixture',
    slug: `dead-delivery-${tenantId}`,
    status: 'active',
    tenantId,
  });
  yield* runtime.insert(tenantModuleStates).values({ moduleKey: consumer, state: 'active', tenantId });
  const repository = makeOutboxRepository(runtime, yield* Crypto.Crypto);
  const { revision } = snapshot.composition;
  const insert = Effect.fn('DeadDeliveryTest.accept')(function* insert(marked: boolean) {
    return yield* runtime.transaction(
      Effect.fn(function* accept(transaction) {
        const [event] = yield* transaction
          .insert(domainEvents)
          .values({
            eventType: topic,
            payloadJson: {},
            producerModuleKey: producer,
            subjectModuleKey: producer,
            subjectResourceId: tenantId,
            subjectResourceType: 'dead-delivery-test',
            tenantId,
          })
          .returning({ id: domainEvents.domainEventId });
        const [message] = yield* transaction
          .insert(outboxMessages)
          .values({
            completionConsumerModuleKey: marked ? consumer : null,
            completionOriginalRevision: marked ? revision : null,
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
  });
  const debt = () => runtime.select().from(applicationCompositionDurableWork);
  const claim = Effect.fn('DeadDeliveryTest.claim')(function* claim(index: number) {
    const registration = Option.getOrThrow(Option.fromNullishOr(workers[index]));
    const now = DateTime.makeUnsafe(yield* DateTime.nowAsDate).pipe(DateTime.add({ seconds: 1 }), DateTime.toDateUtc);
    return Option.getOrThrow(
      yield* claimFixture.bind(
        [registration],
        repository.claimNext([registration], 'dead-delivery-test', now, revision),
      ),
    );
  });
  /** Matches one marked message, acknowledges the primary Worker, and dead-letters the secondary. */
  const deadTracked = Effect.fn('DeadDeliveryTest.deadTracked')(function* deadTracked() {
    const messageId = yield* insert(true);
    yield* repository.matchUnmatched(revision, yield* DateTime.nowAsDate);
    yield* repository.complete(yield* claim(0), yield* DateTime.nowAsDate);
    const second = yield* claim(1);
    expect(yield* repository.fail(second, 'Owner temporarily refused', yield* DateTime.nowAsDate)).toBe('dead');
    expect(yield* debt()).toHaveLength(1);
    return { deliveryId: second.deliveryId, messageId };
  });
  const resolution = (
    action: OutboxDeliveryResolutionInput['action'],
    messageId: string,
    overrides: Partial<OutboxDeliveryResolutionInput> = {},
  ): OutboxDeliveryResolutionInput => ({
    action,
    operatorName: OPERATOR,
    outboxMessageId: messageId,
    reason: REASON,
    tenantId,
    workerKey: secondaryWorkerKey,
    ...overrides,
  });
  const resolve = (input: OutboxDeliveryResolutionInput) =>
    admin.transaction((transaction) => resolveDeadOutboxDelivery(transaction, input));
  const refusal = (input: OutboxDeliveryResolutionInput) =>
    resolve(input).pipe(
      Effect.flip,
      Effect.map((error) => (Schema.is(OutboxDeliveryResolutionError)(error) ? error.code : 'unexpected')),
    );
  const delivery = (deliveryId: string) =>
    runtime
      .select()
      .from(outboxDeliveries)
      .where(eq(outboxDeliveries.outboxDeliveryId, deliveryId))
      .pipe(Effect.map((rows) => Option.getOrThrow(Option.fromNullishOr(rows[0]))));
  return {
    admin,
    adminUser: isolated.connections.admin.user,
    claim,
    deadTracked,
    debt,
    delivery,
    insert,
    refusal,
    repository,
    resolution,
    resolve,
    revision,
    runtime,
    tenantId,
  };
});

it.layer(nativeServices, { excludeTestServices: true })('operator resolution of dead Outbox deliveries', (suite) => {
  suite.effect('redrive returns a dead tracked delivery to pending with a fresh budget for the normal Worker', () =>
    Effect.gen(function* redrive() {
      const f = yield* fixture;
      const { deliveryId, messageId } = yield* f.deadTracked();
      expect(yield* listDeadOutboxDeliveries(f.admin, { limit: 10, trackedRevision: f.revision })).toMatchObject([
        { attemptsCount: 1, outboxMessageId: messageId, tenantId: f.tenantId, workerKey: secondaryWorkerKey },
      ]);
      const receipt = yield* f.resolve(f.resolution('redrive', messageId));
      expect(receipt).toMatchObject({
        action: 'redrive',
        deadAttemptsCount: 1,
        deliveryStatus: 'pending',
        outboxDeliveryId: deliveryId,
        recordedBy: f.adminUser,
      });
      expect(yield* f.delivery(deliveryId)).toMatchObject({ attemptsCount: 0, claimedBy: null, status: 'pending' });
      expect(yield* f.debt()).toHaveLength(1);
      // The normal Worker claims it again from attempt 1 and its real acknowledgement settles the debt.
      const retried = yield* f.claim(1);
      expect(retried.attemptNumber).toBe(1);
      yield* f.repository.complete(retried, yield* DateTime.nowAsDate);
      expect(yield* f.delivery(deliveryId)).toMatchObject({ status: 'done' });
      expect(yield* f.debt()).toEqual([]);
      expect(yield* f.runtime.select().from(outboxDeliveryResolutions)).toMatchObject([
        {
          action: 'redrive',
          deadAttemptsCount: 1,
          operatorName: OPERATOR,
          outboxDeliveryId: deliveryId,
          outboxMessageId: messageId,
          reason: REASON,
          recordedBy: f.adminUser,
          tenantId: f.tenantId,
          workerKey: secondaryWorkerKey,
        },
      ]);
      expect(yield* f.refusal(f.resolution('redrive', messageId))).toBe('outbox_delivery_not_dead');
      expect(yield* f.refusal(f.resolution('release', messageId))).toBe('outbox_delivery_not_dead');
    }),
  );

  suite.effect('release clears completion debt, records the reason, and lets the drain finish', () =>
    Effect.gen(function* release() {
      const f = yield* fixture;
      const { deliveryId, messageId } = yield* f.deadTracked();
      yield* f.admin.transaction((transaction) => closeApplicationCompositionDurableAdmission(transaction, f.revision));
      expect(
        yield* fails(
          f.admin.transaction((transaction) => drainApplicationCompositionAuthority(transaction, f.revision)),
        ),
      ).toBe(true);
      const before = yield* DateTime.nowAsDate;
      const receipt = yield* f.resolve(f.resolution('release', messageId));
      expect(receipt).toMatchObject({ action: 'release', deliveryStatus: 'released', recordedBy: f.adminUser });
      expect(receipt.recordedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
      expect(yield* f.delivery(deliveryId)).toMatchObject({ attemptsCount: 1, status: 'released' });
      expect(yield* f.debt()).toEqual([]);
      const [recorded] = yield* f.runtime
        .select()
        .from(outboxDeliveryResolutions)
        .where(eq(outboxDeliveryResolutions.outboxDeliveryId, deliveryId));
      expect(recorded).toMatchObject({ action: 'release', operatorName: OPERATOR, reason: REASON });
      expect(yield* listDeadOutboxDeliveries(f.admin, { limit: 10 })).toEqual([]);
      yield* f.admin.transaction((transaction) => drainApplicationCompositionAuthority(transaction, f.revision));
      expect(
        yield* f.admin.transaction((transaction) => isApplicationCompositionWorkDrained(transaction, f.revision)),
      ).toBe(true);
      // A released delivery is terminal: it can be neither redriven nor released again.
      expect(yield* f.refusal(f.resolution('redrive', messageId))).toBe('outbox_delivery_not_dead');
      expect(yield* f.refusal(f.resolution('release', messageId))).toBe('outbox_delivery_not_dead');
      expect(yield* f.runtime.select().from(outboxDeliveryResolutions)).toHaveLength(1);
    }),
  );

  suite.effect('refuses deliveries that are not dead and references that do not name one exact delivery', () =>
    Effect.gen(function* refuse() {
      const f = yield* fixture;
      const messageId = yield* f.insert(true);
      yield* f.repository.matchUnmatched(f.revision, yield* DateTime.nowAsDate);
      expect(yield* f.refusal(f.resolution('release', messageId))).toBe('outbox_delivery_not_dead');
      const primary = yield* f.claim(0);
      expect(yield* f.refusal(f.resolution('redrive', messageId, { workerKey: primary.workerKey }))).toBe(
        'outbox_delivery_not_dead',
      );
      yield* f.repository.complete(primary, yield* DateTime.nowAsDate);
      expect(yield* f.refusal(f.resolution('release', messageId, { workerKey: primary.workerKey }))).toBe(
        'outbox_delivery_not_dead',
      );
      const second = yield* f.claim(1);
      yield* f.repository.fail(second, 'Owner temporarily refused', yield* DateTime.nowAsDate);
      const otherTenant = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
      for (const overrides of [
        { tenantId: otherTenant },
        { workerKey: `${consumer}.missing` },
        { outboxMessageId: otherTenant },
      ]) {
        expect(yield* f.refusal(f.resolution('release', messageId, overrides))).toBe('outbox_delivery_not_found');
      }
      expect(yield* f.runtime.select().from(outboxDeliveryResolutions)).toEqual([]);
      expect(yield* f.debt()).toHaveLength(1);
    }),
  );

  suite.effect('keeps released deliveries distinguishable from acknowledgements and the ledger append-only', () =>
    Effect.gen(function* guarantees() {
      const f = yield* fixture;
      const { deliveryId, messageId } = yield* f.deadTracked();
      const [privileges] = yield* f.runtime.execute<{ readonly read: boolean; readonly write: boolean }>(
        sql`select has_table_privilege(current_user, 'core.outbox_delivery_resolutions', 'SELECT') as read,
          has_table_privilege(current_user, 'core.outbox_delivery_resolutions', 'INSERT,UPDATE,DELETE,TRUNCATE') as write`,
        'objects',
      );
      expect(privileges).toEqual({ read: true, write: false });
      const record = {
        action: 'release' as const,
        deadAttemptsCount: 0,
        operatorName: OPERATOR,
        outboxDeliveryId: deliveryId,
        outboxMessageId: messageId,
        reason: REASON,
        tenantId: f.tenantId,
        workerKey: secondaryWorkerKey,
      };
      // A runtime can neither write the ledger nor mark a dead delivery released or acknowledged.
      expect(yield* fails(f.runtime.insert(outboxDeliveryResolutions).values(record))).toBe(true);
      const setStatus = (executor: typeof f.admin, status: 'done' | 'pending' | 'released') =>
        executor.update(outboxDeliveries).set({ status }).where(eq(outboxDeliveries.outboxDeliveryId, deliveryId));
      expect(yield* fails(setStatus(f.runtime, 'released'))).toBe(true);
      expect(yield* fails(setStatus(f.runtime, 'done'))).toBe(true);
      // Even the administrator needs a recorded release for this exact delivery in the same transaction.
      expect(yield* fails(setStatus(f.admin, 'released'))).toBe(true);
      // The ledger refuses a record that does not name the exact dead delivery.
      for (const mismatch of [
        { tenantId: yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4()) },
        { workerKey: `${consumer}.primary` },
        { reason: '   ' },
      ]) {
        expect(yield* fails(f.admin.insert(outboxDeliveryResolutions).values({ ...record, ...mismatch }))).toBe(true);
      }
      expect(yield* f.delivery(deliveryId)).toMatchObject({ status: 'dead' });
      expect(yield* f.debt()).toHaveLength(1);
      // The database stamps who, when, and the attempt count; a caller cannot supply them.
      yield* f.admin
        .insert(outboxDeliveryResolutions)
        .values({ ...record, recordedBy: 'someone-else', recordedTransactionId: 'forged' });
      const [stamped] = yield* f.runtime.select().from(outboxDeliveryResolutions);
      expect(stamped).toMatchObject({ deadAttemptsCount: 1, recordedBy: f.adminUser });
      expect(stamped?.recordedTransactionId).not.toBe('forged');
      expect(yield* f.delivery(deliveryId)).toMatchObject({ status: 'released' });
      expect(yield* f.debt()).toEqual([]);
      // Released is terminal for every role, and the ledger and its delivery are immutable evidence.
      for (const status of ['dead', 'pending', 'done'] as const) {
        expect(
          yield* fails(
            f.admin.update(outboxDeliveries).set({ status }).where(eq(outboxDeliveries.outboxDeliveryId, deliveryId)),
          ),
        ).toBe(true);
      }
      expect(yield* fails(f.admin.update(outboxDeliveryResolutions).set({ reason: 'Rewritten history' }))).toBe(true);
      expect(yield* fails(f.admin.delete(outboxDeliveryResolutions))).toBe(true);
      expect(yield* fails(f.admin.execute(sql`truncate core.outbox_delivery_resolutions cascade`, 'objects'))).toBe(
        true,
      );
      expect(
        yield* fails(
          f.admin
            .delete(outboxDeliveries)
            .where(and(eq(outboxDeliveries.outboxDeliveryId, deliveryId), eq(outboxDeliveries.status, 'released'))),
        ),
      ).toBe(true);
      expect(yield* f.runtime.select().from(outboxDeliveryResolutions)).toHaveLength(1);
    }),
  );

  suite.effect('releases an untracked dead delivery without inventing completion debt', () =>
    Effect.gen(function* untracked() {
      const f = yield* fixture;
      const messageId = yield* f.insert(false);
      yield* f.repository.matchUnmatched(f.revision, yield* DateTime.nowAsDate);
      const first = yield* f.claim(0);
      expect(yield* f.repository.fail(first, 'Owner temporarily refused', yield* DateTime.nowAsDate)).toBe('dead');
      expect(yield* listDeadOutboxDeliveries(f.admin, { limit: 10, trackedRevision: f.revision })).toEqual([]);
      expect(yield* listDeadOutboxDeliveries(f.admin, { limit: 10, tenantId: f.tenantId })).toHaveLength(1);
      yield* f.resolve(f.resolution('release', messageId, { workerKey: first.workerKey }));
      expect(yield* f.delivery(first.deliveryId)).toMatchObject({ status: 'released' });
      expect(yield* f.debt()).toEqual([]);
    }),
  );
});
