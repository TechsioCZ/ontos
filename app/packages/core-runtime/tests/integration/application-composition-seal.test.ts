import { randomUUID } from 'node:crypto';

import { eq, inArray, sql } from 'drizzle-orm';
import { DateTime, Deferred, Effect, Exit, Fiber, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeCoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import {
  applicationCompositionAuthority,
  applicationCompositionDurableWork,
  domainEvents,
  outboxDeliveries,
  outboxMessages,
  tenants,
} from '../../src/db/schema.ts';
import type { CoreTransaction } from '../../src/db/types.ts';
import {
  ApplicationCompositionAuthorityError,
  closeApplicationCompositionDurableAdmission,
  drainApplicationCompositionAuthority,
  isApplicationCompositionWorkDrained,
  isApplicationCompositionDurableWorkDrained,
  lockApplicationCompositionAuthority,
  markApplicationCompositionMigrationComplete,
  publishApplicationCompositionAuthority,
  resumeApplicationCompositionDurableAdmission,
  sealApplicationCompositionAuthority,
} from '../../src/modules/application-composition-authority.ts';
import {
  freshOutboxWorkerCompositionSnapshot,
  makeOutboxWorkerComposition,
} from '../support/outbox-worker-composition.ts';

const fixture = (drain = true) =>
  Effect.gen(function* sealFixture() {
    const configuration = yield* loadDatabaseConnectionPair();
    const { executor: database } = yield* makeCoreDatabase(configuration.runtime);
    const { executor: adminDatabase } = yield* makeCoreDatabase(configuration.admin);
    const tenantId = randomUUID();
    const domainEventId = randomUUID();
    const messageId = randomUUID();
    const workId = randomUUID();
    const rejectedWorkId = randomUUID();
    const composition = makeOutboxWorkerComposition();
    const snapshot = yield* freshOutboxWorkerCompositionSnapshot(composition);
    yield* Effect.acquireRelease(Effect.void, () =>
      Effect.gen(function* cleanSealFixture() {
        yield* adminDatabase.delete(outboxDeliveries).where(eq(outboxDeliveries.outboxMessageId, messageId));
        yield* adminDatabase.delete(outboxMessages).where(eq(outboxMessages.outboxMessageId, messageId));
        yield* adminDatabase.delete(domainEvents).where(eq(domainEvents.domainEventId, domainEventId));
        yield* adminDatabase.delete(tenants).where(eq(tenants.tenantId, tenantId));
        yield* adminDatabase
          .delete(applicationCompositionDurableWork)
          .where(inArray(applicationCompositionDurableWork.workId, [workId, rejectedWorkId]));
        yield* adminDatabase
          .delete(applicationCompositionAuthority)
          .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
      }).pipe(Effect.orDie),
    );
    yield* adminDatabase.transaction((transaction) => publishApplicationCompositionAuthority(transaction, snapshot));
    yield* adminDatabase.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Before worker completion',
      slug: `composition-seal-${tenantId}`,
      status: 'active',
      tenantId,
    });
    if (drain) {
      yield* adminDatabase.transaction((transaction) =>
        closeApplicationCompositionDurableAdmission(transaction, composition.revision),
      );
      yield* adminDatabase.transaction((transaction) =>
        drainApplicationCompositionAuthority(transaction, composition.revision),
      );
    }
    return {
      adminDatabase,
      composition,
      database,
      domainEventId,
      messageId,
      rejectedWorkId,
      snapshot,
      tenantId,
      workId,
    };
  });

const expectPublicationWaiting = Effect.fn('CompositionSealTests.expectPublicationWaiting')(
  function* expectPublicationWaitingEffect(transaction: CoreTransaction, holderPid: number) {
    let blocked = false;
    for (let observation = 0; observation < 1000 && !blocked; observation += 1) {
      const [status] = yield* transaction.execute<{ readonly blocked: boolean }>(
        sql`select exists (
          select 1 from pg_locks where locktype = 'advisory' and not granted
          and ${holderPid} = any(pg_blocking_pids(pid))
        ) as blocked`,
        'objects',
      );
      blocked = status?.blocked === true;
    }
    expect(blocked).toBe(true);
  },
);

