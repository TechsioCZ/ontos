import { v1 } from '@authzed/authzed-node';
import { Array as EffectArray, Clock, Duration, Effect, Exit, Fiber, Option, Redacted, Schedule, Schema } from 'effect';
import type { Scope } from 'effect';

import type { SpiceDbRpc } from '../permissions/spicedb-rpc.ts';

/**
 * A served process pays first-use setup on its first requests: database sessions, the SpiceDB client, the
 * composition snapshot and its catalog, code that never ran. The boot warm-up pays it ahead of the first request,
 * in the background, through the same pools and sources the requests use. It is read-only by construction: each
 * step takes the narrowest port it needs (a statement runner, a SpiceDB schema read, a snapshot load, a catalog
 * build, a module import), runs no principal, permission check, evidence row or write, and the host serves whether it
 * succeeds or not.
 */
const STEP_NAMES = ['composition', 'database-pool', 'imports', 'spicedb'] as const;
export const BootWarmUpStepNameSchema = Schema.Literals(STEP_NAMES);
export type BootWarmUpStepName = typeof BootWarmUpStepNameSchema.Type;
const [COMPOSITION, DATABASE_POOL, IMPORTS, SPICEDB] = STEP_NAMES;
/** The wait for the process to serve, reported like a step. */
const SERVING = 'serving';

export const BootWarmUpStepOutcomeSchema = Schema.Literals(['completed', 'failed', 'timed-out']);
export type BootWarmUpStepOutcome = typeof BootWarmUpStepOutcomeSchema.Type;

/**
 * A step that did not complete. Its cause stays redacted and is never logged: the one WARN line names the step only.
 */
export class BootWarmUpStepFailed extends Schema.TaggedError<BootWarmUpStepFailed>()('BootWarmUpStepFailed', {
  cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())),
  step: Schema.Union([BootWarmUpStepNameSchema, Schema.Literal(SERVING)]),
}) {}

export interface BootWarmUpStep {
  readonly name: BootWarmUpStepName;
  readonly run: Effect.Effect<void, BootWarmUpStepFailed>;
}

export interface BootWarmUpPlan {
  /**
   * Completes once the process is about to serve traffic (its composition is published). Connections opened before
   * that would idle out before the first request; the steps wait for it, up to `servingTimeout`.
   */
  readonly serving: Effect.Effect<void, BootWarmUpStepFailed>;
  readonly steps: readonly BootWarmUpStep[];
}

export interface BootWarmUpBudget {
  /** Polling interval of `serving` while it fails. */
  readonly servingRetry: Duration.Input;
  readonly servingTimeout: Duration.Input;
  readonly stepTimeout: Duration.Input;
  readonly totalTimeout: Duration.Input;
}

/**
 * The serving wait matches the deployment readiness budget (each probe is one loopback composition read, which the host
 * answers from one authority row read); the warm-up itself is bounded to 5 seconds.
 */
export const DEFAULT_BOOT_WARM_UP_BUDGET: BootWarmUpBudget = Object.freeze({
  servingRetry: Duration.seconds(2),
  servingTimeout: Duration.minutes(15),
  stepTimeout: Duration.seconds(4),
  totalTimeout: Duration.seconds(5),
});

/** The one line a failed or timed-out warm-up logs: fixed text, step names and outcomes only. */
export const BOOT_WARM_UP_INCOMPLETE = 'Boot warm-up incomplete; the process serves without it';
export const BOOT_WARM_UP_COMPLETED = 'Boot warm-up completed';

/** The only statement the database step sends. */
export const BOOT_WARM_UP_STATEMENT = 'select 1';
/** At most this many pooled sessions are opened, never more than the pool allows. */
export const BOOT_WARM_UP_DATABASE_SESSIONS = 2;
/** Lazy imports load a few at a time. */
const IMPORT_CONCURRENCY = 4;

/** Wraps a step's failure; the cause is kept redacted for a debugger, never for the log line. */
export const asBootWarmUpStep =
  (step: BootWarmUpStepName | typeof SERVING) =>
  <Value, Failure, Requirements>(
    effect: Effect.Effect<Value, Failure, Requirements>,
  ): Effect.Effect<void, BootWarmUpStepFailed, Requirements> =>
    effect.pipe(
      Effect.asVoid,
      Effect.mapError((cause) => new BootWarmUpStepFailed({ cause: Redacted.make(cause), step })),
    );

/** The pool a request draws from, reduced to running one fixed read-only statement. */
export interface BootWarmUpDatabasePool<Failure> {
  readonly maxConnections: number;
  readonly run: (statement: typeof BOOT_WARM_UP_STATEMENT) => Effect.Effect<unknown, Failure>;
}

/** Runs `select 1` concurrently, so the pool opens min(2, maxConnections) sessions. */
export const databasePoolWarmUp = <OpenFailure, StatementFailure>(
  pool: Effect.Effect<Option.Option<BootWarmUpDatabasePool<StatementFailure>>, OpenFailure>,
): BootWarmUpStep => ({
  name: DATABASE_POOL,
  run: pool.pipe(
    Effect.flatMap(
      Option.match({
        // A process that does not share its pools would warm a pool no request uses.
        onNone: () => Effect.void,
        onSome: (opened) =>
          Effect.forEach(
            EffectArray.makeBy(Math.max(1, Math.min(BOOT_WARM_UP_DATABASE_SESSIONS, opened.maxConnections)), () =>
              opened.run(BOOT_WARM_UP_STATEMENT),
            ),
            (statement) => statement,
            { concurrency: BOOT_WARM_UP_DATABASE_SESSIONS, discard: true },
          ),
      }),
    ),
    asBootWarmUpStep(DATABASE_POOL),
  ),
});

