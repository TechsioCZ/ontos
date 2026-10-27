import { eq, sql } from 'drizzle-orm';
import { Clock, Config, Context, DateTime, Duration, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { isSqlError } from 'effect/sql/SqlError';

import { CoreDatabase, CoreDatabaseLive } from '../packages/core-runtime/src/db/client.ts';
import { DatabaseConfig, parseDatabaseConnectionPair } from '../packages/core-runtime/src/db/config.ts';
import {
  applicationCompositionAuthority,
  applicationCompositionDurableWork,
  outboxDeliveries,
  outboxMessages,
} from '../packages/core-runtime/src/db/schema.ts';
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

import { settleParkedEnrollmentPublicationWork } from '../verticals/commerce-customer-context/scripts/enrollment-publication-accounting.mts';

const unavailable = (reason: string) =>
  new ApplicationCompositionAuthorityError({ code: 'application_composition_authority_unavailable', reason });

const AUTHORITY_MISSING = 'authority-missing';
const DURABLE_DRAIN = 'durable-drain';
const DIAGNOSTIC_TIMEOUT = 'diagnostic-timeout';
const DIAGNOSTIC_UNAVAILABLE = 'diagnostic-unavailable';

/** Phase ceilings do not extend the existing twenty-minute migration envelope. */
export const APPLICATION_COMPOSITION_PUBLICATION_BUDGETS = {
  diagnosticMs: 50_000,
  drainMs: 300_000,
  migrationMs: 840_000,
  totalMs: 1_200_000,
} as const;

export class ApplicationCompositionPublicationTimeout extends Schema.TaggedError<ApplicationCompositionPublicationTimeout>()(
  'ApplicationCompositionPublicationTimeout',
  {
    authorityPhase: Schema.Literals(['active', 'draining', 'sealed', 'migrated', 'absent', 'unknown']),
    budgetMs: Schema.Number,
    message: Schema.String,
    migrationsCompleted: Schema.Boolean,
    migrationStarted: Schema.Boolean,
    phase: Schema.Literals([
      'publication-lock',
      'close-admission',
      DURABLE_DRAIN,
      'enter-draining',
      'outbox-drain',
      'seal',
      'migration',
      'migration-complete',
    ]),
  },
) {}

type PublicationState = {
  -readonly [
    Key in 'authorityPhase' | 'migrationStarted' | 'migrationsCompleted' | 'phase'
  ]: ApplicationCompositionPublicationTimeout[Key];
};

export interface ApplicationCompositionMigrationBudgets {
  readonly drainMs?: number;
  readonly migrationMs?: number;
  readonly totalMs?: number;
}

const validBudget = (budgetMs: number, ceilingMs: number) =>
  Number.isSafeInteger(budgetMs) && budgetMs > 0 && budgetMs <= ceilingMs;

export const ApplicationCompositionReadinessSchema = Schema.Struct({
  advisoryOnly: Schema.Literal(true),
  authority: Schema.optionalKey(
    Schema.Struct({
      durableWorkAdmission: Schema.Literals(['open', 'closed']),
      phase: Schema.Literals(['active', 'draining', 'sealed', 'migrated']),
      revision: Schema.String,
    }),
  ),
  /** Counts are capped at eleven. Eleven means at least eleven, not an exact total. */
  blockers: Schema.optionalKey(
    Schema.Struct({ deliveries: Schema.Number, durable: Schema.Number, messages: Schema.Number }),
  ),
  reason: Schema.Literals([
    'drained',
    'pending-work',
    'authority-expired',
    'authority-sealed',
    'replacement-publication-required',
    AUTHORITY_MISSING,
    DIAGNOSTIC_TIMEOUT,
    DIAGNOSTIC_UNAVAILABLE,
  ]),
  status: Schema.Literals(['ready', 'blocked', 'unknown']),
});
export type ApplicationCompositionReadiness = typeof ApplicationCompositionReadinessSchema.Type;

const unknownReadiness = (
  reason: typeof DIAGNOSTIC_TIMEOUT | typeof DIAGNOSTIC_UNAVAILABLE,
): ApplicationCompositionReadiness => ({ advisoryOnly: true, reason, status: 'unknown' });

/** Wrap provisioning as well as reads at the CLI boundary. Unknown never grants migration admission. */
export const withApplicationCompositionReadinessDeadline = <Failure, Requirements>(
  check: Effect.Effect<ApplicationCompositionReadiness, Failure, Requirements>,
  budgetMs = APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.diagnosticMs,
) =>
  check.pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(
        validBudget(budgetMs, APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.diagnosticMs) ? budgetMs : 1,
      ),
      orElse: () => Effect.succeed(unknownReadiness(DIAGNOSTIC_TIMEOUT)),
    }),
    Effect.matchEffect({
      onFailure: () => Effect.succeed(unknownReadiness(DIAGNOSTIC_UNAVAILABLE)),
      onSuccess: Effect.succeed,
    }),
    Effect.catchDefect((defect) =>
      isSqlError(defect) ? Effect.succeed(unknownReadiness(DIAGNOSTIC_UNAVAILABLE)) : Effect.die(defect),
    ),
  );

