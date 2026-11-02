import { eq, sql } from 'drizzle-orm';
import { NodeChildProcessSpawner, NodeServices } from '@effect/platform-node';
import { Crypto, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeCoreDatabase } from '../../src/db/client.ts';
import {
  applicationCompositionAuthority,
  applicationCompositionDurableWork,
  domainEvents,
  outboxDeliveries,
  outboxMessages,
  tenantModuleStates,
  tenants,
} from '../../src/db/schema.ts';
import {
  closeApplicationCompositionDurableAdmission,
  drainApplicationCompositionAuthority,
} from '../../src/modules/application-composition-authority.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineOutboxWorker, extractOutboxWorkerSubscriptions } from '../../src/outbox/definition.ts';
import { makeOutboxRepository } from '../../src/outbox/repository.ts';
import { makeIsolatedNativeDatabaseFixture } from '../../src/testing/isolated-native-database.ts';
import { makeApplicationCompositionSnapshotFixture } from '../../src/testing/module-contract.ts';

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
const nativeServices = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const fixture = Effect.gen(function* completionFixture() {
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'stabilization-1258-privacy-drain',
  });
  yield* isolated.migrateCoreSchema();
  const snapshot = yield* makeApplicationCompositionSnapshotFixture([], 'core-outbox-completion');
  yield* isolated.publishInitialComposition(snapshot);
  const { executor: admin } = yield* makeCoreDatabase(isolated.connections.admin);
  const { executor: runtime } = yield* makeCoreDatabase(isolated.connections.runtime);
  // Core primitive tests declare actual validated test workers. Owner/public protocol proof is separate.
  yield* admin
    .update(applicationCompositionAuthority)
    .set({ subscriptionsJson: extractOutboxWorkerSubscriptions(workers) });
  const tenantId = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
  yield* runtime.insert(tenants).values({
    defaultLocale: 'en',
    name: 'Outbox completion fixture',
    slug: `completion-${tenantId}`,
    status: 'active',
    tenantId,
  });
  yield* runtime.insert(tenantModuleStates).values({ moduleKey: consumer, state: 'active', tenantId });
  const repository = makeOutboxRepository(runtime, yield* Crypto.Crypto);
  const { revision } = snapshot.composition;
  const insert = Effect.fn('CompletionTest.accept')(function* insert(
    options: { readonly marked?: boolean; readonly revision?: string; readonly target?: string } = {},
    beforeCommit?: (pid: number) => Effect.Effect<void>,
  ) {
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
            subjectResourceType: 'completion-test',
            tenantId,
          })
          .returning({ id: domainEvents.domainEventId });
        const eventId = Option.getOrThrow(Option.fromNullishOr(event)).id;
        const [message] = yield* transaction
          .insert(outboxMessages)
          .values({
            completionConsumerModuleKey: options.marked === false ? null : (options.target ?? consumer),
            completionOriginalRevision: options.marked === false ? null : (options.revision ?? revision),
            domainEventId: eventId,
            payloadJson: { id: tenantId },
            producerModuleKey: producer,
            tenantId,
            topic,
          })
          .returning({ id: outboxMessages.outboxMessageId });
        if (beforeCommit !== undefined) {
          const [backend] = yield* transaction.execute<{ readonly pid: number }>(
            sql`select pg_backend_pid() as pid`,
            'objects',
          );
          yield* beforeCommit(Option.getOrThrow(Option.fromNullishOr(backend)).pid);
        }
        return Option.getOrThrow(Option.fromNullishOr(message)).id;
      }),
    );
  });
  const debt = () => runtime.select().from(applicationCompositionDurableWork);
  const claim = Effect.fn('CompletionTest.claim')(function* claim(index: number) {
    const registration = Option.getOrThrow(Option.fromNullishOr(workers[index]));
    const now = DateTime.makeUnsafe(yield* DateTime.nowAsDate).pipe(DateTime.add({ seconds: 1 }), DateTime.toDateUtc);
    return Option.getOrThrow(yield* repository.claimNext([registration], 'completion-test', now, revision));
  });
  return { admin, claim, debt, insert, repository, revision, runtime };
});

