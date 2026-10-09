import { randomUUID } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { DateTime, Deferred, Effect, Exit, Fiber, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeCoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { applicationCompositionAuthority, applicationCompositionDurableWork } from '../../src/db/schema.ts';
import type { CoreTransaction } from '../../src/db/types.ts';
import {
  ApplicationCompositionAuthorityError,
  drainApplicationCompositionAuthority,
} from '../../src/modules/application-composition-authority.ts';

const revision = 'd'.repeat(64);
const fixture = Effect.gen(function* durableWorkFixture() {
  const configuration = yield* loadDatabaseConnectionPair();
  const { executor: database } = yield* makeCoreDatabase(configuration.runtime);
  const { executor: adminDatabase } = yield* makeCoreDatabase(configuration.admin);
  const workId = randomUUID();
  yield* Effect.acquireRelease(Effect.void, () =>
    Effect.gen(function* removeOwnedDurableWorkFixture() {
      yield* adminDatabase
        .delete(applicationCompositionDurableWork)
        .where(inArray(applicationCompositionDurableWork.workId, [workId, `${workId}-forged`]));
      yield* adminDatabase
        .delete(applicationCompositionAuthority)
        .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
    }).pipe(Effect.orDie),
  );
  const now = yield* DateTime.nowAsDate;
  const authority = {
    authorityKey: 'active',
    phase: 'active' as const,
    revision,
    subscriptionsJson: [],
    validUntil: DateTime.makeUnsafe(now).pipe(DateTime.add({ hours: 1 }), DateTime.toDateUtc),
  };
  yield* adminDatabase.insert(applicationCompositionAuthority).values(authority).onConflictDoUpdate({
    set: authority,
    target: applicationCompositionAuthority.authorityKey,
  });
  return { adminDatabase, database, workId };
});

it.live('blocks draining while a removed owner has unfinished work and permits it after terminal reconciliation', () =>
  Effect.gen(function* blocksRemovedOwnerDurableWork() {
    const { adminDatabase, database, workId } = yield* fixture;
    const ownerModuleKey = 'removed.fixture';
    // The complete approved subscription authority intentionally has no installed owner entry.
    yield* adminDatabase.execute(
      sql`select core.track_application_composition_durable_work(${ownerModuleKey}, ${revision}, ${workId}, true)`,
      'objects',
    );
    const failure = yield* Effect.flip(
      adminDatabase.transaction((transaction) => drainApplicationCompositionAuthority(transaction, revision)),
    );
    expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
    const [active] = yield* database
      .select({ phase: applicationCompositionAuthority.phase })
      .from(applicationCompositionAuthority)
      .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
    expect(active?.phase).toBe('active');
    const pending = yield* database
      .select()
      .from(applicationCompositionDurableWork)
      .where(eq(applicationCompositionDurableWork.workId, workId));
    expect(pending).toHaveLength(1);
    yield* adminDatabase.execute(
      sql`select core.track_application_composition_durable_work(${ownerModuleKey}, ${revision}, ${workId}, false)`,
      'objects',
    );
    yield* adminDatabase.transaction((transaction) => drainApplicationCompositionAuthority(transaction, revision));
    const [drained] = yield* database
      .select({ phase: applicationCompositionAuthority.phase })
      .from(applicationCompositionAuthority)
      .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
    expect(drained?.phase).toBe('draining');
    expect(
      yield* database
        .select()
        .from(applicationCompositionDurableWork)
        .where(eq(applicationCompositionDurableWork.workId, workId)),
    ).toEqual([]);
  }),
);

it.live('prevents application runtimes from forging or clearing pending owner work', () =>
  Effect.gen(function* preventsRuntimeLedgerMutation() {
    const { adminDatabase, database, workId } = yield* fixture;
    const ownerModuleKey = 'owner.fixture';
    yield* adminDatabase.execute(
      sql`select core.track_application_composition_durable_work(${ownerModuleKey}, ${revision}, ${workId}, true)`,
      'objects',
    );
    const writeAttempts: readonly Effect.Effect<unknown, EffectDrizzleQueryError>[] = [
      database.insert(applicationCompositionDurableWork).values({
        originalRevision: revision,
        ownerModuleKey,
        workId: `${workId}-forged`,
      }),
      database
        .update(applicationCompositionDurableWork)
        .set({ originalRevision: 'e'.repeat(64) })
        .where(eq(applicationCompositionDurableWork.workId, workId)),
      database.delete(applicationCompositionDurableWork).where(eq(applicationCompositionDurableWork.workId, workId)),
      database.execute(
        sql`select core.track_application_composition_durable_work(${ownerModuleKey}, ${revision}, ${workId}, false)`,
        'objects',
      ),
    ];
    for (const attempt of writeAttempts) {
      expect(Exit.isFailure(yield* attempt.pipe(Effect.exit))).toBe(true);
    }
    const [pending] = yield* database
      .select({ originalRevision: applicationCompositionDurableWork.originalRevision })
      .from(applicationCompositionDurableWork)
      .where(
        and(
          eq(applicationCompositionDurableWork.ownerModuleKey, ownerModuleKey),
          eq(applicationCompositionDurableWork.workId, workId),
        ),
      );
    expect(pending?.originalRevision).toBe(revision);
  }),
);

it.live('serializes durable work creation before draining and rejects creation after draining', () =>
  Effect.gen(function* serializesDurableWorkCreation() {
    const { adminDatabase, database, workId } = yield* fixture;
    const ownerModuleKey = 'owner.fixture';
    const startDrain = yield* Deferred.make<null>();
    const draining = yield* Deferred.await(startDrain).pipe(
      Effect.flatMap(() =>
        adminDatabase.transaction((transaction) => drainApplicationCompositionAuthority(transaction, revision)),
      ),
      Effect.forkScoped,
    );
    yield* adminDatabase.transaction(
      Effect.fn(function* commitPendingWorkBeforeDrain(transaction: CoreTransaction) {
        yield* transaction.execute(
          sql`select core.track_application_composition_durable_work(${ownerModuleKey}, ${revision}, ${workId}, true)`,
          'objects',
        );
        const [creator] = yield* transaction.execute<{ readonly pid: number }>(
          sql`select pg_backend_pid() as pid`,
          'objects',
        );
        const creatorPid = Option.getOrThrow(Option.fromNullishOr(creator)).pid;
        yield* Deferred.succeed(startDrain, null);
        let blocked = false;
        for (let observation = 0; observation < 1000 && !blocked; observation += 1) {
          const [status] = yield* transaction.execute<{ readonly blocked: boolean }>(
            sql`select exists (
              select 1 from pg_locks
              where locktype = 'advisory' and not granted
                and ${creatorPid} = any(pg_blocking_pids(pid))
            ) as blocked`,
            'objects',
          );
          blocked = status?.blocked === true;
        }
        expect(blocked).toBe(true);
      }),
    );
    expect(Schema.is(ApplicationCompositionAuthorityError)(yield* Effect.flip(Fiber.join(draining)))).toBe(true);
    yield* adminDatabase.execute(
      sql`select core.track_application_composition_durable_work(${ownerModuleKey}, ${revision}, ${workId}, false)`,
      'objects',
    );
    yield* adminDatabase.transaction((transaction) => drainApplicationCompositionAuthority(transaction, revision));
    const attemptedCreation = yield* adminDatabase
      .execute(
        sql`select core.track_application_composition_durable_work(${ownerModuleKey}, ${revision}, ${workId}, true)`,
        'objects',
      )
      .pipe(Effect.exit);
    expect(Exit.isFailure(attemptedCreation)).toBe(true);
    expect(
      yield* database
        .select()
        .from(applicationCompositionDurableWork)
        .where(eq(applicationCompositionDurableWork.workId, workId)),
    ).toEqual([]);
  }),
);