/** Advisory SELECTs only: no lock, settlement, renewal, admission write, or native drain transition. */
export const readApplicationCompositionReadiness = Effect.gen(function* readPublicationReadiness() {
  const database = yield* CoreDatabase;
  const [schema] = yield* database.executor.execute<{ readonly initialized: boolean }>(
    sql`select to_regclass('core.application_composition_authority') is not null as initialized`,
    'objects',
  );
  if (!schema?.initialized) {
    return {
      advisoryOnly: true,
      reason: AUTHORITY_MISSING,
      status: 'unknown',
    } satisfies ApplicationCompositionReadiness;
  }
  // One statement observes authority and the global durable/outbox predicate in one snapshot.
  const [row] = yield* database.executor.execute<{
    readonly admission: 'open' | 'closed';
    readonly deliveries: number;
    readonly durable: number;
    readonly fresh: boolean;
    readonly messages: number;
    readonly phase: 'active' | 'draining' | 'sealed' | 'migrated';
    readonly revision: string;
  }>(
    sql`select phase, revision, durable_work_admission as admission,
    valid_until > clock_timestamp() as fresh,
    (select count(*)::integer from (select 1 from ${applicationCompositionDurableWork} limit 11) d) as durable,
    (select count(*)::integer from (select 1 from ${outboxMessages} where matched_at is null limit 11) m) as messages,
    (select count(*)::integer from (select 1 from ${outboxDeliveries} where status <> 'done' limit 11) d) as deliveries
    from ${applicationCompositionAuthority} where authority_key = 'active'`,
    'objects',
  );
  if (row === undefined) {
    return {
      advisoryOnly: true,
      reason: AUTHORITY_MISSING,
      status: 'unknown',
    } satisfies ApplicationCompositionReadiness;
  }
  const result = {
    authority: { durableWorkAdmission: row.admission, phase: row.phase, revision: row.revision },
    blockers: { deliveries: row.deliveries, durable: row.durable, messages: row.messages },
  };
  let reason: ApplicationCompositionReadiness['reason'] = 'drained';
  if (row.phase === 'migrated') {
    reason = 'replacement-publication-required';
  } else if (row.phase === 'sealed') {
    reason = 'authority-sealed';
  } else if (!row.fresh) {
    reason = 'authority-expired';
  } else if (row.durable + row.messages + row.deliveries > 0) {
    reason = 'pending-work';
  }
  return {
    ...result,
    advisoryOnly: true,
    reason,
    status: reason === 'drained' ? 'ready' : 'blocked',
  } satisfies ApplicationCompositionReadiness;
});

/** Logs only controlled phase names and explicit blocker metadata, never request bodies or credentials. */
export const withApplicationCompositionPublicationProgress = <
  Value,
  Failure,
  Requirements,
  ProgressRequirements = never,
>(
  phase: string,
  operation: Effect.Effect<Value, Failure, Requirements>,
  progress?: Effect.Effect<void, never, ProgressRequirements>,
) =>
  Effect.gen(function* publicationProgress() {
    yield* Effect.logInfo('Application Composition publication started', { phase });
    const report = Effect.logInfo('Application Composition publication waiting', { phase }).pipe(
      Effect.andThen(progress ?? Effect.void),
    );
    const value = yield* Effect.raceFirst(
      operation,
      Effect.forever(Effect.sleep(Duration.seconds(30)).pipe(Effect.andThen(report))),
    );
    yield* Effect.logInfo('Application Composition publication completed', { phase });
    return value;
  });

