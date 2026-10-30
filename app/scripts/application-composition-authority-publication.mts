import { eq, sql } from 'drizzle-orm';
import {
  Config,
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Redacted,
  Ref,
  Schedule,
} from 'effect';
import { isSqlError } from 'effect/sql/SqlError';

import { CoreDatabase, CoreDatabaseLive } from '../packages/core-runtime/src/db/client.ts';
import type { CoreTransaction } from '../packages/core-runtime/src/db/types.ts';
import { DatabaseConfig, parseDatabaseConnectionPair } from '../packages/core-runtime/src/db/config.ts';
import { applicationCompositionAuthority } from '../packages/core-runtime/src/db/schema.ts';
import { validateActiveApplicationCompositionSnapshot } from '../packages/core-runtime/src/modules/active-application-composition.ts';
import {
  verifyLegacyCompletionPublication,
  withLegacyCompletionOwnerLeases,
} from '../packages/core-runtime/src/modules/legacy-completion-publication-runtime.ts';
import type { LeasedLegacyCompletionOwner } from '../packages/core-runtime/src/modules/legacy-completion-publication-runtime.ts';
import {
  describeDeadOutboxDeliveries,
  listDeadOutboxDeliveries,
} from '../packages/core-runtime/src/outbox/dead-delivery-resolution.ts';
import { installApplicationCompositionCompletionSchema } from './application-composition-schema-expansion.mts';
import type { ActiveApplicationCompositionSnapshot } from '../packages/core-runtime/src/modules/active-application-composition.ts';
import {
  ApplicationCompositionAuthorityError,
  closeApplicationCompositionDurableAdmission,
  drainApplicationCompositionAuthority,
  isApplicationCompositionDurableWorkDrained,
  isApplicationCompositionWorkDrained,
  lockApplicationCompositionPublication,
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

// Live runtimes keep running short transactions, such as the Outbox matcher, so one snapshot can
// catch one in flight. Waiting for a quiet snapshot is still only an observation; owner locks fence.
const quiescenceSchedule = Schedule.spaced('100 millis').pipe(Schedule.upTo({ times: 100 }));

const requireNoLegacyRuntimeTransactions = Effect.fn('ApplicationCompositionAuthority.requireQuiescentRuntime')(
  function* requireNoLegacyRuntimeTransactions() {
    const database = yield* CoreDatabase;
    return yield* database.executor
      .execute<{ readonly blocked: boolean }>(
        sql`select exists(select 1 from pg_stat_activity where datname = current_database() and usename <> current_user and pid <> pg_backend_pid() and (state is distinct from 'idle' or xact_start is not null)) as blocked`,
        'objects',
      )
      .pipe(
        Effect.flatMap(([activity]) =>
          activity === undefined || activity.blocked
            ? Effect.fail(
                unavailable(
                  'Initial Application Composition cutover requires all legacy runtime transactions to finish',
                ),
              )
            : Effect.void,
        ),
        Effect.retry({
          schedule: quiescenceSchedule,
          while: (error) => Predicate.isTagged(error, 'ApplicationCompositionAuthorityError'),
        }),
      );
  },
);

const withVerifiedLegacyTransition = Effect.fn('ApplicationCompositionAuthority.withLegacyOwners')(
  function* withVerifiedLegacyTransition<Value, Failure, Requirements>(
    expectedRevision: string | null,
    transition: (transaction: CoreTransaction) => Effect.Effect<Value, Failure, Requirements>,
  ) {
    const database = yield* CoreDatabase;
    return yield* Effect.scoped(
      Effect.gen(function* authorityBeforeOwners() {
        const authorityReady = yield* Deferred.make<boolean>();
        const ownersReady = yield* Deferred.make<{
          readonly context: Context.Context<never>;
          readonly owners: readonly LeasedLegacyCompletionOwner[];
        }>();
        const core = yield* database.executor
          .transaction((transaction) =>
            Effect.gen(function* verifiedCoreTransition() {
              // Runtime Actions acquire authority before touching owner tables. The publisher must
              // follow the same order; an activity observation is not an admission fence.
              yield* lockApplicationCompositionPublication(transaction);
              yield* Deferred.succeed(authorityReady, true);
              const leased = yield* Deferred.await(ownersReady);
              // Native owner executors resolve their reserved transaction through Context. The
              // Core fiber predates those leases, so merge their context with its own live Core
              // transaction rather than accidentally borrowing from the owner's exhausted pool.
              const context = Context.merge(leased.context, yield* Effect.context<Requirements>());
              return yield* verifyLegacyCompletionPublication(transaction, expectedRevision, leased.owners).pipe(
                Effect.andThen(transition(transaction)),
                Effect.provideContext(context),
              );
            }),
          )
          .pipe(Effect.forkChild);
        // A failed BEGIN/lock must also wake the waiting operator, preserving the original cause.
        yield* Deferred.await(authorityReady).pipe(Effect.raceFirst(Fiber.join(core).pipe(Effect.asVoid)));
        return yield* withLegacyCompletionOwnerLeases((owners) =>
          Effect.gen(function* transferLeasedOwnerContext() {
            const context = yield* Effect.context();
            yield* Deferred.succeed(ownersReady, { context, owners });
            return yield* Fiber.join(core);
          }).pipe(
            // Cancellation must settle Core before unwinding any owner lease. On success join
            // includes COMMIT, not just the transaction callback's return.
            Effect.ensuring(Fiber.interrupt(core)),
          ),
        );
      }),
    );
  },
);

const DEAD_DELIVERY_REPORT_LIMIT = 20;

/**
 * A dead delivery never finishes by itself; only an operator redrive or release moves it. Describes
 * each one blocking this drain phase exactly as the operator command expects it, or '' when none does.
 * `trackedRevision` selects the durable-work phase; `null` the final phase, which every dead delivery blocks.
 */
const describeDeadDrainDeliveries = Effect.fn('ApplicationCompositionAuthority.describeDeadDrainDeliveries')(
  function* describeDeadDrainDeliveries(trackedRevision: string | null) {
    const database = yield* CoreDatabase;
    const filter =
      trackedRevision === null
        ? { limit: DEAD_DELIVERY_REPORT_LIMIT }
        : { limit: DEAD_DELIVERY_REPORT_LIMIT, trackedRevision };
    const dead = yield* listDeadOutboxDeliveries(database.executor, filter);
    if (dead.length === 0) {
      return '';
    }
    const scope = trackedRevision === null ? 'Dead Outbox deliveries' : 'Dead tracked Outbox deliveries';
    const more =
      dead.length === DEAD_DELIVERY_REPORT_LIMIT
        ? ` (first ${String(DEAD_DELIVERY_REPORT_LIMIT)}; \`pnpm outbox:dead-delivery list\` shows all)`
        : '';
    const commands = describeDeadOutboxDeliveries(dead);
    return `${scope} block the drain${more}; redrive or release each with \`pnpm outbox:dead-delivery\`: ${commands}`;
  },
);

/** Warns once per changed set of dead deliveries while the drain keeps waiting for an operator. */
const reportDeadDrainDeliveries = Effect.fn('ApplicationCompositionAuthority.reportDeadDrainDeliveries')(
  function* reportDeadDrainDeliveries(trackedRevision: string | null, reported: Ref.Ref<string>) {
    const described = yield* describeDeadDrainDeliveries(trackedRevision).pipe(Effect.orElseSucceed(() => ''));
    if (described !== '' && described !== (yield* Ref.getAndSet(reported, described))) {
      yield* Effect.logWarning(described);
    }
  },
);

interface CurrentApplicationCompositionAuthority {
  readonly phase: 'active' | 'draining' | 'sealed' | 'migrated';
  readonly revision: string;
  readonly validUntil: Date;
}

const prepareApplicationCompositionDrain = Effect.fn('ApplicationCompositionAuthority.prepareDrain')(
  function* prepareApplicationCompositionDrain<Failure, Requirements>(
    current: CurrentApplicationCompositionAuthority,
    verifyLegacyQuiescence: Effect.Effect<void, Failure, Requirements>,
  ) {
    const database = yield* CoreDatabase;
    const [lease] = yield* database.executor.execute<{ readonly remaining: number }>(
      sql`select (extract(epoch from (${current.validUntil}::timestamptz - clock_timestamp())) * 1000)::double precision as remaining`,
      'objects',
    );
    if (lease === undefined || !Number.isFinite(lease.remaining) || lease.remaining <= 30_000) {
      return yield* unavailable('The old Application Composition lease must be renewed before draining');
    }
    // The drain phase whose dead deliveries the timeout names: tracked debt first, then all Outbox work.
    const drainScope = yield* Ref.make<string | null>(current.revision);
    const reported = yield* Ref.make('');
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
          yield* reportDeadDrainDeliveries(current.revision, reported);
          yield* Effect.sleep(Duration.seconds(3));
        }
        // A provider receipt alone is insufficient: re-observe the actual retired executables.
        yield* verifyLegacyQuiescence;
        yield* requireNoLegacyRuntimeTransactions();
        // Owner locks remain held until the nested Core transaction actually COMMITs.
        yield* withVerifiedLegacyTransition(current.revision, (transaction) =>
          drainApplicationCompositionAuthority(transaction, current.revision),
        );
      }
      yield* Ref.set(drainScope, null);
      while (
        !(yield* database.executor.transaction((transaction) =>
          isApplicationCompositionWorkDrained(transaction, current.revision),
        ))
      ) {
        yield* reportDeadDrainDeliveries(null, reported);
        yield* Effect.sleep(Duration.seconds(3));
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(Math.min(Duration.toMillis(Duration.minutes(20)), lease.remaining - 30_000)),
        orElse: () =>
          Ref.get(drainScope).pipe(
            Effect.flatMap(describeDeadDrainDeliveries),
            Effect.orElseSucceed(() => ''),
            Effect.flatMap((described) =>
              Effect.fail(
                unavailable(
                  described === ''
                    ? 'Old Application Composition work did not finish within its freshness lease'
                    : `Old Application Composition work did not finish within its freshness lease. ${described}`,
                ),
              ),
            ),
          ),
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
        if (current !== undefined && current.phase !== 'migrated') {
          // This opt-in additive Core expansion is safe for old writers. Install and journal it
          // before the verifier selects its columns; incompatible owner DDL remains deferred.
          yield* installApplicationCompositionCompletionSchema();
        }
        if (current === undefined) {
          yield* verifyInitialCutover;
          yield* requireNoLegacyRuntimeTransactions();
        } else if (current.phase === 'migrated') {
          return yield* unavailable(
            'The completed migration requires replacement publication before another migration',
          );
        } else if (current.phase !== 'sealed') {
          yield* prepareApplicationCompositionDrain(current, verifyInitialCutover);
          yield* verifyInitialCutover;
          yield* requireNoLegacyRuntimeTransactions();
          yield* withVerifiedLegacyTransition(current.revision, (transaction) =>
            sealApplicationCompositionAuthority(transaction, current.revision),
          );
        }
        if (current?.phase === 'sealed') {
          // A recovered sealed row is not retained owner absence evidence. This transaction
          // finishes and releases owner SHARE locks before incompatible owner DDL begins.
          yield* verifyInitialCutover;
          yield* requireNoLegacyRuntimeTransactions();
          yield* withVerifiedLegacyTransition(current.revision, (transaction) =>
            transaction
              .select({
                phase: applicationCompositionAuthority.phase,
                revision: applicationCompositionAuthority.revision,
              })
              .from(applicationCompositionAuthority)
              .where(eq(applicationCompositionAuthority.authorityKey, 'active'))
              .pipe(
                Effect.flatMap((rows) =>
                  rows[0]?.revision === current.revision && rows[0].phase === 'sealed'
                    ? Effect.succeed(rows[0].revision)
                    : Effect.fail(unavailable('The recovered migration authority changed')),
                ),
              ),
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
      yield* installApplicationCompositionCompletionSchema();
    } else {
      if (DateTime.toEpochMillis(approved.validUntil) <= current.validUntil.getTime()) {
        return yield* unavailable('A replacement Application Composition needs newer freshness evidence');
      }
      if (current.phase === 'sealed') {
        return yield* unavailable('A sealed Application Composition requires a successfully completed migration');
      }
      if (current.phase !== 'migrated') {
        yield* installApplicationCompositionCompletionSchema();
        yield* prepareApplicationCompositionDrain(current, verifyInitialCutover);
      }
    }
    const promoteAndPublish = (transaction: CoreTransaction) =>
      publishApplicationCompositionAuthority(transaction, approved).pipe(Effect.andThen(publishProviderPointer));
    if (current !== undefined) {
      // A recovered row is not proof that this deployment observed legacy absence.
      yield* verifyInitialCutover;
      yield* requireNoLegacyRuntimeTransactions();
    }
    // Absence of a Core authority row does not imply absence of retained owner history.
    return yield* withVerifiedLegacyTransition(current?.revision ?? null, promoteAndPublish);
  });
  return yield* withApplicationCompositionPublicationLock(publication);
});
