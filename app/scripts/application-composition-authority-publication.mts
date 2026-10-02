import { eq, sql } from 'drizzle-orm';
import { Config, Context, DateTime, Duration, Effect, Layer, Option, Redacted } from 'effect';
import { isSqlError } from 'effect/unstable/sql/SqlError';

import { CoreDatabase, CoreDatabaseLive } from '../packages/core-runtime/src/db/client.ts';
import { DatabaseConfig, parseDatabaseConnectionPair } from '../packages/core-runtime/src/db/config.ts';
import { applicationCompositionAuthority } from '../packages/core-runtime/src/db/schema.ts';
import { validateActiveApplicationCompositionSnapshot } from '../packages/core-runtime/src/modules/active-application-composition.ts';
import type { ActiveApplicationCompositionSnapshot } from '../packages/core-runtime/src/modules/active-application-composition.ts';
import {
  ApplicationCompositionAuthorityError,
  closeApplicationCompositionDurableAdmission,
  drainApplicationCompositionAuthority,
  isApplicationCompositionDurableWorkDrained,
  isApplicationCompositionWorkDrained,
  markApplicationCompositionMigrationComplete,
  publishApplicationCompositionAuthority,
  resumeApplicationCompositionDurableAdmission,
  sealApplicationCompositionAuthority,
} from '../packages/core-runtime/src/modules/application-composition-authority.ts';

const unavailable = (reason: string) =>
  new ApplicationCompositionAuthorityError({ code: 'application_composition_authority_unavailable', reason });

/** Administrative publication uses the existing native pool and distinct configured database identities. */
const ApplicationCompositionAuthorityAdminDatabaseConfigLive = Layer.effect(
  DatabaseConfig,
  Effect.gen(function* applicationCompositionAuthorityAdminDatabase() {
    const [runtimeUrl, adminUrl] = yield* Effect.all([
      Config.Redacted('DATABASE_URL'),
      Config.Redacted('DATABASE_ADMIN_URL'),
    ]).pipe(Effect.mapError(() => unavailable('Administrative and runtime database configuration is required')));
    const connections = yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: Redacted.value(adminUrl),
      DATABASE_URL: Redacted.value(runtimeUrl),
    }).pipe(Effect.mapError(() => unavailable('Administrative and runtime database identities are invalid')));
    return connections.admin;
  }),
);

export const ApplicationCompositionAuthorityAdminDatabaseLive = CoreDatabaseLive.pipe(
  Layer.provide(ApplicationCompositionAuthorityAdminDatabaseConfigLive),
  Layer.catchTag('DatabaseConnectionError', () =>
    Layer.effect(CoreDatabase, Effect.fail(unavailable('The administrative Core database is unavailable'))),
  ),
);

/** Every native publisher, including retained artifact uploads, uses this same database lock. */
export const withApplicationCompositionPublicationLock = Effect.fn(
  'ApplicationCompositionAuthority.withPublicationLock',
)(function* withApplicationCompositionPublicationLock<Value, Failure, Requirements>(
  publication: Effect.Effect<Value, Failure, Requirements>,
) {
  const database = yield* CoreDatabase;
  const client = database.executor.$client;
  const publicationContext = yield* Effect.context<Requirements>();
  if (Option.isSome(Context.getOption(publicationContext, client.transactionService))) {
    return yield* unavailable('Application Composition publication must own its database transactions');
  }
  return yield* Effect.scoped(
    Effect.gen(function* serializePublication() {
      // Reserve one native session without BEGIN. Incompatible ALTER statements must not wait
      // on a table lock retained by the publication serialization transaction itself.
      const connection = yield* client.reserve;
      yield* Effect.acquireRelease(
        connection.executeValues(
          "select pg_advisory_lock(hashtextextended('ontos.application-composition-publication', 0))",
          [],
        ),
        () =>
          connection
            .executeValues(
              "select pg_advisory_unlock(hashtextextended('ontos.application-composition-publication', 0))",
              [],
            )
            .pipe(
              Effect.flatMap((rows) =>
                rows[0]?.[0] === true
                  ? Effect.void
                  : Effect.fail(unavailable('Application Composition publication lock was not released')),
              ),
              // Never return a live session with an advisory lock to its pool.
              Effect.catch((error) =>
                connection
                  .executeValues('select pg_terminate_backend(pg_backend_pid())', [])
                  .pipe(Effect.ignore, Effect.andThen(Effect.die(error))),
              ),
            ),
      );
      return yield* publication;
    }),
  ).pipe(
    Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect))),
    Effect.catchIf(isSqlError, () =>
      Effect.fail(unavailable('Application Composition database publication lock is unavailable')),
    ),
  );
});