/** Ten oldest identifiers per blocker category bound logs without exposing business payloads. */
export const logApplicationCompositionDrainBlockers = Effect.gen(function* describeDrainBlockers() {
  const database = yield* CoreDatabase;
  const [blockers] = yield* database.executor.execute<{
    readonly deliveries: unknown;
    readonly durable: unknown;
    readonly messages: unknown;
  }>(
    sql`select
      (select coalesce(json_agg(b), '[]'::json) from (
        select owner_module_key, original_revision, work_id, created_at
        from ${applicationCompositionDurableWork} order by created_at, owner_module_key, work_id limit 10
      ) b) as durable,
      (select coalesce(json_agg(b), '[]'::json) from (
        select outbox_message_id, producer_module_key, topic, created_at
        from ${outboxMessages} where matched_at is null order by created_at, outbox_message_id limit 10
      ) b) as messages,
      (select coalesce(json_agg(b), '[]'::json) from (
        select outbox_delivery_id, outbox_message_id, worker_key, consumer_module_key, status,
          attempts_count, available_at, claim_expires_at
        from ${outboxDeliveries} where status <> 'done' order by created_at, outbox_delivery_id limit 10
      ) b) as deliveries`,
    'objects',
  );
  yield* Effect.logInfo('Application Composition drain blockers (up to 10 oldest per category)', blockers);
}).pipe(
  Effect.timeout(Duration.seconds(5)),
  Effect.matchEffect({
    onFailure: () => Effect.logWarning('Application Composition drain blocker diagnostics unavailable'),
    onSuccess: () => Effect.void,
  }),
);

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

/** One session-level advisory lock, held on a reserved native session for exactly the given effect. */
const withSessionAdvisoryLock = Effect.fn('ApplicationCompositionAuthority.withSessionAdvisoryLock')(
  function* withSessionAdvisoryLock<Value, Failure, Requirements>(
    lock: { readonly key: string; readonly params: readonly string[] },
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
        let acquired = false;
        // Register cleanup before the interruptible lock query. Even if cancellation races with
        // PostgreSQL granting the lock, unlock/readback runs on this same reserved session.
        yield* Effect.acquireRelease(Effect.void, () =>
          connection.executeValues(`select pg_advisory_unlock(${lock.key})`, [...lock.params]).pipe(
            Effect.flatMap((rows) =>
              rows[0]?.[0] === true || (!acquired && rows[0]?.[0] === false)
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
        yield* withApplicationCompositionPublicationProgress(
          'acquire publication serialization lock',
          connection.executeValues(`select pg_advisory_lock(${lock.key})`, [...lock.params]),
        );
        acquired = true;
        return yield* publication;
      }),
    ).pipe(
      Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect))),
      Effect.catchIf(isSqlError, () =>
        Effect.fail(unavailable('Application Composition database publication lock is unavailable')),
      ),
    );
  },
);

/** Every composition publisher and Shell artifact upload uses this same environment-wide database lock. */
export const withApplicationCompositionPublicationLock = <Value, Failure, Requirements>(
  publication: Effect.Effect<Value, Failure, Requirements>,
) =>
  withSessionAdvisoryLock(
    { key: "hashtextextended('ontos.application-composition-publication', 0)", params: [] },
    publication,
  );

/**
 * An immutable application release upload registers nothing in the database, so distinct releases upload in
 * parallel. Only the same release identity is serialized, keeping its absence check, upload and readback atomic.
 */
export const withImmutableApplicationReleaseIdentityLock =
  (releaseIdentity: string) =>
  <Value, Failure, Requirements>(upload: Effect.Effect<Value, Failure, Requirements>) =>
    withSessionAdvisoryLock(
      { key: 'hashtextextended($1, 0)', params: [`ontos.immutable-application-release:${releaseIdentity}`] },
      upload,
    );

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

const waitForDurablePublicationWork = Effect.fn('ApplicationCompositionAuthority.waitForDurableWork')(
  function* waitForDurablePublicationWork(revision: string) {
    const database = yield* CoreDatabase;
    while (
      !(yield* database.executor.transaction((transaction) =>
        // Settlement is confined to the lock-owning mutating path, never the diagnostic reader.
        settleParkedEnrollmentPublicationWork(transaction, revision).pipe(
          Effect.andThen(isApplicationCompositionDurableWorkDrained(transaction, revision)),
        ),
      ))
    ) {
      yield* Effect.sleep(Duration.seconds(3));
    }
  },
);

