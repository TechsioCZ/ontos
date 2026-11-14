import { eq, sql } from 'drizzle-orm';
import {
  Cause,
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

import { findPostgresFailure } from '../packages/core-runtime/src/database/postgres-failure.ts';
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
import type {
  UndrainableOutboxDelivery,
  UndrainableOutboxWorkInput,
} from '../packages/core-runtime/src/outbox/undrainable-work.ts';
import type { OutboxConsumerKey } from '../packages/core-runtime/src/outbox/repository.ts';
import {
  abandonApplicationCompositionDrain,
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
    lock: { readonly key: string; readonly mode?: 'try' | 'wait'; readonly params: readonly string[] },
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
        if (lock.mode === 'try') {
          // Proof, on this very session, that no other holder exists: never waits, and fails if one does.
          const [granted] = yield* connection.executeValues(`select pg_try_advisory_lock(${lock.key})`, [
            ...lock.params,
          ]);
          if (granted?.[0] !== true) {
            return yield* unavailable(
              'A publisher is alive: it holds the Application Composition publication lock, so nothing was changed',
            );
          }
        } else {
          yield* withApplicationCompositionPublicationProgress(
            'acquire publication serialization lock',
            connection.executeValues(`select pg_advisory_lock(${lock.key})`, [...lock.params]),
          );
        }
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

const PUBLICATION_LOCK_KEY = "hashtextextended('ontos.application-composition-publication', 0)";

/**
 * Runs `operation` only if no publisher is alive: it takes the environment-wide publication lock without waiting, on
 * a reserved session it holds until `operation` ends, and refuses at once when another session holds it.
 */
export const withApplicationCompositionPublicationTryLock = <Value, Failure, Requirements>(
  operation: Effect.Effect<Value, Failure, Requirements>,
) => withSessionAdvisoryLock({ key: PUBLICATION_LOCK_KEY, mode: 'try', params: [] }, operation);

/** Every composition publisher and Shell artifact upload uses this same environment-wide database lock. */
export const withApplicationCompositionPublicationLock = <Value, Failure, Requirements>(
  publication: Effect.Effect<Value, Failure, Requirements>,
) => withSessionAdvisoryLock({ key: PUBLICATION_LOCK_KEY, params: [] }, publication);

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
/** How a drain that met work it could never finish ends, so the restore runs at once rather than at its deadline. */
const DRAIN_STOPPED =
  'The Application Composition drain was stopped: Outbox work arrived during it that it could never finish';

/**
 * How far before the retiring release's lease expires every drain, and every re-drain, must end: the restore's worst
 * case (about 55 s, see `RESTORE_LOCK_RETRIES`) plus slack. A restore that outlived the lease would find it expired,
 * and an expired authority is never returned to `active` (`abandonApplicationCompositionDrain`), so it would stay
 * `draining` until an operator renewed it.
 */
const DRAIN_LEASE_MARGIN_MS = 75_000;

/**
 * How long work must have sat unclaimed, or a message unmatched, before a drain counts it as stalled: one whole
 * standard drain budget, the same age the operator check uses. Never the drain's own budget, which a migration
 * shrinks to what is left of its deadline: a shorter age would call ordinary backlog stalled.
 */
const STALLED_AFTER_MS = APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.drainMs;

/**
 * The one clock a drain is judged on: the epoch instant by which it must be over (`deadlineMs`), and the age after
 * which unclaimed work counts as stalled (`stalledAfterMs`). Every check of the drain — the pre-flight, the fence
 * and each poll of the wait — asks what is due after that same instant.
 */
export interface DrainWindow {
  readonly deadlineMs: number;
  readonly stalledAfterMs: number;
}

/**
 * The window of a drain that starts its budget clock at `startedAtMs`: over when its budget runs out, and never past
 * the retiring release's lease (`leaseRemainingMs` from that same moment) less its margin.
 */
export const drainWindow = (input: {
  readonly budgetMs: number;
  readonly leaseRemainingMs: number;
  readonly startedAtMs: number;
}): DrainWindow => ({
  deadlineMs: input.startedAtMs + Math.min(input.budgetMs, input.leaseRemainingMs - DRAIN_LEASE_MARGIN_MS),
  stalledAfterMs: STALLED_AFTER_MS,
});

/** What is left of `window` at `nowMs`, never below zero. */
export const remainingInDrainWindow = (window: DrainWindow, nowMs: number) => Math.max(0, window.deadlineMs - nowMs);

/** Which core-system worker keys a drain may count on a consumer for, from `carriedOverCoreSystemWorkerKeys`. */
export interface DrainConsumerSets {
  readonly carriedOverWorkerKeys: readonly string[];
  readonly coreSystemConsumers: readonly OutboxConsumerKey[];
  readonly liveCoreSystemConsumers: readonly OutboxConsumerKey[];
}

/**
 * What the undrainable-work query is asked at `nowMs`, before the drain starts (`running: false`: the pre-flight and
 * the fence) or while it runs (`running: true`: each poll of the wait). Both ask what falls due after the same
 * deadline, and both age stalled work by the same whole budget.
 *
 * - Before it starts, only a carried-over core-system key counts as having a live consumer: nothing in the authority
 *   row says whether the retiring release can claim core-system work, so the drain refuses rather than waits.
 * - Once it runs, every core-system key the retiring authority approved does. A row of a key whose descriptor changed
 *   passed that check while it was claimed; when its handler fails and it returns to `pending`, or a fresh message of
 *   that key is matched, the retiring host retries it as usual. If it cannot, the deadline decides, as it always did.
 */
export const undrainableCheckInput = (
  window: DrainWindow,
  check: { readonly nowMs: number; readonly running: boolean; readonly sets: DrainConsumerSets },
): UndrainableOutboxWorkInput => ({
  budgetMs: window.stalledAfterMs,
  carriedOverWorkerKeys: check.sets.carriedOverWorkerKeys,
  coreSystemConsumers: check.running ? check.sets.coreSystemConsumers : check.sets.liveCoreSystemConsumers,
  remainingMs: remainingInDrainWindow(window, check.nowMs),
});

/**
 * What a running drain stops on: only a proof that a row can never finish before the deadline — it is dead, due
 * after the deadline, or has no consumer at all. Never its age alone: a row that has waited long may still be
 * claimed before the deadline, and if it is not, the deadline ends the drain exactly as it did before this check.
 */
export const stopsRunningDrain = (delivery: UndrainableOutboxDelivery) =>
  delivery.reason !== 'unclaimed-longer-than-budget';

/**
 * Everything that decides whether a drain may start, read in one transaction with the drain's own predicates:
 * the deliveries the drain would wait for in vain, the messages no matcher has taken for a whole budget, and the
 * messages not matched yet. Core-system work counts as having a live consumer only where it carries over
 * (`liveCoreSystemConsumers`), because nothing in the authority row says whether the retiring release can claim it.
 */
const assessDrainStart = Effect.fn('ApplicationCompositionAuthority.assessDrainStart')(function* assessDrainStart(
  transaction: CoreTransaction,
  window: DrainWindow,
) {
  const sets = yield* carriedOverCoreSystemWorkerKeys(transaction);
  const nowMs = yield* Clock.currentTimeMillis;
  const undrainable = yield* listUndrainableOutboxWork(
    transaction,
    undrainableCheckInput(window, { nowMs, running: false, sets }),
  );
  const stalledMessages = yield* countStalledUnmatchedMessages(transaction, window.stalledAfterMs);
  const [unmatched] = yield* transaction.execute<{ readonly count: number }>(
    sql`select count(*)::int as count from ${outboxMessages} where ${outboxMessages.matchedAt} is null`,
    'objects',
  );
  return { stalledMessages, undrainable, unmatched: unmatched?.count ?? 0 };
});

type DrainStartAssessment = Effect.Success<ReturnType<typeof assessDrainStart>>;

/** What a poll of a running drain stops on (`stopsRunningDrain`); it asks no age question and counts no messages. */
const assessRunningDrain = Effect.fn('ApplicationCompositionAuthority.assessRunningDrain')(function* assessRunningDrain(
  transaction: CoreTransaction,
  window: DrainWindow,
) {
  const sets = yield* carriedOverCoreSystemWorkerKeys(transaction);
  const nowMs = yield* Clock.currentTimeMillis;
  const undrainable = yield* listUndrainableOutboxWork(
    transaction,
    undrainableCheckInput(window, { nowMs, running: true, sets }),
  );
  return {
    stalledMessages: 0,
    undrainable: undrainable.filter(stopsRunningDrain),
    unmatched: 0,
  } satisfies DrainStartAssessment;
});

/** The reasons a drain must not start, or `[]` when it may; fresh unmatched messages are judged by the caller. */
const drainStartRefusals = Effect.fn('ApplicationCompositionAuthority.drainStartRefusals')(function* drainStartRefusals(
  assessment: DrainStartAssessment,
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
  ];
});

/**
 * The pre-flight of a drain, before durable admission closes. It fails CLOSED: a pre-flight that cannot be read is
 * not evidence that the drain is safe, and a drain that starts on unread work may stall with the running release
 * refusing reads. On any refusal durable admission is unchanged and the authority stays `active`, so the running
 * release keeps serving reads and writes. Work that is merely in flight still drains.
 */
const refuseUndrainableWork = Effect.fn('ApplicationCompositionAuthority.refuseUndrainableWork')(
  function* refuseUndrainableWorkEffect(window: DrainWindow) {
    const database = yield* CoreDatabase;
    const unreadable = unavailable(
      `${DRAIN_NOT_STARTED}: its pre-flight could not read the outstanding Outbox work. Durable admission is unchanged and the authority stays active, so the running release keeps serving.`,
    );
    const assessment = yield* database.executor
      .transaction((transaction) => assessDrainStart(transaction, window))
      .pipe(
        Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(unreadable) : Effect.die(defect))),
        Effect.mapError(() => unreadable),
      );
    const refusals = yield* drainStartRefusals(assessment);
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
const MATCHED_BEFORE_DRAINING = Duration.seconds(10);

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

/** How a fence attempt that found only freshly written, still unmatched messages says so. */
const UNMATCHED_AT_FENCE = 'Outbox message(s) were still unmatched at the enter-draining fence';
/** How many times the fence is tried while ordinary traffic keeps writing messages the matcher has yet to take. */
const FENCE_ATTEMPTS = 5;

/**
 * The enter-draining fence: under the exclusive authority lock, the same assessment as the pre-flight runs again, and
 * the phase moves to `draining` only when nothing in it could stall the drain. A message still unmatched here also
 * stops it — under this lock no matcher runs, so its deliveries cannot be checked — but that alone is ordinary
 * traffic committed while the lock waited, so it fails with `UNMATCHED_AT_FENCE` and the caller tries again.
 */
const enterDrainingIfDrainable = Effect.fn('ApplicationCompositionAuthority.enterDrainingIfDrainable')(
  function* enterDrainingIfDrainable(transaction: CoreTransaction, revision: string, window: DrainWindow) {
    const assessment = yield* assessDrainStart(transaction, window);
    const refusals = yield* drainStartRefusals(assessment);
    if (refusals.length > 0) {
      return yield* unavailable([`${DRAIN_NOT_STARTED}:`, ...refusals].join(' '));
    }
    if (assessment.unmatched > 0) {
      return yield* unavailable(
        `${DRAIN_NOT_STARTED}: ${String(assessment.unmatched)} ${UNMATCHED_AT_FENCE}, so their deliveries could not be checked.`,
      );
    }
    return yield* drainApplicationCompositionAuthority(transaction, revision);
  },
);

/** Only a refusal the enter-draining fence itself raised reopens admission; any other failure passes through. */
const reopenWhenRefused =
  (revision: string) =>
  <Failure,>(error: Failure) =>
    Schema.is(ApplicationCompositionAuthorityError)(error) && error.reason.startsWith(DRAIN_NOT_STARTED)
      ? reopenAfterRefusedDrain(revision, error.reason)
      : Effect.fail(error);

/** Who the publisher's own drain abandonments are recorded as. */
const DRAIN_PUBLISHER = 'application-composition-publisher';

interface DrainRestoreOutcome {
  readonly authorityPhase: PublicationState['authorityPhase'];
  /** What happened to the authority, for the failure message; empty when nothing needed restoring. */
  readonly description: string;
}

/** The failure's own words, for the ledger's reason. */
const failureReason = <Failure,>(failure: Failure): string => {
  if (Schema.is(ApplicationCompositionPublicationTimeout)(failure)) {
    return failure.message;
  }
  return Schema.is(ApplicationCompositionAuthorityError)(failure) ? failure.reason : 'The publication failed';
};

/** PostgreSQL's `lock_not_available`: the restore's `lock_timeout` expired while another session held a lock. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Four more attempts after the first, from 250 ms apart and doubling. One attempt can wait on two locks in turn (the
 * exclusive authority advisory lock, `ontos.application-composition-authority`, then the authority row's
 * `FOR UPDATE`), each for just under the 5 s lock timeout, so all five take about 55 s at most.
 */
const RESTORE_LOCK_RETRIES = 4;

/**
 * Tries `restore` again while PostgreSQL refuses it only because a lock was not available in time (`55P03`), a bounded
 * number of times with a short backoff; any other failure, or the last lock refusal, passes through unchanged. Each
 * attempt is one whole transaction that commits or rolls back, so a retried restore still records its abandonment
 * exactly once. A caller lifts a SQL error that arrives as a defect into the failure channel first.
 */
export const retryWhileLockNotAvailable = <Value, Failure, Requirements>(
  restore: Effect.Effect<Value, Failure, Requirements>,
) =>
  restore.pipe(
    Effect.retry({
      schedule: Schedule.exponential('250 millis').pipe(Schedule.upTo({ times: RESTORE_LOCK_RETRIES })),
      while: (failure: Failure) =>
        Option.isSome(findPostgresFailure(failure, ({ code }) => code === LOCK_NOT_AVAILABLE)),
    }),
  );

const restoreFailed = (why: string): DrainRestoreOutcome => ({
  authorityPhase: 'unknown',
  description: `The authority could not be returned to active (${why}): run \`pnpm composition:abandon-drain\` as described in docs/architecture/DEPLOYMENT.md.`,
});

/**
 * After a publication failed in or after its drain, while nothing was sealed and its own migration never started,
 * return the SAME revision to `active` with durable admission open, so the running release serves again:
 * - `draining` → a recorded drain abandonment (`abandonApplicationCompositionDrain`), in one transaction under the
 *   exclusive authority lock;
 * - `active` with durable admission closed (the drain had not begun) → admission reopened;
 * - anything else — another revision holds the authority, or it is `sealed`/`migrated` — is left exactly as it is.
 * The publication session lock is still held, so no second publisher can run between the failure and this.
 */
const restoreAfterFailedDrain = Effect.fn('ApplicationCompositionAuthority.restoreAfterFailedDrain')(
  function* restoreAfterFailedDrain(revision: string, reason: string) {
    const database = yield* CoreDatabase;
    return yield* database.executor
      .transaction((transaction) =>
        Effect.gen(function* restoreHeldAuthority() {
          // Bounded by the database, not by an Effect timeout: this also runs as an exit finalizer of an interrupted
          // publication, where nothing can interrupt it. The transaction commits whole or rolls back.
          yield* transaction.execute(sql`set local lock_timeout = '5s'`, 'objects');
          yield* transaction.execute(sql`set local statement_timeout = '10s'`, 'objects');
          yield* lockApplicationCompositionPublication(transaction);
          const [row] = yield* transaction
            .select({
              durableWorkAdmission: applicationCompositionAuthority.durableWorkAdmission,
              phase: applicationCompositionAuthority.phase,
              revision: applicationCompositionAuthority.revision,
            })
            .from(applicationCompositionAuthority)
            .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
          if (row === undefined || row.revision !== revision) {
            return { authorityPhase: 'unknown', description: '' } satisfies DrainRestoreOutcome;
          }
          if (row.phase === 'draining') {
            const recorded = yield* abandonApplicationCompositionDrain(transaction, {
              initiatedBy: 'publisher',
              operatorName: DRAIN_PUBLISHER,
              reason: reason.slice(0, 2000),
              revision,
            });
            return {
              authorityPhase: 'active',
              description: `The authority was returned to active with durable admission open (drain abandonment ${recorded.drainAbandonmentId}), so the running release serves reads and writes again.`,
            } satisfies DrainRestoreOutcome;
          }
          if (row.phase === 'active' && row.durableWorkAdmission === 'closed') {
            yield* resumeApplicationCompositionDurableAdmission(transaction, revision);
            return {
              authorityPhase: 'active',
              description: 'Durable admission was reopened and the authority stays active.',
            } satisfies DrainRestoreOutcome;
          }
          return { authorityPhase: row.phase, description: '' } satisfies DrainRestoreOutcome;
        }),
      )
      .pipe(
        // A SQL error can arrive as a defect; the restore must still retry or report instead of dying.
        Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect))),
        // A lock held a moment too long is no reason to leave the release refusing reads: try the whole transaction
        // again. Only a committed attempt reports `active`, and only it leaves a ledger row.
        retryWhileLockNotAvailable,
        Effect.catch((error) =>
          Effect.succeed(restoreFailed(isSqlError(error) ? 'the database refused the restore' : failureReason(error))),
        ),
      );
  },
);