it.live('waits for the last old worker transaction before sealing and rejects every later old operation', () =>
  Effect.gen(function* sealsAfterOldWorkerCommit() {
    const { adminDatabase, composition, database, tenantId } = yield* fixture();
    const startSeal = yield* Deferred.make<null>();
    const sealing = yield* Deferred.await(startSeal).pipe(
      Effect.flatMap(() =>
        adminDatabase.transaction((transaction) =>
          sealApplicationCompositionAuthority(transaction, composition.revision),
        ),
      ),
      Effect.forkScoped,
    );
    yield* database.transaction(
      Effect.fn(function* completeOldWorker(transaction: CoreTransaction) {
        yield* lockApplicationCompositionAuthority(transaction, composition.revision, 'worker');
        yield* transaction.update(tenants).set({ name: 'Old worker committed' }).where(eq(tenants.tenantId, tenantId));
        const [worker] = yield* transaction.execute<{ readonly pid: number }>(
          sql`select pg_backend_pid() as pid`,
          'objects',
        );
        const workerPid = Option.getOrThrow(Option.fromNullishOr(worker)).pid;
        yield* Deferred.succeed(startSeal, null);
        yield* expectPublicationWaiting(transaction, workerPid);
      }),
    );
    yield* Fiber.join(sealing);
    const [owner] = yield* database.select({ name: tenants.name }).from(tenants).where(eq(tenants.tenantId, tenantId));
    expect(owner?.name).toBe('Old worker committed');
    for (const phase of ['sealed', 'migrated'] as const) {
      if (phase === 'migrated') {
        yield* adminDatabase.transaction((transaction) =>
          markApplicationCompositionMigrationComplete(transaction, composition.revision),
        );
      }
      for (const operation of ['read', 'write', 'match', 'worker'] as const) {
        const failure = yield* database
          .transaction((transaction) =>
            lockApplicationCompositionAuthority(transaction, composition.revision, operation),
          )
          .pipe(Effect.flip);
        expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
        expect(failure).toMatchObject({ reason: expect.stringMatching(/sealed/u) });
      }
    }
    expect(
      Exit.isFailure(
        yield* database.update(applicationCompositionAuthority).set({ phase: 'active' }).pipe(Effect.exit),
      ),
    ).toBe(true);
  }),
);

