import { eq, sql } from 'drizzle-orm';
import {
  Clock,
  Config,
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Redacted,
  Ref,
  Schedule,
  Schema,
} from 'effect';
import { isSqlError } from 'effect/sql/SqlError';

import { CoreDatabase, CoreDatabaseLive } from '../packages/core-runtime/src/db/client.ts';
import type { CoreTransaction } from '../packages/core-runtime/src/db/types.ts';
import { DatabaseConfig, parseDatabaseConnectionPair } from '../packages/core-runtime/src/db/config.ts';
import {
  applicationCompositionAuthority,
  applicationCompositionDurableWork,
  outboxDeliveries,
  outboxMessages,
} from '../packages/core-runtime/src/db/schema.ts';
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
  countStalledUnmatchedMessages,
  describeUndrainableOutboxWork,
  listUndrainableOutboxWork,
} from '../packages/core-runtime/src/outbox/undrainable-work.ts';
import {
  ApplicationCompositionAuthorityError,
  carriedOverCoreSystemWorkerKeys,
  closeApplicationCompositionDurableAdmission,
  drainApplicationCompositionAuthority,
  isApplicationCompositionDurableWorkDrained,
  isApplicationCompositionWorkDrained,
  lockApplicationCompositionPublication,
  markApplicationCompositionMigrationComplete,
  publishApplicationCompositionAuthority,
  resealMigratedApplicationCompositionAuthority,
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
const REPLACEMENT_PUBLICATION_REQUIRED = 'replacement-publication-required';

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
    REPLACEMENT_PUBLICATION_REQUIRED,
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

/** How every refusal to start a drain begins, so an operator and a test can tell it from a drain that ran. */
const DRAIN_NOT_STARTED = 'The Application Composition drain was not started';

/**
 * Everything that decides whether a drain may start, read in one transaction with the drain's own predicates:
 * the deliveries the drain would wait for in vain, the messages no matcher has taken for a whole budget, and the
 * messages not matched yet. Core-system work counts as having a live consumer only where it carries over
 * (`liveCoreSystemConsumers`), because nothing in the authority row says whether the retiring release can claim it.
 */
const assessDrainStart = Effect.fn('ApplicationCompositionAuthority.assessDrainStart')(function* assessDrainStart(
  transaction: CoreTransaction,
  budgetMs: number,
) {
  const { carriedOverWorkerKeys, liveCoreSystemConsumers } = yield* carriedOverCoreSystemWorkerKeys(transaction);
  const undrainable = yield* listUndrainableOutboxWork(transaction, {
    budgetMs,
    carriedOverWorkerKeys,
    coreSystemConsumers: liveCoreSystemConsumers,
  });
  const stalledMessages = yield* countStalledUnmatchedMessages(transaction, budgetMs);
  const [unmatched] = yield* transaction.execute<{ readonly count: number }>(
    sql`select count(*)::int as count from ${outboxMessages} where ${outboxMessages.matchedAt} is null`,
    'objects',
  );
  return { stalledMessages, undrainable, unmatched: unmatched?.count ?? 0 };
});

type DrainStartAssessment = Effect.Success<ReturnType<typeof assessDrainStart>>;

/**
 * The reasons a drain must not start, or `[]` when it may. Before admission closes, a freshly written unmatched
 * message is in-flight work the running matcher takes. Under the enter-draining fence it is not: the matcher is
 * blocked by the exclusive authority lock, so an unmatched message there is work whose deliveries nobody has been
 * able to classify, and it blocks too (`unmatchedBlocks`).
 */
const drainStartRefusals = Effect.fn('ApplicationCompositionAuthority.drainStartRefusals')(function* drainStartRefusals(
  assessment: DrainStartAssessment,
  unmatchedBlocks: boolean,
) {
  // A dead delivery keeps the description the operator commands already use; the other reasons have no command.
  // If that description cannot be read, the dead rows are still named from the assessment itself: a refusal must
  // never vanish because its wording was unavailable.
  const deadRows = assessment.undrainable.filter((delivery) => delivery.reason === 'dead');
  const dead =
    deadRows.length === 0
      ? ''
      : yield* describeDeadDrainDeliveries(null).pipe(
          Effect.orElseSucceed(() => ''),
          Effect.map((described) => (described === '' ? describeUndrainableOutboxWork(deadRows) : described)),
        );
  const others = describeUndrainableOutboxWork(assessment.undrainable.filter((delivery) => delivery.reason !== 'dead'));
  return [
    ...(dead === '' ? [] : [dead]),
    ...(others === '' ? [] : [others]),
    ...(assessment.stalledMessages === 0
      ? []
      : [
          `${String(assessment.stalledMessages)} Outbox message(s) have waited longer than the whole drain budget without being matched: no matcher is running, so the drain could never finish.`,
        ]),
    ...(unmatchedBlocks && assessment.stalledMessages === 0 && assessment.unmatched > 0
      ? [
          `${String(assessment.unmatched)} Outbox message(s) were still unmatched when the drain was about to start, so their deliveries could not be checked.`,
        ]
      : []),
  ];
});

/**
 * The pre-flight of a drain, before durable admission closes. It fails CLOSED: a pre-flight that cannot be read is
 * not evidence that the drain is safe, and a drain that starts on unread work may stall with the running release
 * refusing reads. On any refusal durable admission is unchanged and the authority stays `active`, so the running
 * release keeps serving reads and writes. Work that is merely in flight still drains.
 */
const refuseUndrainableWork = Effect.fn('ApplicationCompositionAuthority.refuseUndrainableWork')(
  function* refuseUndrainableWorkEffect(budgetMs: number) {
    const database = yield* CoreDatabase;
    const unreadable = unavailable(
      `${DRAIN_NOT_STARTED}: its pre-flight could not read the outstanding Outbox work. Durable admission is unchanged and the authority stays active, so the running release keeps serving.`,
    );
    const assessment = yield* database.executor
      .transaction((transaction) => assessDrainStart(transaction, budgetMs))
      .pipe(
        Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(unreadable) : Effect.die(defect))),
        Effect.mapError(() => unreadable),
      );
    const refusals = yield* drainStartRefusals(assessment, false);
    if (refusals.length === 0) {
      return yield* Effect.void;
    }
    return yield* unavailable(
      [
        `${DRAIN_NOT_STARTED}: durable admission is unchanged and the authority stays active, so the running release keeps serving.`,
        ...refusals,
      ].join(' '),
    );
  },
);