/** The original failure with the restore's outcome appended, so the operator sees both. */
const withRestoreOutcome = <Failure,>(failure: Failure, outcome: DrainRestoreOutcome) => {
  if (outcome.description === '') {
    return failure;
  }
  if (Schema.is(ApplicationCompositionPublicationTimeout)(failure)) {
    return new ApplicationCompositionPublicationTimeout({
      authorityPhase: outcome.authorityPhase,
      budgetMs: failure.budgetMs,
      message: `${failure.message} ${outcome.description}`,
      migrationsCompleted: failure.migrationsCompleted,
      migrationStarted: failure.migrationStarted,
      phase: failure.phase,
    });
  }
  return Schema.is(ApplicationCompositionAuthorityError)(failure)
    ? unavailable(`${failure.reason} ${outcome.description}`)
    : failure;
};

/** What the ledger records when a publication ended without a failure of its own. */
const INTERRUPTED_REASON =
  'The publication was interrupted (stopped by the platform or by its own deadline) before it finished; its drain was abandoned.';
const DEFECT_REASON = 'The publication stopped on an unexpected defect before it finished; its drain was abandoned.';

/**
 * From closing admission to the promote's or seal's commit, return the authority however `effect` ends early:
 * - an ordinary failure restores (`restoreAfterFailedDrain`) and fails with both stories;
 * - an interruption — the platform's SIGTERM after its readiness timeout, an outer deadline — or a defect skips that
 *   handler, and is exactly how a hung publication ends. The exit hook restores then too, still inside the
 *   publication session lock this effect runs under. It runs uninterruptibly, bounded by the restore's own database
 *   timeouts, and its own failure never replaces the exit.
 */