const requireNoLegacyRuntimeTransactions = Effect.fn('ApplicationCompositionAuthority.requireQuiescentRuntime')(
  function* requireNoLegacyRuntimeTransactions() {
    const database = yield* CoreDatabase;
    const [activity] = yield* database.executor.execute<{ readonly blocked: boolean }>(
      sql`select exists(select 1 from pg_stat_activity where datname = current_database() and usename <> current_user and pid <> pg_backend_pid() and (state is distinct from 'idle' or xact_start is not null)) as blocked`,
      'objects',
    );
    if (activity === undefined || activity.blocked) {
      return yield* unavailable(
        'Initial Application Composition cutover requires all legacy runtime transactions to finish',
      );
    }
    return yield* Effect.void;
  },
);

interface CurrentApplicationCompositionAuthority {
  readonly phase: 'active' | 'draining' | 'sealed' | 'migrated';
  readonly revision: string;
  readonly validUntil: Date;
}

const prepareApplicationCompositionDrain = Effect.fn('ApplicationCompositionAuthority.prepareDrain')(
  function* prepareApplicationCompositionDrain(current: CurrentApplicationCompositionAuthority) {
    const database = yield* CoreDatabase;
    const [lease] = yield* database.executor.execute<{ readonly remaining: number }>(
      sql`select (extract(epoch from (${current.validUntil}::timestamptz - clock_timestamp())) * 1000)::double precision as remaining`,
      'objects',
    );
    if (lease === undefined || !Number.isFinite(lease.remaining) || lease.remaining <= 30_000) {
      return yield* unavailable('The old Application Composition lease must be renewed before draining');
    }
    yield* Effect.gen(function* finishOldCompositionWork() {
      if (current.phase === 'active') {
        yield* database.executor.transaction((transaction) =>
          closeApplicationCompositionDurableAdmission(transaction, current.revision),
        );
        while (
          !(yield* database.executor.transaction((transaction) =>
            isApplicationCompositionDurableWorkDrained(transaction, current.revision),
          ))
        ) {
          yield* Effect.sleep(Duration.seconds(3));
        }
        yield* database.executor.transaction((transaction) =>
          drainApplicationCompositionAuthority(transaction, current.revision),
        );
      }
      while (
        !(yield* database.executor.transaction((transaction) =>
          isApplicationCompositionWorkDrained(transaction, current.revision),
        ))
      ) {
        yield* Effect.sleep(Duration.seconds(3));
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(Math.min(Duration.toMillis(Duration.minutes(20)), lease.remaining - 30_000)),
        orElse: () =>
          Effect.fail(unavailable('Old Application Composition work did not finish within its freshness lease')),
      }),
    );
    return yield* Effect.void;
  },
);

/** An operator may reopen new durable jobs only while the same fresh release remains active. */
export const resumeApplicationCompositionDurableWork = Effect.fn('ApplicationCompositionAuthority.resumeDurableWork')(
  function* resumeApplicationCompositionDurableWork(expectedRevision: string) {
    const database = yield* CoreDatabase;
    return yield* withApplicationCompositionPublicationLock(
      database.executor.transaction((transaction) =>
        resumeApplicationCompositionDurableAdmission(transaction, expectedRevision),
      ),
    );
  },
);

/** Sealing is committed before the migration; the session lock remains held until its native callback finishes. */
export const runApplicationCompositionMigration = Effect.fn('ApplicationCompositionAuthority.migrate')(
  function* runApplicationCompositionMigration<Value, Failure, Requirements, InitialFailure, InitialRequirements>(
    migration: Effect.Effect<Value, Failure, Requirements>,
    verifyInitialCutover: Effect.Effect<void, InitialFailure, InitialRequirements>,
  ) {
    const database = yield* CoreDatabase;
    return yield* withApplicationCompositionPublicationLock(
      Effect.gen(function* migrateSealedComposition() {
        const [schema] = yield* database.executor.execute<{ readonly initialized: boolean }>(
          sql`select to_regclass('core.application_composition_authority') is not null as initialized`,
          'objects',
        );
        const current = schema?.initialized
          ? (yield* database.executor
              .select({
                phase: applicationCompositionAuthority.phase,
                revision: applicationCompositionAuthority.revision,
                validUntil: applicationCompositionAuthority.validUntil,
              })
              .from(applicationCompositionAuthority)
              .where(eq(applicationCompositionAuthority.authorityKey, 'active')))[0]
          : undefined;
        if (current === undefined) {
          yield* verifyInitialCutover;
          yield* requireNoLegacyRuntimeTransactions();
        } else if (current.phase === 'migrated') {
          return yield* unavailable(
            'The completed migration requires replacement publication before another migration',
          );
        } else if (current.phase !== 'sealed') {
          yield* prepareApplicationCompositionDrain(current);
          yield* database.executor.transaction((transaction) =>
            sealApplicationCompositionAuthority(transaction, current.revision),
          );
        }
        const value = yield* migration;
        if (current !== undefined) {
          yield* database.executor.transaction((transaction) =>
            markApplicationCompositionMigrationComplete(transaction, current.revision),
          );
        }
        return value;
      }),
    );
  },
);