/** How long the publisher lets the running matcher take freshly written messages before it enters `draining`. */
const MATCHED_BEFORE_DRAINING = Duration.seconds(30);

/**
 * Waits, bounded, until no message is unmatched. The pre-flight is a point in time; the enter-draining fence
 * re-checks under the exclusive lock, and this wait keeps that re-check from refusing for ordinary traffic the
 * running matcher would have taken a poll later.
 */
const waitForMatchedMessages = Effect.gen(function* waitForMatchedMessagesEffect() {
  const database = yield* CoreDatabase;
  const unmatched = database.executor
    .select({ count: sql<number>`count(*)::int` })
    .from(outboxMessages)
    .where(sql`${outboxMessages.matchedAt} is null`)
    .pipe(Effect.map((rows) => rows[0]?.count ?? 0));
  while ((yield* unmatched) > 0) {
    yield* Effect.sleep(Duration.seconds(1));
  }
}).pipe(Effect.timeout(MATCHED_BEFORE_DRAINING), Effect.ignore);

/**
 * A drain refused at the enter-draining fence finds durable admission already closed and the authority still
 * `active` (the fence's transaction rolled back, so the phase never moved). Reads and writes still work, but new
 * durable workflows would stay refused for good, so admission is reopened for the same revision: the authority is
 * then exactly as it was before the publication began. If reopening fails, the refusal says so; that state is
 * degraded — new durable workflows refused — but never an outage.
 */