const restoringAuthorityOnFailure =
  (revision: string) =>
  <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
    effect.pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          restoreAfterFailedDrain(revision, failureReason(error)).pipe(
            Effect.flatMap((outcome) => Effect.fail(withRestoreOutcome(error, outcome))),
          ),
        onSuccess: Effect.succeed,
      }),
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && !Cause.hasFails(exit.cause)
          ? restoreAfterFailedDrain(
              revision,
              Cause.hasInterrupts(exit.cause) ? INTERRUPTED_REASON : DEFECT_REASON,
            ).pipe(
              Effect.flatMap((outcome) =>
                outcome.description === ''
                  ? Effect.void
                  : Effect.logWarning(`Application Composition publication ended early. ${outcome.description}`),
              ),
              Effect.ignore,
            )
          : Effect.void,
      ),
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

/** One poll of a running Outbox drain: whether it is over, and what it holds that it could never finish. */
export interface DrainPoll {
  readonly drained: boolean;
  /** Why outstanding work can never drain inside the drain's window; empty while it is merely in flight. */
  readonly refusals: readonly string[];
}

const DRAIN_POLL_SPACING = Duration.seconds(3);

/**
 * Polls until the drain is over. Work that can no longer finish inside the drain's window — a delivery that died, or
 * that its owner deferred or a failure backed off past the deadline — ends the wait at once with the refusal, so the
 * publisher returns the authority to `active` now instead of when its budget runs out. Work merely in flight keeps
 * the wait going; the caller's own deadline still bounds it.
 */