const waitForOutboxPublicationWork = Effect.fn('ApplicationCompositionAuthority.waitForOutboxWork')(
  function* waitForOutboxPublicationWork(revision: string) {
    const database = yield* CoreDatabase;
    while (
      !(yield* database.executor.transaction((transaction) =>
        isApplicationCompositionWorkDrained(transaction, revision),
      ))
    ) {
      yield* Effect.sleep(Duration.seconds(3));
    }
  },
);

const prepareApplicationCompositionDrain = Effect.fn('ApplicationCompositionAuthority.prepareDrain')(
  function* prepareApplicationCompositionDrain(
    current: CurrentApplicationCompositionAuthority,
    budgetMs: number = APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.drainMs,
    state?: PublicationState,
  ) {
    const progressState: PublicationState = state ?? {
      authorityPhase: current.phase,
      migrationsCompleted: false,
      migrationStarted: false,
      phase: DURABLE_DRAIN,
    };
    const timeout = () =>
      Effect.fail(
        new ApplicationCompositionPublicationTimeout({
          ...progressState,
          budgetMs,
          message:
            'The bounded drain deadline expired; pending work is not proof of a dead owner. The migration did not start and admission was not reopened.',
        }),
      );
    return yield* Effect.gen(function* boundedDrain() {
      const database = yield* CoreDatabase;
      progressState.phase = DURABLE_DRAIN;
      const [lease] = yield* database.executor.execute<{ readonly remaining: number }>(
        sql`select (extract(epoch from (${current.validUntil}::timestamptz - clock_timestamp())) * 1000)::double precision as remaining`,
        'objects',
      );
      if (lease === undefined || !Number.isFinite(lease.remaining) || lease.remaining <= 30_000) {
        return yield* unavailable('The old Application Composition lease must be renewed before draining');
      }
      yield* Effect.gen(function* finishOldCompositionWork() {
        if (current.phase === 'active') {
          progressState.phase = 'close-admission';
          yield* withApplicationCompositionPublicationProgress(
            'close durable admission (authority fence)',
            database.executor.transaction((transaction) =>
              closeApplicationCompositionDurableAdmission(transaction, current.revision),
            ),
          );
          progressState.phase = DURABLE_DRAIN;
          yield* withApplicationCompositionPublicationProgress(
            'drain durable workflows',
            waitForDurablePublicationWork(current.revision),
            logApplicationCompositionDrainBlockers,
          );
          progressState.phase = 'enter-draining';
          yield* withApplicationCompositionPublicationProgress(
            'enter draining (authority fence)',
            database.executor.transaction((transaction) =>
              drainApplicationCompositionAuthority(transaction, current.revision),
            ),
          );
        }
        progressState.authorityPhase = 'draining';
        progressState.phase = 'outbox-drain';
        yield* withApplicationCompositionPublicationProgress(
          'drain unmatched messages and unfinished deliveries',
          waitForOutboxPublicationWork(current.revision),
          logApplicationCompositionDrainBlockers,
        );
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(Math.max(1, lease.remaining - 30_000)),
          orElse: timeout,
        }),
      );
      return yield* Effect.void;
    }).pipe(Effect.timeoutOrElse({ duration: Duration.millis(budgetMs), orElse: timeout }));
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

/** Checks a completed migration without changing authority or running another migration. */
export const verifyMigratedApplicationCompositionForPublication = Effect.fn(
  'ApplicationCompositionAuthority.verifyMigratedForPublication',
)(function* verifyMigratedForPublication(expectedRevision: string) {
  if (!/^[a-f0-9]{64}$/u.test(expectedRevision)) {
    return yield* unavailable('An exact retired Application Composition revision is required');
  }
  const database = yield* CoreDatabase;
  return yield* withApplicationCompositionPublicationLock(
    Effect.gen(function* verifyCompletedMigrationAuthority() {
      const [schema] = yield* database.executor.execute<{ readonly initialized: boolean }>(
        sql`select to_regclass('core.application_composition_authority') is not null as initialized`,
        'objects',
      );
      if (!schema?.initialized) {
        return yield* unavailable('Replacement publication requires an existing migrated authority');
      }
      const [current] = yield* database.executor
        .select({
          durableWorkAdmission: applicationCompositionAuthority.durableWorkAdmission,
          phase: applicationCompositionAuthority.phase,
          revision: applicationCompositionAuthority.revision,
        })
        .from(applicationCompositionAuthority)
        .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
      if (
        current?.phase !== 'migrated' ||
        current.revision !== expectedRevision ||
        current.durableWorkAdmission !== 'closed'
      ) {
        return yield* unavailable('Replacement publication requires the exact migrated and closed retired authority');
      }
      return yield* Effect.void;
    }),
  );
});

/** Sealing is committed before the migration; the session lock remains held until its native callback finishes. */
export const runApplicationCompositionMigration = Effect.fn('ApplicationCompositionAuthority.migrate')(
  function* runApplicationCompositionMigration<Value, Failure, Requirements, InitialFailure, InitialRequirements>(
    migration: Effect.Effect<Value, Failure, Requirements>,
    verifyInitialCutover: Effect.Effect<void, InitialFailure, InitialRequirements>,
    budgets: ApplicationCompositionMigrationBudgets = {},
  ) {
    const drainMs = budgets.drainMs ?? APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.drainMs;
    const migrationMs = budgets.migrationMs ?? APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.migrationMs;
    const totalMs = budgets.totalMs ?? APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.totalMs;
    if (
      !validBudget(drainMs, APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.totalMs) ||
      !validBudget(migrationMs, APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.totalMs) ||
      !validBudget(totalMs, APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.totalMs)
    ) {
      return yield* unavailable(
        'Publication budgets must be positive millisecond integers within the existing twenty-minute ceiling',
      );
    }
    const startedAt = yield* Clock.currentTimeMillis;
    const deadline = startedAt + totalMs;
    const state: PublicationState = {
      authorityPhase: 'unknown',
      migrationsCompleted: false,
      migrationStarted: false,
      phase: 'publication-lock',
    };
    const timeout = (budgetMs: number) =>
      Effect.fail(
        new ApplicationCompositionPublicationTimeout({
          ...state,
          budgetMs,
          message:
            'The publication phase deadline expired; pending work is not proof of a dead owner. Authority completion is uncertain; admission was not reopened. Inspect native state before retrying.',
        }),
      );
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
        state.authorityPhase = current?.phase ?? 'absent';
        if (current === undefined) {
          yield* verifyInitialCutover;
          yield* requireNoLegacyRuntimeTransactions();
        } else if (current.phase === 'migrated') {
          return yield* unavailable(
            'The completed migration requires replacement publication before another migration',
          );
        } else if (current.phase !== 'sealed') {
          const remainingDrainMs = Math.max(1, Math.min(drainMs, deadline - (yield* Clock.currentTimeMillis)));
          state.phase = DURABLE_DRAIN;
          yield* prepareApplicationCompositionDrain(current, remainingDrainMs, state);
          state.phase = 'seal';
          yield* database.executor.transaction((transaction) =>
            sealApplicationCompositionAuthority(transaction, current.revision),
          );
          state.authorityPhase = 'sealed';
        }
        state.phase = 'migration';
        const remainingMs = Math.min(migrationMs, deadline - (yield* Clock.currentTimeMillis));
        if (remainingMs <= 0) {
          return yield* timeout(totalMs);
        }
        state.migrationStarted = true;
        const value = yield* migration.pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(remainingMs),
            orElse: () => timeout(remainingMs),
          }),
        );
        state.migrationsCompleted = true;
        state.phase = 'migration-complete';
        if (current !== undefined) {
          yield* database.executor.transaction((transaction) =>
            markApplicationCompositionMigrationComplete(transaction, current.revision),
          );
          state.authorityPhase = 'migrated';
        }
        return value;
      }),
    ).pipe(
      Effect.timeoutOrElse({ duration: Duration.millis(totalMs), orElse: () => timeout(totalMs) }),
      Effect.onInterrupt(() =>
        Effect.logWarning('Application Composition migration interrupted; inspect native state before retrying', {
          ...state,
        }),
      ),
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
      yield* withApplicationCompositionPublicationProgress(
        'renew native authority',
        database.executor.transaction((transaction) => publishApplicationCompositionAuthority(transaction, approved)),
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
    return yield* withApplicationCompositionPublicationProgress(
      'promote native authority and publish provider pointer',
      database.executor.transaction((transaction) =>
        Effect.gen(function* promoteAndPublish() {
          yield* publishApplicationCompositionAuthority(transaction, approved);
          return yield* publishProviderPointer;
        }),
      ),
    );
  });
  return yield* withApplicationCompositionPublicationLock(publication);
});