const reopenAfterRefusedDrain = Effect.fn('ApplicationCompositionAuthority.reopenAfterRefusedDrain')(
  function* reopenAfterRefusedDrain(revision: string, refusalReason: string) {
    const database = yield* CoreDatabase;
    const reopened = yield* database.executor
      .transaction((transaction) => resumeApplicationCompositionDurableAdmission(transaction, revision))
      .pipe(Effect.exit);
    return yield* unavailable(
      [
        refusalReason,
        Exit.isSuccess(reopened)
          ? 'Durable admission was reopened and the authority stays active, so the running release keeps serving.'
          : 'The authority stays active, so the running release keeps serving reads and writes, but durable admission could not be reopened: run `resumeApplicationCompositionDurableWork` for this revision.',
      ].join(' '),
    );
  },
);

interface CurrentApplicationCompositionAuthority {
  readonly phase: 'active' | 'draining' | 'sealed' | 'migrated';
  readonly revision: string;
  readonly validUntil: Date;
}

const waitForDurablePublicationWork = Effect.fn('ApplicationCompositionAuthority.waitForDurableWork')(
  function* waitForDurablePublicationWork(revision: string, reported: Ref.Ref<string>) {
    const database = yield* CoreDatabase;
    while (
      !(yield* database.executor.transaction((transaction) =>
        // Settlement is confined to the lock-owning mutating path, never the diagnostic reader.
        settleParkedEnrollmentPublicationWork(transaction, revision).pipe(
          Effect.andThen(isApplicationCompositionDurableWorkDrained(transaction, revision)),
        ),
      ))
    ) {
      yield* reportDeadDrainDeliveries(revision, reported);
      yield* Effect.sleep(Duration.seconds(3));
    }
  },
);

const waitForOutboxPublicationWork = Effect.fn('ApplicationCompositionAuthority.waitForOutboxWork')(
  function* waitForOutboxPublicationWork(revision: string, reported: Ref.Ref<string>) {
    const database = yield* CoreDatabase;
    while (
      !(yield* database.executor.transaction((transaction) =>
        isApplicationCompositionWorkDrained(transaction, revision),
      ))
    ) {
      yield* reportDeadDrainDeliveries(null, reported);
      yield* Effect.sleep(Duration.seconds(3));
    }
  },
);