export const waitUntilOutboxDrained = <Failure, Requirements>(poll: Effect.Effect<DrainPoll, Failure, Requirements>) =>
  Effect.gen(function* waitUntilOutboxDrainedEffect() {
    let progress = yield* poll;
    while (!progress.drained) {
      if (progress.refusals.length > 0) {
        return yield* unavailable([`${DRAIN_STOPPED}.`, ...progress.refusals].join(' '));
      }
      yield* Effect.sleep(DRAIN_POLL_SPACING);
      progress = yield* poll;
    }
    return yield* Effect.void;
  });

/** Only the refusal of a drain that met work it could never finish; a drain that merely ran out of time is not one. */
const isStoppedDrain = <Failure,>(failure: Failure) =>
  Schema.is(ApplicationCompositionAuthorityError)(failure) && failure.reason.startsWith(DRAIN_STOPPED);

/**
 * A re-drain's wait before a promote or seal is retried, bounded by what is left of its deadline. Only a stopped
 * drain ends the transition; running out of time, or any other failure, leaves the transition's own refusal as the
 * operator's evidence.
 */
export const boundedRedrain = <Failure, Requirements>(
  wait: Effect.Effect<void, Failure, Requirements>,
  remainingMs: number,
) =>
  wait.pipe(
    Effect.timeout(Duration.millis(Math.max(1, remainingMs))),
    Effect.catchIf(
      (error) => !isStoppedDrain(error),
      () => Effect.void,
    ),
  );