/** Opens a SpiceDB client and reads the schema: no permission check, lookup or write. */
export const spiceDbWarmUp = <Failure>(client: Effect.Effect<SpiceDbRpc, Failure, Scope.Scope>): BootWarmUpStep => ({
  name: SPICEDB,
  run: client.pipe(
    Effect.flatMap((rpc) => rpc.readSchema(v1.ReadSchemaRequest.create({}))),
    Effect.scoped,
    asBootWarmUpStep(SPICEDB),
  ),
});

/** Loads the active snapshot through the cached source the requests use and builds its catalog once. */
export const compositionWarmUp = <Composition, LoadFailure, BuildFailure>(
  load: Effect.Effect<{ readonly composition: Composition }, LoadFailure>,
  buildCatalog: (composition: Composition) => Effect.Effect<unknown, BuildFailure>,
): BootWarmUpStep => ({
  name: COMPOSITION,
  run: load.pipe(
    Effect.flatMap((snapshot) => buildCatalog(snapshot.composition)),
    asBootWarmUpStep(COMPOSITION),
  ),
});

/** Loads modules the request paths import lazily. */
export const importsWarmUp = <ListFailure, ImportFailure>(
  imports: Effect.Effect<readonly Effect.Effect<unknown, ImportFailure>[], ListFailure>,
): BootWarmUpStep => ({
  name: IMPORTS,
  run: imports.pipe(
    Effect.flatMap((loads) => Effect.all(loads, { concurrency: IMPORT_CONCURRENCY, discard: true })),
    asBootWarmUpStep(IMPORTS),
  ),
});

/**
 * Runs one step in its own detached fiber and waits for it at most `timeout`. A timed-out step is interrupted without
 * waiting, so a step that ignores interruption holds neither the warm-up past its budget nor the host's shutdown.
 */
const settle = Effect.fnUntraced(function* settleStep(step: BootWarmUpStep, timeout: Duration.Input) {
  const fiber = yield* Effect.forkDetach(Effect.exit(step.run));
  const settled = yield* Fiber.await(fiber).pipe(Effect.timeoutOption(timeout));
  if (Option.isNone(settled)) {
    yield* Effect.forkDetach(Fiber.interrupt(fiber));
    return [step.name, 'timed-out'] as const;
  }
  const outcome: BootWarmUpStepOutcome =
    Exit.isSuccess(settled.value) && Exit.isSuccess(settled.value.value) ? 'completed' : 'failed';
  return [step.name, outcome] as const;
});

const warnIncomplete = (outcomes: readonly (readonly [string, BootWarmUpStepOutcome])[]) => {
  const incomplete: string[] = [];
  for (const [name, outcome] of outcomes) {
    if (outcome !== 'completed') {
      incomplete.push(`${name}=${outcome}`);
    }
  }
  return Effect.logWarning(BOOT_WARM_UP_INCOMPLETE).pipe(Effect.annotateLogs({ steps: incomplete.join(' ') }));
};

/**
 * Waits until the process serves, then runs every step concurrently within the budget. It never fails: a failed or
 * timed-out step (or serving wait) logs exactly one WARN line naming the steps, and nothing else happens.
 */
export const runBootWarmUp = Effect.fn('BootWarmUp.run')(function* runBootWarmUp(
  plan: BootWarmUpPlan,
  budget: BootWarmUpBudget = DEFAULT_BOOT_WARM_UP_BUDGET,
): Effect.fn.Return<void> {
  const serving = yield* plan.serving.pipe(
    Effect.retry(Schedule.spaced(budget.servingRetry)),
    Effect.timeoutOption(budget.servingTimeout),
    Effect.exit,
  );
  if (Exit.isFailure(serving) || Option.isNone(serving.value)) {
    return yield* warnIncomplete([[SERVING, Exit.isFailure(serving) ? 'failed' : 'timed-out']]);
  }
  const stepTimeout = Duration.min(
    Duration.fromInputUnsafe(budget.stepTimeout),
    Duration.fromInputUnsafe(budget.totalTimeout),
  );
  const started = yield* Clock.currentTimeMillis;
  const settled = yield* Effect.forEach(plan.steps, (step) => settle(step, stepTimeout), {
    // Every step at once; a plan has at most one step of each kind.
    concurrency: STEP_NAMES.length,
  }).pipe(Effect.timeoutOption(budget.totalTimeout));
  const outcomes = Option.getOrElse(settled, () => plan.steps.map((step) => [step.name, 'timed-out'] as const));
  if (outcomes.some(([, outcome]) => outcome !== 'completed')) {
    return yield* warnIncomplete(outcomes);
  }
  const finished = yield* Clock.currentTimeMillis;
  return yield* Effect.logInfo(BOOT_WARM_UP_COMPLETED).pipe(
    Effect.annotateLogs({ durationMs: finished - started, steps: plan.steps.map(({ name }) => name).join(' ') }),
  );
});