const prepareApplicationCompositionDrain = Effect.fn('ApplicationCompositionAuthority.prepareDrain')(
  function* prepareApplicationCompositionDrain<Failure, Requirements>(
    current: CurrentApplicationCompositionAuthority,
    verifyLegacyQuiescence: Effect.Effect<void, Failure, Requirements>,
    budgetMs: number = APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.drainMs,
    state?: PublicationState,
  ) {
    const progressState: PublicationState = state ?? {
      authorityPhase: current.phase,
      migrationsCompleted: false,
      migrationStarted: false,
      phase: DURABLE_DRAIN,
    };
    // The drain phase whose dead deliveries a timeout names: tracked debt first, then all Outbox work.
    const drainScope = yield* Ref.make<string | null>(current.revision);
    const reported = yield* Ref.make('');
    const deadDeliveries = Ref.get(drainScope).pipe(
      Effect.flatMap(describeDeadDrainDeliveries),
      Effect.orElseSucceed(() => ''),
    );
    const budgetExpired = () =>
      deadDeliveries.pipe(
        Effect.flatMap((described) =>
          Effect.fail(
            new ApplicationCompositionPublicationTimeout({
              ...progressState,
              budgetMs,
              message: [
                "The bounded drain deadline expired; pending work is not proof of a dead owner. This release's own sealed schema migration did not start and admission was not reopened. The owner migrations of this release ran before the publication and stay applied; they are expand-only and the old release is rehearsed against the migrated database, so it keeps serving.",
                ...(described === '' ? [] : [described]),
              ].join(' '),
            }),
          ),
        ),
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
          // Before the authority fence moves: a drain that waits for work nothing can finish would refuse every
          // read on the running release until its budget expired. Refusing here leaves durable admission open and
          // the authority active, so the old release keeps serving. (Earlier boot steps — the migrator, workload
          // registration, credential provisioning and the expand-only completion-schema expansion — have already
          // run and stay applied; they are safe under the old release.)
          yield* refuseUndrainableWork(budgetMs);
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
            waitForDurablePublicationWork(current.revision, reported),
            logApplicationCompositionDrainBlockers,
          );
          progressState.phase = 'enter-draining';
          // The pre-flight was a point in time: work matched since then has never been checked. Let the running
          // matcher take what is in flight first; the fence below re-checks under the exclusive authority lock,
          // where the matcher is blocked and the answer cannot move before the phase does. This wait comes before
          // the legacy observation, which must stay immediately before the fence it justifies.
          yield* waitForMatchedMessages;
          // A provider receipt alone is insufficient: re-observe the actual retired executables.
          yield* verifyLegacyQuiescence;
          yield* requireNoLegacyRuntimeTransactions();
          // Owner locks remain held until the nested Core transaction actually COMMITs.
          yield* withApplicationCompositionPublicationProgress(
            'enter draining (authority fence)',
            withVerifiedLegacyTransition(current.revision, (transaction) =>
              Effect.gen(function* enterDrainingIfDrainable() {
                const refusals = yield* drainStartRefusals(yield* assessDrainStart(transaction, budgetMs), true);
                if (refusals.length > 0) {
                  return yield* unavailable([`${DRAIN_NOT_STARTED}:`, ...refusals].join(' '));
                }
                return yield* drainApplicationCompositionAuthority(transaction, current.revision);
              }),
            ).pipe(
              Effect.catchIf(
                (error) =>
                  Schema.is(ApplicationCompositionAuthorityError)(error) && error.reason.startsWith(DRAIN_NOT_STARTED),
                (error) =>
                  reopenAfterRefusedDrain(
                    current.revision,
                    Schema.is(ApplicationCompositionAuthorityError)(error) ? error.reason : DRAIN_NOT_STARTED,
                  ),
              ),
            ),
          );
        }
        yield* Ref.set(drainScope, null);
        progressState.authorityPhase = 'draining';
        progressState.phase = 'outbox-drain';
        yield* withApplicationCompositionPublicationProgress(
          'drain unmatched messages and unfinished deliveries',
          waitForOutboxPublicationWork(current.revision, reported),
          logApplicationCompositionDrainBlockers,
        );
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(Math.max(1, lease.remaining - 30_000)),
          orElse: () =>
            deadDeliveries.pipe(
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
    }).pipe(Effect.timeoutOrElse({ duration: Duration.millis(budgetMs), orElse: budgetExpired }));
  },
);

/** How many times a transition may re-drain before it gives up. */
const DRAINED_TRANSITION_RETRIES = 5;
/** Nothing of this release's own work is left to wait for, so a re-drain that cannot finish must not run long. */
const DRAINED_TRANSITION_LEASE_MARGIN = Duration.seconds(30);

/** What the transition's own drain check says when work arrived after the poll observed the Outbox drained. */
const FRESH_OUTBOX_WORK = 'Outstanding Outbox work';
const isFreshOutboxWork = (reason: string) => reason.includes(FRESH_OUTBOX_WORK);

/**
 * Why a drained transition gave up, naming the phase the authority is really left in. A promote or seal that
 * began on an `active` or `draining` authority leaves it `draining`; a promote from a `migrated` authority leaves
 * it `migrated`, which the draining recovery does not apply to.
 */
export const abandonedTransitionMessage = (startedFrom: CurrentApplicationCompositionAuthority['phase']) => {
  const giveUp = `Outbox work kept arriving after ${String(DRAINED_TRANSITION_RETRIES)} re-drains, so the Application Composition transition was abandoned.`;
  return startedFrom === 'migrated'
    ? `${giveUp} The authority stays migrated, which admits no work of the retired release; deploy again once the work finished.`
    : `${giveUp} The authority is left in draining and the running release refuses reads: follow "Returning a stuck authority to active" in docs/architecture/DEPLOYMENT.md, or deploy again once the work finished.`;
};