/** Which kind of failure made a poll's extra check unreadable, for logging each kind once. */
const unreadableCheckKind = <Failure,>(failure: Failure) =>
  Option.match(findPostgresFailure(failure), {
    onNone: () => 'no SQLSTATE',
    onSome: ({ code }) => `SQLSTATE ${code}`,
  });

/**
 * Waits for the Outbox of the draining `revision`. Each poll that finds work outstanding then asks, in its own read
 * transaction, what of it can never finish before the deadline (`assessRunningDrain`). That extra check only ever
 * ends a drain early: if it cannot be read, the poll keeps waiting, bounded by the deadline as before, and says so
 * once for each kind of failure. A failure of the drained check itself still fails the drain, as it always did.
 */
const waitForOutboxPublicationWork = Effect.fn('ApplicationCompositionAuthority.waitForOutboxWork')(
  function* waitForOutboxPublicationWork(revision: string, window: DrainWindow) {
    const database = yield* CoreDatabase;
    const logged = yield* Ref.make<ReadonlySet<string>>(new Set());
    const keepWaiting = <Failure,>(failure: Failure) =>
      Effect.gen(function* logUnreadableCheck() {
        const kind = unreadableCheckKind(failure);
        const seen = yield* Ref.getAndUpdate(logged, (kinds) => new Set([...kinds, kind]));
        if (!seen.has(kind)) {
          yield* Effect.logWarning(
            `The drain's check for Outbox work it could never finish could not be read (${kind}); the drain keeps waiting, bounded by its deadline.`,
          );
        }
        return yield* Effect.succeed<readonly string[]>([]);
      });
    const refusals = database.executor
      .transaction((transaction) => assessRunningDrain(transaction, window))
      .pipe(
        Effect.flatMap(drainStartRefusals),
        Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect))),
        Effect.matchEffect({ onFailure: keepWaiting, onSuccess: Effect.succeed }),
      );
    return yield* waitUntilOutboxDrained(
      Effect.gen(function* pollOutboxDrain() {
        if (
          yield* database.executor.transaction((transaction) =>
            isApplicationCompositionWorkDrained(transaction, revision),
          )
        ) {
          return { drained: true, refusals: [] } satisfies DrainPoll;
        }
        return { drained: false, refusals: yield* refusals } satisfies DrainPoll;
      }),
    );
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
                "The bounded drain deadline expired; pending work is not proof of a dead owner. This release's own sealed schema migration did not start. The owner migrations of this release ran before the publication and stay applied; they are expand-only and the old release is rehearsed against the migrated database, so it keeps serving.",
                ...(described === '' ? [] : [described]),
              ].join(' '),
            }),
          ),
        ),
      );
    return yield* Effect.gen(function* boundedDrain() {
      // The budget's timeout below starts now, so every check of this drain is judged from this same instant.
      const startedAtMs = yield* Clock.currentTimeMillis;
      const database = yield* CoreDatabase;
      progressState.phase = DURABLE_DRAIN;
      const [lease] = yield* database.executor.execute<{ readonly remaining: number }>(
        sql`select (extract(epoch from (${current.validUntil}::timestamptz - clock_timestamp())) * 1000)::double precision as remaining`,
        'objects',
      );
      if (lease === undefined || !Number.isFinite(lease.remaining) || lease.remaining <= DRAIN_LEASE_MARGIN_MS) {
        return yield* unavailable('The old Application Composition lease must be renewed before draining');
      }
      const window = drainWindow({ budgetMs, leaseRemainingMs: lease.remaining, startedAtMs });
      yield* Effect.gen(function* finishOldCompositionWork() {
        if (current.phase === 'active') {
          // Before the authority fence moves: a drain that waits for work nothing can finish would refuse every
          // read on the running release until its budget expired. Refusing here leaves durable admission open and
          // the authority active, so the old release keeps serving. (Earlier boot steps — the migrator, workload
          // registration, credential provisioning and the expand-only completion-schema expansion — have already
          // run and stay applied; they are safe under the old release.)
          yield* refuseUndrainableWork(window);
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
          // The pre-flight was a point in time: work matched since then has never been checked. Each attempt lets the
          // running matcher take what is in flight first; the fence then re-checks under the exclusive authority lock,
          // where the matcher is blocked and the answer cannot move before the phase does. The legacy observation
          // stays immediately before the fence it justifies. Writes admitted while the lock waited can leave fresh
          // unmatched messages behind; only those are tried again, a bounded number of times, inside the budget.
          const enterDraining = waitForMatchedMessages.pipe(
            // A provider receipt alone is insufficient: re-observe the actual retired executables.
            Effect.andThen(verifyLegacyQuiescence),
            Effect.andThen(requireNoLegacyRuntimeTransactions()),
            // Owner locks remain held until the nested Core transaction actually COMMITs.
            Effect.andThen(
              withVerifiedLegacyTransition(current.revision, (transaction) =>
                enterDrainingIfDrainable(transaction, current.revision, window),
              ),
            ),
            Effect.retry({
              schedule: Schedule.recurs(FENCE_ATTEMPTS - 1),
              while: (error) =>
                Schema.is(ApplicationCompositionAuthorityError)(error) && error.reason.includes(UNMATCHED_AT_FENCE),
            }),
          );
          yield* withApplicationCompositionPublicationProgress(
            'enter draining (authority fence)',
            enterDraining.pipe(Effect.catch(reopenWhenRefused(current.revision))),
          );
        }
        yield* Ref.set(drainScope, null);
        progressState.authorityPhase = 'draining';
        progressState.phase = 'outbox-drain';
        yield* withApplicationCompositionPublicationProgress(
          'drain unmatched messages and unfinished deliveries',
          waitForOutboxPublicationWork(current.revision, window),
          logApplicationCompositionDrainBlockers,
        );
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(Math.max(1, lease.remaining - DRAIN_LEASE_MARGIN_MS)),
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

/** What the transition's own drain check says when work arrived after the poll observed the Outbox drained. */
const FRESH_OUTBOX_WORK = 'Outstanding Outbox work';
const isFreshOutboxWork = (reason: string) => reason.includes(FRESH_OUTBOX_WORK);

/**
 * Why a drained transition gave up. A promote or seal that began on an `active` or `draining` authority is followed
 * by the publisher's return of that authority to `active` (`restoreAfterFailedDrain`), whose outcome is appended; a
 * promote from a `migrated` authority leaves it `migrated`, which no abandonment applies to.
 */
export const abandonedTransitionMessage = (startedFrom: CurrentApplicationCompositionAuthority['phase']) => {
  const giveUp = `Outbox work kept arriving after ${String(DRAINED_TRANSITION_RETRIES)} re-drains, so the Application Composition transition was abandoned.`;
  // From `active` or `draining` the publisher then returns the authority to `active`, and says so after this.
  return startedFrom === 'migrated'
    ? `${giveUp} The authority stays migrated, which admits no work of the retired release; deploy again once the work finished.`
    : giveUp;
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
    const failures = yield* Ref.make(0);
    // One deadline for every re-drain together: never past the retiring lease (less its margin), and never longer
    // than one drain budget in total, however many retries there are.
    const leaseMillis = DateTime.toEpochMillis(DateTime.makeUnsafe(current.validUntil));
    const redrainDeadline = Math.min(
      leaseMillis - DRAIN_LEASE_MARGIN_MS,
      (yield* Clock.currentTimeMillis) + APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.drainMs,
    );
    const redrainWindow: DrainWindow = { deadlineMs: redrainDeadline, stalledAfterMs: STALLED_AFTER_MS };
    const redrain = Effect.gen(function* waitForFreshWork() {
      const remaining = remainingInDrainWindow(redrainWindow, yield* Clock.currentTimeMillis);
      // The original refusal is the operator's evidence: a wait that cannot finish must never replace it. Work that
      // can never finish is better evidence still, and ends the transition at once.
      yield* boundedRedrain(waitForOutboxPublicationWork(current.revision, redrainWindow), remaining);
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
          // From closing admission to the seal's commit, any early end returns this revision to active.
          yield* Effect.gen(function* drainAndSeal() {
            state.phase = DURABLE_DRAIN;
            yield* prepareApplicationCompositionDrain(current, verifyInitialCutover, remainingDrainMs, state);
            state.phase = 'seal';
            yield* verifyInitialCutover;
            yield* requireNoLegacyRuntimeTransactions();
            yield* withDrainedCompositionTransition(current, (transaction) =>
              sealApplicationCompositionAuthority(transaction, current.revision),
            );
          }).pipe(restoringAuthorityOnFailure(current.revision));
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
    const promoteAndPublish = (transaction: CoreTransaction) =>
      publishApplicationCompositionAuthority(transaction, approved).pipe(Effect.andThen(publishProviderPointer));
    if (current === undefined) {
      // Old binaries cannot participate in the new fences. Provider quiescence is required only
      // for the first row, before any new authority or public pointer can be published.
      yield* verifyInitialCutover;
      yield* requireNoLegacyRuntimeTransactions();
      yield* installApplicationCompositionCompletionSchema();
      // Absence of a Core authority row does not imply absence of retained owner history.
      return yield* withApplicationCompositionPublicationProgress(
        'promote native authority and publish provider pointer',
        withVerifiedLegacyTransition(null, promoteAndPublish),
      );
    }
    if (DateTime.toEpochMillis(approved.validUntil) <= current.validUntil.getTime()) {
      return yield* unavailable('A replacement Application Composition needs newer freshness evidence');
    }
    if (current.phase === 'sealed') {
      return yield* unavailable('A sealed Application Composition requires a successfully completed migration');
    }
    // From closing admission to the promote's commit — the drain, the quiescence checks after it and the promote
    // itself — any early end returns this revision to active.
    return yield* Effect.gen(function* drainAndPromote() {
      if (current.phase !== 'migrated') {
        yield* installApplicationCompositionCompletionSchema();
        yield* prepareApplicationCompositionDrain(current, verifyInitialCutover);
      }
      // A recovered row is not proof that this deployment observed legacy absence.
      yield* verifyInitialCutover;
      yield* requireNoLegacyRuntimeTransactions();
      return yield* withApplicationCompositionPublicationProgress(
        'promote native authority and publish provider pointer',
        withDrainedCompositionTransition(current, promoteAndPublish),
      );
    }).pipe(restoringAuthorityOnFailure(current.revision));
  });
  return yield* withApplicationCompositionPublicationLock(publication);
});