it.live('closes new durable admission after admitted work commits while existing jobs retain active authority', () =>
  Effect.gen(function* closesDurableAdmissionWithoutStrandingWork() {
    const { adminDatabase, composition, database, rejectedWorkId, snapshot, workId } = yield* fixture(false);
    const startClose = yield* Deferred.make<null>();
    const closing = yield* Deferred.await(startClose).pipe(
      Effect.flatMap(() =>
        adminDatabase.transaction((transaction) =>
          closeApplicationCompositionDurableAdmission(transaction, composition.revision),
        ),
      ),
      Effect.forkScoped,
    );
    yield* adminDatabase.transaction(
      Effect.fn(function* admitsWorkBeforeClosure(transaction: CoreTransaction) {
        yield* transaction.execute(
          sql`select core.track_application_composition_durable_work('seal.fixture', ${composition.revision}, ${workId}, true)`,
          'objects',
        );
        const [holder] = yield* transaction.execute<{ readonly pid: number }>(
          sql`select pg_backend_pid() as pid`,
          'objects',
        );
        const holderPid = Option.getOrThrow(Option.fromNullishOr(holder)).pid;
        yield* Deferred.succeed(startClose, null);
        yield* expectPublicationWaiting(transaction, holderPid);
      }),
    );
    yield* Fiber.join(closing);
    expect(
      yield* adminDatabase.transaction((transaction) =>
        isApplicationCompositionDurableWorkDrained(transaction, composition.revision),
      ),
    ).toBe(false);
    expect(
      Exit.isFailure(
        yield* adminDatabase
          .execute(
            sql`select core.track_application_composition_durable_work('seal.fixture', ${composition.revision}, ${rejectedWorkId}, true)`,
            'objects',
          )
          .pipe(Effect.exit),
      ),
    ).toBe(true);
    yield* adminDatabase.execute(
      sql`select core.track_application_composition_durable_work('seal.fixture', ${composition.revision}, ${workId}, true)`,
      'objects',
    );
    yield* database.transaction((transaction) =>
      lockApplicationCompositionAuthority(transaction, composition.revision, 'write'),
    );
    yield* adminDatabase.transaction((transaction) =>
      publishApplicationCompositionAuthority(transaction, {
        ...snapshot,
        validUntil: DateTime.add(snapshot.validUntil, { minutes: 1 }),
      }),
    );
    const [closedAuthority] = yield* database
      .select({
        durableWorkAdmission: applicationCompositionAuthority.durableWorkAdmission,
        phase: applicationCompositionAuthority.phase,
      })
      .from(applicationCompositionAuthority);
    expect(closedAuthority).toEqual({ durableWorkAdmission: 'closed', phase: 'active' });
    const retainedWork = yield* database.select().from(applicationCompositionDurableWork);
    expect(retainedWork.map((work) => work.workId)).toEqual([workId]);
    yield* adminDatabase.execute(
      sql`select core.track_application_composition_durable_work('seal.fixture', ${composition.revision}, ${workId}, false)`,
      'objects',
    );
    expect(
      yield* adminDatabase.transaction((transaction) =>
        isApplicationCompositionDurableWorkDrained(transaction, composition.revision),
      ),
    ).toBe(true);
    yield* adminDatabase.update(applicationCompositionAuthority).set({
      validUntil: sql`clock_timestamp() - interval '1 second'`,
    });
    expect(
      Schema.is(ApplicationCompositionAuthorityError)(
        yield* adminDatabase
          .transaction((transaction) => resumeApplicationCompositionDurableAdmission(transaction, composition.revision))
          .pipe(Effect.flip),
      ),
    ).toBe(true);
    yield* adminDatabase.transaction((transaction) => publishApplicationCompositionAuthority(transaction, snapshot));
    yield* adminDatabase.transaction((transaction) =>
      resumeApplicationCompositionDurableAdmission(transaction, composition.revision),
    );
    yield* adminDatabase.execute(
      sql`select core.track_application_composition_durable_work('seal.fixture', ${composition.revision}, ${rejectedWorkId}, true)`,
      'objects',
    );
    yield* adminDatabase.execute(
      sql`select core.track_application_composition_durable_work('seal.fixture', ${composition.revision}, ${rejectedWorkId}, false)`,
      'objects',
    );
    yield* adminDatabase.transaction((transaction) =>
      drainApplicationCompositionAuthority(transaction, composition.revision),
    );
    expect(
      Schema.is(ApplicationCompositionAuthorityError)(
        yield* adminDatabase
          .transaction((transaction) => resumeApplicationCompositionDurableAdmission(transaction, composition.revision))
          .pipe(Effect.flip),
      ),
    ).toBe(true);
  }),
);

it.live('keeps the old schema admission draining until unmatched and unfinished deliveries are resolved', () =>
  Effect.gen(function* waitsForEveryOutboxState() {
    const { adminDatabase, composition, database, domainEventId, messageId, tenantId } = yield* fixture();
    yield* adminDatabase.insert(domainEvents).values({
      domainEventId,
      eventType: 'seal.fixture.created',
      payloadJson: {},
      producerModuleKey: 'seal.fixture',
      subjectModuleKey: 'seal.fixture',
      subjectResourceId: messageId,
      subjectResourceType: 'seal-fixture',
      tenantId,
    });
    yield* adminDatabase.insert(outboxMessages).values({
      domainEventId,
      outboxMessageId: messageId,
      payloadJson: {},
      producerModuleKey: 'seal.fixture',
      tenantId,
      topic: 'seal.fixture.created',
    });
    expect(
      yield* adminDatabase.transaction((transaction) =>
        isApplicationCompositionWorkDrained(transaction, composition.revision),
      ),
    ).toBe(false);
    expect(
      Schema.is(ApplicationCompositionAuthorityError)(
        yield* adminDatabase
          .transaction((transaction) => sealApplicationCompositionAuthority(transaction, composition.revision))
          .pipe(Effect.flip),
      ),
    ).toBe(true);
    yield* adminDatabase
      .update(outboxMessages)
      .set({ matchedAt: yield* DateTime.nowAsDate })
      .where(eq(outboxMessages.outboxMessageId, messageId));
    yield* adminDatabase
      .insert(outboxDeliveries)
      .values({ consumerModuleKey: 'seal.consumer', outboxMessageId: messageId, workerKey: 'seal.consumer.worker' });
    for (const status of ['pending', 'processing', 'dead'] as const) {
      yield* adminDatabase
        .update(outboxDeliveries)
        .set({ status })
        .where(eq(outboxDeliveries.outboxMessageId, messageId));
      expect(
        Schema.is(ApplicationCompositionAuthorityError)(
          yield* adminDatabase
            .transaction((transaction) => sealApplicationCompositionAuthority(transaction, composition.revision))
            .pipe(Effect.flip),
        ),
      ).toBe(true);
      const [authority] = yield* database
        .select({ phase: applicationCompositionAuthority.phase })
        .from(applicationCompositionAuthority);
      expect(authority?.phase).toBe('draining');
    }
    yield* adminDatabase
      .update(outboxDeliveries)
      .set({ status: 'done' })
      .where(eq(outboxDeliveries.outboxMessageId, messageId));
    expect(
      yield* adminDatabase.transaction((transaction) =>
        isApplicationCompositionWorkDrained(transaction, composition.revision),
      ),
    ).toBe(true);
    yield* adminDatabase.transaction((transaction) =>
      sealApplicationCompositionAuthority(transaction, composition.revision),
    );
  }),
);