/** Run before incompatible migrations; first publication repeats the same provider and transaction proof. */
export const verifyInitialApplicationCompositionPublicationEnvironment = Effect.fn(
  'ApplicationCompositionAuthority.verifyInitialEnvironment',
)(function* verifyInitialApplicationCompositionPublicationEnvironment<Failure, Requirements>(
  verifyInitialCutover: Effect.Effect<void, Failure, Requirements>,
) {
  const database = yield* CoreDatabase;
  const [schema] = yield* database.executor.execute<{ readonly initialized: boolean }>(
    sql`select to_regclass('core.application_composition_authority') is not null as initialized`,
    'objects',
  );
  if (schema?.initialized) {
    const [current] = yield* database.executor
      .select({ revision: applicationCompositionAuthority.revision })
      .from(applicationCompositionAuthority)
      .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
    if (current !== undefined) {
      return yield* Effect.void;
    }
  }
  yield* verifyInitialCutover;
  return yield* requireNoLegacyRuntimeTransactions();
});

/**
 * Draining commits before promotion, so an outstanding delivery cannot undo the write fence.
 * A separate publication lock serializes every writer through provider readback. A renewal keeps
 * owner work running during provider I/O and updates its lease only after success. A replacement
 * holds the authority lock through provider I/O; failure preserves the old admission phase.
 */
export const publishApplicationCompositionAuthoritySnapshot = Effect.fn(
  'ApplicationCompositionAuthority.publishSnapshot',
)(function* publishApplicationCompositionAuthoritySnapshot<
  Value,
  Failure,
  Requirements,
  InitialFailure,
  InitialRequirements,
>(
  snapshot: ActiveApplicationCompositionSnapshot,
  publishProviderPointer: Effect.Effect<Value, Failure, Requirements>,
  verifyInitialCutover: Effect.Effect<void, InitialFailure, InitialRequirements>,
) {
  const approved = yield* validateActiveApplicationCompositionSnapshot(snapshot).pipe(
    Effect.mapError(() => unavailable('The complete Application Composition snapshot is invalid or expired')),
  );
  const database = yield* CoreDatabase;
  const publication = Effect.gen(function* publishIndependentTransactions() {
    const [current] = yield* database.executor
      .select({
        phase: applicationCompositionAuthority.phase,
        revision: applicationCompositionAuthority.revision,
        validUntil: applicationCompositionAuthority.validUntil,
      })
      .from(applicationCompositionAuthority)
      .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
    if (current?.revision === approved.composition.revision) {
      if (DateTime.toEpochMillis(approved.validUntil) < current.validUntil.getTime()) {
        return yield* unavailable('Application Composition freshness cannot regress');
      }
      const value = yield* publishProviderPointer;
      yield* database.executor.transaction((transaction) =>
        publishApplicationCompositionAuthority(transaction, approved),
      );
      return value;
    }
    if (current === undefined) {
      // Old binaries cannot participate in the new fences. Provider quiescence is required only
      // for the first row, before any new authority or public pointer can be published.
      yield* verifyInitialCutover;
      yield* requireNoLegacyRuntimeTransactions();
    } else {
      if (DateTime.toEpochMillis(approved.validUntil) <= current.validUntil.getTime()) {
        return yield* unavailable('A replacement Application Composition needs newer freshness evidence');
      }
      if (current.phase === 'sealed') {
        return yield* unavailable('A sealed Application Composition requires a successfully completed migration');
      }
      if (current.phase !== 'migrated') {
        yield* prepareApplicationCompositionDrain(current);
      }
    }
    return yield* database.executor.transaction((transaction) =>
      Effect.gen(function* promoteAndPublish() {
        yield* publishApplicationCompositionAuthority(transaction, approved);
        return yield* publishProviderPointer;
      }),
    );
  });
  return yield* withApplicationCompositionPublicationLock(publication);
});