it.layer(nativeServices, { excludeTestServices: true })('message-bound composition completion', (suite) => {
  suite.effect(
    'atomically enrolls accepted messages and waits for every intended durable acknowledgement after admission closes',
    () =>
      Effect.gen(function* acceptedCompletion() {
        const f = yield* fixture;
        const id = yield* f.insert();
        expect(yield* f.debt()).toMatchObject([
          { originalRevision: f.revision, ownerModuleKey: producer, workId: `outbox:${id}:${consumer}` },
        ]);
        yield* f.admin.transaction((transaction) =>
          closeApplicationCompositionDurableAdmission(transaction, f.revision),
        );
        expect(Exit.isFailure(yield* f.insert().pipe(Effect.exit))).toBe(true);
        expect(yield* f.runtime.select().from(domainEvents)).toHaveLength(1);
        expect(
          Exit.isFailure(
            yield* f.admin
              .transaction((transaction) => drainApplicationCompositionAuthority(transaction, f.revision))
              .pipe(Effect.exit),
          ),
        ).toBe(true);
        expect((yield* f.repository.matchUnmatched(f.revision, yield* DateTime.nowAsDate)).deliveriesCreated).toBe(2);
        const first = yield* f.claim(0);
        expect(yield* f.debt()).toHaveLength(1);
        expect(
          Exit.isFailure(
            yield* f.repository
              .complete({ ...first, claimId: 'stale-claim' }, yield* DateTime.nowAsDate)
              .pipe(Effect.exit),
          ),
        ).toBe(true);
        expect(yield* f.debt()).toHaveLength(1);
        yield* f.repository.complete(first, yield* DateTime.nowAsDate);
        expect(yield* f.debt()).toHaveLength(1);
        const second = yield* f.claim(1);
        expect(yield* f.debt()).toHaveLength(1);
        yield* f.repository.complete(second, yield* DateTime.nowAsDate);
        expect(yield* f.debt()).toEqual([]);
        expect(
          Exit.isFailure(
            yield* f.runtime
              .update(outboxDeliveries)
              .set({ status: 'pending' })
              .where(eq(outboxDeliveries.outboxDeliveryId, second.deliveryId))
              .pipe(Effect.exit),
          ),
        ).toBe(true);
        yield* f.admin.transaction((transaction) => drainApplicationCompositionAuthority(transaction, f.revision));
        const [authority] = yield* f.runtime.select().from(applicationCompositionAuthority);
        expect(authority?.phase).toBe('draining');
      }),
  );

  suite.effect(
    'serializes a real marked acceptance against admission close without losing debt or admitting a later dispatch',
    () =>
      Effect.gen(function* acceptanceCloseRace() {
        const f = yield* fixture;
        const accepted = yield* Deferred.make<number>();
        const releaseAcceptance = yield* Deferred.make<null>();
        const accepting = yield* f
          .insert({}, (pid) =>
            Deferred.succeed(accepted, pid).pipe(Effect.andThen(Deferred.await(releaseAcceptance)), Effect.asVoid),
          )
          .pipe(Effect.forkScoped);
        const creatorPid = yield* Deferred.await(accepted);
        const closing = yield* f.admin
          .transaction((transaction) => closeApplicationCompositionDurableAdmission(transaction, f.revision))
          .pipe(Effect.forkScoped);
        let blocked = false;
        for (let observation = 0; observation < 1000 && !blocked; observation += 1) {
          const [status] = yield* f.admin.execute<{ readonly blocked: boolean }>(
            sql`select exists (
          select 1 from pg_locks where locktype = 'advisory' and not granted
            and ${creatorPid} = any(pg_blocking_pids(pid))
        ) as blocked`,
            'objects',
          );
          blocked = status?.blocked === true;
        }
        expect(blocked).toBe(true);
        // Observe publication waiting on this exact uncommitted producer backend.
        yield* Deferred.succeed(releaseAcceptance, null);
        const id = yield* Fiber.join(accepting);
        yield* Fiber.join(closing);
        expect(yield* f.debt()).toMatchObject([
          { originalRevision: f.revision, ownerModuleKey: producer, workId: `outbox:${id}:${consumer}` },
        ]);
        expect(Exit.isFailure(yield* f.insert().pipe(Effect.exit))).toBe(true);
        expect(yield* f.runtime.select().from(outboxMessages)).toHaveLength(1);
        expect(yield* f.runtime.select().from(domainEvents)).toHaveLength(1);
        expect(
          Exit.isFailure(
            yield* f.admin
              .transaction((transaction) => drainApplicationCompositionAuthority(transaction, f.revision))
              .pipe(Effect.exit),
          ),
        ).toBe(true);
      }),
  );

  suite.effect('retains debt for unmatched, pending, dead, or missing intended deliveries', () =>
    Effect.gen(function* unresolvedCompletion() {
      const f = yield* fixture;
      yield* f.insert();
      expect(yield* f.debt()).toHaveLength(1);
      yield* f.repository.matchUnmatched(f.revision, yield* DateTime.nowAsDate);
      const first = yield* f.claim(0);
      yield* f.repository.complete(first, yield* DateTime.nowAsDate);
      expect(yield* f.debt()).toHaveLength(1);
      const second = yield* f.claim(1);
      expect(yield* f.repository.fail(second, 'Unresolved owner outcome', yield* DateTime.nowAsDate)).toBe('dead');
      expect(yield* f.debt()).toHaveLength(1);
      expect(
        Exit.isFailure(
          yield* f.admin
            .transaction((transaction) => drainApplicationCompositionAuthority(transaction, f.revision))
            .pipe(Effect.exit),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* f.runtime
            .delete(outboxDeliveries)
            .where(eq(outboxDeliveries.outboxDeliveryId, second.deliveryId))
            .pipe(Effect.exit),
        ),
      ).toBe(true);
    }),
  );

  suite.effect('keeps debt when an intended subscription has no delivery even after another real acknowledgement', () =>
    Effect.gen(function* missingExpectedDelivery() {
      const f = yield* fixture;
      const id = yield* f.insert();
      yield* f.runtime.insert(outboxDeliveries).values({
        consumerModuleKey: consumer,
        outboxMessageId: id,
        workerKey: Option.getOrThrow(Option.fromNullishOr(workers[0])).descriptor.workerKey,
      });
      yield* f.runtime
        .update(outboxMessages)
        .set({ matchedAt: yield* DateTime.nowAsDate })
        .where(eq(outboxMessages.outboxMessageId, id));
      const first = yield* f.claim(0);
      yield* f.repository.complete(first, yield* DateTime.nowAsDate);
      expect(yield* f.debt()).toHaveLength(1);
      expect(
        Exit.isFailure(
          yield* f.admin
            .transaction((transaction) => drainApplicationCompositionAuthority(transaction, f.revision))
            .pipe(Effect.exit),
        ),
      ).toBe(true);
    }),
  );

  suite.effect(
    'rejects foreign authority, expiry, wrong targets, metadata mutation, and generic runtime tracker access',
    () =>
      Effect.gen(function* invalidCompletion() {
        const f = yield* fixture;
        for (const options of [{ revision: 'f'.repeat(64) }, { target: 'unregistered.fixture' }]) {
          expect(Exit.isFailure(yield* f.insert(options).pipe(Effect.exit))).toBe(true);
        }
        expect(yield* f.runtime.select().from(domainEvents)).toEqual([]);
        expect(yield* f.debt()).toEqual([]);
        const id = yield* f.insert();
        expect(
          Exit.isFailure(
            yield* f.runtime
              .update(outboxMessages)
              .set({ completionConsumerModuleKey: null, completionOriginalRevision: null })
              .where(eq(outboxMessages.outboxMessageId, id))
              .pipe(Effect.exit),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* f.runtime
              .execute(
                sql`select core.track_application_composition_durable_work(${producer}, ${f.revision}, ${['outbox', id, consumer].join(':')}, false)`,
                'objects',
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true);
        yield* f.admin
          .update(applicationCompositionAuthority)
          .set({ validUntil: sql`clock_timestamp() - interval '1 minute'` });
        expect(Exit.isFailure(yield* f.insert().pipe(Effect.exit))).toBe(true);
        expect(yield* f.debt()).toHaveLength(1);
      }),
  );

  suite.effect('preserves unmarked messages and refuses to invent an original release for legacy handoffs', () =>
    Effect.gen(function* legacyCompletion() {
      const f = yield* fixture;
      const id = yield* f.insert({ marked: false });
      expect(yield* f.debt()).toEqual([]);
      expect(
        Exit.isFailure(
          yield* f.runtime
            .update(outboxMessages)
            .set({ completionConsumerModuleKey: consumer, completionOriginalRevision: f.revision })
            .where(eq(outboxMessages.outboxMessageId, id))
            .pipe(Effect.exit),
        ),
      ).toBe(true);
      yield* f.admin.transaction((transaction) => closeApplicationCompositionDurableAdmission(transaction, f.revision));
      yield* f.insert({ marked: false });
      expect(yield* f.debt()).toEqual([]);
    }),
  );
});