/**
 * Commits one authority transition on a drained composition — the promote, or the seal before a migration —
 * tolerating work that arrives between the drain poll and the transition.
 *
 * The poll ignores a carried-over row, but the transition's own `requireDrainedWork` counts it as blocking if a
 * live host of the retiring release claimed it in between: a real interleaving now that a host with the claim fix
 * takes exactly those rows. Failing there would leave the authority in `draining`, so the publisher waits for the
 * Outbox again and retries. Only the re-drain wait is bounded — the transition itself contains provider I/O and
 * keeps the caller's own budget. All re-drains together end at one deadline: never past the retiring release's
 * freshness lease (less its margin), exactly as the first drain cannot, and never longer than one drain budget.
 * The final failure is followed by no retry, so no re-drain runs after it.
 */
const withDrainedCompositionTransition = Effect.fn('ApplicationCompositionAuthority.drainedTransition')(
  function* withDrainedCompositionTransition<Value, Failure, Requirements>(
    current: CurrentApplicationCompositionAuthority,
    transition: (transaction: CoreTransaction) => Effect.Effect<Value, Failure, Requirements>,
  ) {
    const reported = yield* Ref.make('');
    const failures = yield* Ref.make(0);
    // One deadline for every re-drain together: never past the retiring lease (less its margin), and never longer
    // than one drain budget in total, however many retries there are.
    const leaseMillis = DateTime.toEpochMillis(DateTime.makeUnsafe(current.validUntil));
    const redrainDeadline = Math.min(
      leaseMillis - Duration.toMillis(DRAINED_TRANSITION_LEASE_MARGIN),
      (yield* Clock.currentTimeMillis) + APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.drainMs,
    );
    const redrain = Effect.gen(function* waitForFreshWork() {
      const remaining = redrainDeadline - (yield* Clock.currentTimeMillis);
      yield* waitForOutboxPublicationWork(current.revision, reported).pipe(
        Effect.timeout(Duration.millis(Math.max(1, remaining))),
        // The original refusal is the operator's evidence: a wait that cannot finish must never replace it.
        Effect.ignore,
      );
    });
    return yield* withVerifiedLegacyTransition(current.revision, transition).pipe(
      Effect.tapError((error) =>
        Effect.gen(function* drainAgainBeforeRetry() {
          if (!(Schema.is(ApplicationCompositionAuthorityError)(error) && isFreshOutboxWork(error.reason))) {
            return;
          }
          // The final failure is followed by no retry, so waiting for the Outbox after it would only delay the
          // refusal.
          if ((yield* Ref.updateAndGet(failures, (seen) => seen + 1)) > DRAINED_TRANSITION_RETRIES) {
            return;
          }
          yield* Effect.logInfo('Application Composition transition found fresh Outbox work; draining again');
          yield* redrain;
        }),
      ),
      Effect.retry({
        schedule: Schedule.recurs(DRAINED_TRANSITION_RETRIES),
        while: (error) => Schema.is(ApplicationCompositionAuthorityError)(error) && isFreshOutboxWork(error.reason),
      }),
      Effect.catchIf(
        (error) => Schema.is(ApplicationCompositionAuthorityError)(error) && isFreshOutboxWork(error.reason),
        () => Effect.fail(unavailable(abandonedTransitionMessage(current.phase))),
      ),
    );
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
    budgets: ApplicationCompositionMigrationBudgets = {},
    resumeMigratedRevision?: string,
  ) {
    if (resumeMigratedRevision !== undefined && !/^[a-f0-9]{64}$/u.test(resumeMigratedRevision)) {
      return yield* unavailable('A schema retry requires an exact retired composition revision');
    }
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
        if (current !== undefined && current.phase !== 'migrated') {
          // This opt-in additive Core expansion is safe for old writers. Install and journal it
          // before the verifier selects its columns; incompatible owner DDL remains deferred.
          yield* installApplicationCompositionCompletionSchema();
        }
        if (resumeMigratedRevision !== undefined) {
          if (current?.phase !== 'migrated' || current.revision !== resumeMigratedRevision) {
            return yield* unavailable('The schema retry no longer identifies the exact migrated authority');
          }
          state.phase = 'seal';
          // Resealing is an authority transition too: it re-observes legacy owner absence under the owner locks.
          yield* verifyInitialCutover;
          yield* requireNoLegacyRuntimeTransactions();
          yield* withVerifiedLegacyTransition(resumeMigratedRevision, (transaction) =>
            resealMigratedApplicationCompositionAuthority(transaction, resumeMigratedRevision),
          );
          state.authorityPhase = 'sealed';
        } else if (current === undefined) {
          yield* verifyInitialCutover;
          yield* requireNoLegacyRuntimeTransactions();
        } else if (current.phase === 'migrated') {
          return yield* unavailable(
            'The completed migration requires replacement publication before another migration',
          );
        } else if (current.phase !== 'sealed') {
          const remainingDrainMs = Math.max(1, Math.min(drainMs, deadline - (yield* Clock.currentTimeMillis)));
          state.phase = DURABLE_DRAIN;
          yield* prepareApplicationCompositionDrain(current, verifyInitialCutover, remainingDrainMs, state);
          state.phase = 'seal';
          yield* verifyInitialCutover;
          yield* requireNoLegacyRuntimeTransactions();
          yield* withDrainedCompositionTransition(current, (transaction) =>
            sealApplicationCompositionAuthority(transaction, current.revision),
          );
          state.authorityPhase = 'sealed';
        }
        if (current?.phase === 'sealed') {
          state.phase = 'seal';
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
          // No re-drain retry here, and none is needed: the authority has been `sealed` since before the
          // migration, and `admitAuthority` refuses a sealed revision for every operation including `worker`, so
          // no claim can have created fresh Outbox work after the seal.
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

/**
 * Draining commits before promotion, so an outstanding delivery cannot undo the write fence.
 * A separate publication lock serializes every writer through provider readback. A renewal keeps
 * owner work running during provider I/O and updates its lease only after success. A replacement
 * holds the authority lock through provider I/O; failure preserves the old admission phase.
 */
/**
 * Renews the authority this release holds, and nothing else: under the publication lock it re-reads the row and
 * refuses unless the row still names this release's revision. A host superseded while its renewal waited for the lock
 * therefore cannot replace the newer release (a full publication would treat its later validity as newer evidence).
 */
export const renewApplicationCompositionAuthoritySnapshot = Effect.fn('ApplicationCompositionAuthority.renewSnapshot')(
  function* renewApplicationCompositionAuthoritySnapshot<Value, Failure, Requirements>(
    snapshot: ActiveApplicationCompositionSnapshot,
    publishProviderPointer: Effect.Effect<Value, Failure, Requirements>,
  ) {
    const approved = yield* validateActiveApplicationCompositionSnapshot(snapshot).pipe(
      Effect.mapError(() => unavailable('The complete Application Composition snapshot is invalid or expired')),
    );
    const database = yield* CoreDatabase;
    const renewal = Effect.gen(function* renewHeldAuthority() {
      const [current] = yield* database.executor
        .select({
          revision: applicationCompositionAuthority.revision,
          validUntil: applicationCompositionAuthority.validUntil,
        })
        .from(applicationCompositionAuthority)
        .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
      if (current?.revision !== approved.composition.revision) {
        return yield* unavailable(
          'This release no longer holds the Application Composition authority; a renewal never replaces another release',
        );
      }
      if (DateTime.toEpochMillis(approved.validUntil) < current.validUntil.getTime()) {
        return yield* unavailable('Application Composition freshness cannot regress');
      }
      const value = yield* publishProviderPointer;
      yield* withApplicationCompositionPublicationProgress(
        'renew native authority',
        database.executor.transaction((transaction) => publishApplicationCompositionAuthority(transaction, approved)),
      );
      return value;
    });
    return yield* withApplicationCompositionPublicationLock(renewal);
  },
);

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
    return yield* withApplicationCompositionPublicationProgress(
      'promote native authority and publish provider pointer',
      current === undefined
        ? withVerifiedLegacyTransition(null, promoteAndPublish)
        : withDrainedCompositionTransition(current, promoteAndPublish),
    );
  });
  return yield* withApplicationCompositionPublicationLock(publication);
});