it.live('preserves migration retirement through renewal and permits replacement only after successful migration', () =>
  Effect.gen(function* preservesSealedRenewal() {
    const { adminDatabase, composition, database, snapshot } = yield* fixture();
    yield* adminDatabase.transaction((transaction) =>
      sealApplicationCompositionAuthority(transaction, composition.revision),
    );
    const renewed = { ...snapshot, validUntil: DateTime.add(snapshot.validUntil, { minutes: 1 }) };
    yield* adminDatabase.transaction((transaction) => publishApplicationCompositionAuthority(transaction, renewed));
    const [authority] = yield* database
      .select({ phase: applicationCompositionAuthority.phase, validUntil: applicationCompositionAuthority.validUntil })
      .from(applicationCompositionAuthority);
    expect(authority?.phase).toBe('sealed');
    expect(authority?.validUntil.getTime()).toBe(DateTime.toEpochMillis(renewed.validUntil));
    expect(
      Schema.is(ApplicationCompositionAuthorityError)(
        yield* adminDatabase
          .transaction((transaction) => drainApplicationCompositionAuthority(transaction, composition.revision))
          .pipe(Effect.flip),
      ),
    ).toBe(true);
    const replacement = makeOutboxWorkerComposition([{ appId: 'seal-release-app', moduleId: 'seal.release' }]);
    const replacementSnapshot = {
      ...(yield* freshOutboxWorkerCompositionSnapshot(replacement)),
      validUntil: DateTime.add(renewed.validUntil, { minutes: 1 }),
    };
    expect(
      Schema.is(ApplicationCompositionAuthorityError)(
        yield* adminDatabase
          .transaction((transaction) => publishApplicationCompositionAuthority(transaction, replacementSnapshot))
          .pipe(Effect.flip),
      ),
    ).toBe(true);
    const [afterFailedReplacement] = yield* database
      .select({ phase: applicationCompositionAuthority.phase, revision: applicationCompositionAuthority.revision })
      .from(applicationCompositionAuthority);
    expect(afterFailedReplacement).toEqual({ phase: 'sealed', revision: composition.revision });
    yield* adminDatabase.transaction((transaction) =>
      markApplicationCompositionMigrationComplete(transaction, composition.revision),
    );
    yield* adminDatabase.transaction((transaction) => publishApplicationCompositionAuthority(transaction, renewed));
    const [renewedMigrated] = yield* database
      .select({ phase: applicationCompositionAuthority.phase })
      .from(applicationCompositionAuthority);
    expect(renewedMigrated?.phase).toBe('migrated');
    yield* adminDatabase.transaction((transaction) =>
      publishApplicationCompositionAuthority(transaction, replacementSnapshot),
    );
    const [replacementAuthority] = yield* database
      .select({
        durableWorkAdmission: applicationCompositionAuthority.durableWorkAdmission,
        phase: applicationCompositionAuthority.phase,
        revision: applicationCompositionAuthority.revision,
      })
      .from(applicationCompositionAuthority);
    expect(replacementAuthority).toEqual({
      durableWorkAdmission: 'open',
      phase: 'active',
      revision: replacement.revision,
    });
    yield* database.transaction((transaction) =>
      lockApplicationCompositionAuthority(transaction, replacement.revision, 'read'),
    );
    expect(
      Schema.is(ApplicationCompositionAuthorityError)(
        yield* database
          .transaction((transaction) =>
            lockApplicationCompositionAuthority(transaction, composition.revision, 'worker'),
          )
          .pipe(Effect.flip),
      ),
    ).toBe(true);
  }),
);
