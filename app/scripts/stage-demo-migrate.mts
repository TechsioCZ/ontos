#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Clock, Config, Console, Deferred, Duration, Effect, Exit, Layer, Option, Path, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { FetchHttpClient } from 'effect/unstable/http';
import { ChildProcess } from 'effect/unstable/process';

import {
  APPLICATION_COMPOSITION_PUBLICATION_BUDGETS,
  ApplicationCompositionAuthorityAdminDatabaseLive,
  ApplicationCompositionReadinessSchema,
  readApplicationCompositionReadiness,
  withApplicationCompositionReadinessDeadline,
  runApplicationCompositionMigration,
  verifyMigratedApplicationCompositionForPublication,
} from './application-composition-authority-publication.mts';
import type {
  ApplicationCompositionMigrationBudgets,
  ApplicationCompositionReadiness,
} from './application-composition-authority-publication.mts';
import type { StageDeployDiagnosticInput, StageDeployStatus } from './stage-deploy-diagnostics.mts';
import { writeStageDeployDiagnostic } from './stage-deploy-diagnostics.mts';
import { verifyInitialCompositionCutover } from './initial-composition-cutover.mts';
import { ZeropsPublicApiLive } from './zerops-public-api.mts';

const DIAGNOSTIC_TIMEOUT = 'diagnostic-timeout';
const SUMMARY_UNAVAILABLE = 'Stage deployment summary unavailable; the migration outcome is unchanged.';
const AUTHORITY_FAILURE =
  'The stage migration authority check failed; completion is unproven. Inspect native authority and owner evidence before retrying.';
const PHASE_TIMEOUT_MESSAGE =
  'The publication phase deadline expired; pending work is not proof of a dead owner. Authority completion is uncertain; admission was not reopened. Inspect native state before retrying.';

export class StageDemoMigrationError extends Schema.TaggedError<StageDemoMigrationError>()('StageDemoMigrationError', {
  authorityPhase: Schema.optionalKey(Schema.String),
  childStarted: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Literal('unknown')])),
  exitCode: Schema.optionalKey(Schema.Number),
  message: Schema.String,
  migrationsCompleted: Schema.optionalKey(Schema.Boolean),
  migrationStarted: Schema.optionalKey(Schema.Boolean),
  phase: Schema.optionalKey(Schema.String),
}) {}

export interface StageDemoDiagnosticOptions {
  /** Trusted runner configuration, never an owner payload or a CLI argument. */
  readonly summaryFile?: string;
}

const configuredDiagnosticOptions = Effect.gen(function* readTrustedRunnerSummaryPath() {
  const summaryFile = yield* Config.option(Config.String('GITHUB_STEP_SUMMARY')).pipe(
    Effect.mapError(
      () => new StageDemoMigrationError({ message: 'Runner diagnostic output configuration is unavailable' }),
    ),
  );
  return { summaryFile: Option.getOrUndefined(summaryFile) };
});

/** Secondary diagnostic IO must not replace success, failure or interruption of the migration. */
const reportDiagnostic = (
  input: StageDeployDiagnosticInput,
  options: StageDemoDiagnosticOptions,
  annotationStream: 'stderr' | 'stdout' = 'stdout',
) =>
  writeStageDeployDiagnostic(input, { ...options, annotationStream }).pipe(
    Effect.catchTag('StageDeployDiagnosticError', () => Console.error(SUMMARY_UNAVAILABLE)),
  );

const initialCutover = Effect.gen(function* verifyStageInitialCutover() {
  const [inventoryFile, receiptFile] = yield* Effect.all([
    Config.String('ONTOS_INITIAL_COMPOSITION_EXECUTION_INVENTORY_FILE'),
    Config.String('ONTOS_INITIAL_COMPOSITION_CUTOVER_RECEIPT_FILE'),
  ]);
  yield* verifyInitialCompositionCutover({ environment: 'stage', inventoryFile, receiptFile });
});

/** The workflow prepares identities first; owner, final-grant and portal migrations all remain inside the seal. */
export const migrateStageDemoOwnerSchemas = Effect.fn('StageDemo.migrateOwnerSchemas')(
  function* migrateStageDemoOwnerSchemas(
    budgets: ApplicationCompositionMigrationBudgets = {},
    diagnostics: StageDemoDiagnosticOptions = {},
  ) {
    let childStarted: boolean | 'unknown' = false;
    let migrationsCompleted = false;
    let phase: StageDeployDiagnosticInput['phase'] = 'unknown';
    let timeoutDiagnostic: StageDeployDiagnosticInput | undefined;
    const startedAt = yield* Clock.currentTimeMillis;
    const path = yield* Path.Path;
    const migration = Effect.scoped(
      Effect.gen(function* runRunnerLocalOwnerMigrations() {
        phase = 'migration';
        childStarted = 'unknown';
        const child = yield* ChildProcess.make('pnpm', ['db:migrate:prepared:internal'], {
          cwd: path.resolve(import.meta.dirname, '..'),
          extendEnv: true,
          stderr: 'inherit',
          stdin: 'ignore',
          stdout: 'inherit',
        });
        childStarted = true;
        const exitCode = yield* child.exitCode;
        if (exitCode !== 0) {
          return yield* new StageDemoMigrationError({
            childStarted,
            exitCode,
            message: 'The stage owner migration chain failed',
          });
        }
        migrationsCompleted = true;
        phase = 'migration-complete';
        return yield* Effect.void;
      }),
    ).pipe(
      Effect.catchTag('PlatformError', () =>
        Effect.fail(
          new StageDemoMigrationError({ childStarted, message: 'The runner-local stage migration process failed' }),
        ),
      ),
    );
    yield* runApplicationCompositionMigration(migration, initialCutover, budgets).pipe(
      Effect.catchTag('ApplicationCompositionPublicationTimeout', (failure) =>
        Effect.gen(function* retainMigrationTimeout() {
          timeoutDiagnostic = {
            authorityPhase: failure.authorityPhase,
            budgetMs: failure.budgetMs,
            migrationsCompleted: failure.migrationsCompleted,
            migrationStarted: childStarted,
            phase: failure.phase,
            reason: 'phase-timeout',
            status: 'failed',
          };
          return yield* new StageDemoMigrationError({
            authorityPhase: failure.authorityPhase,
            childStarted,
            message: PHASE_TIMEOUT_MESSAGE,
            migrationsCompleted: failure.migrationsCompleted,
            migrationStarted: failure.migrationStarted,
            phase: failure.phase,
          });
        }),
      ),
      Effect.catch((error) =>
        Schema.is(StageDemoMigrationError)(error)
          ? Effect.fail(error)
          : Effect.fail(new StageDemoMigrationError({ childStarted, message: AUTHORITY_FAILURE })),
      ),
      Effect.onExit((exit) =>
        Effect.gen(function* reportMigrationOutcome() {
          let input: StageDeployDiagnosticInput = {
            authorityPhase: 'unknown',
            budgetMs: null,
            migrationsCompleted,
            migrationStarted: childStarted,
            phase,
            reason: 'phase-failed',
            status: 'failed',
          };
          if (Exit.hasInterrupts(exit)) {
            input = { ...input, reason: 'interrupted', status: 'aborted' };
          } else if (Exit.isSuccess(exit)) {
            input = { ...input, reason: 'unknown', status: 'completed' };
          } else if (timeoutDiagnostic !== undefined) {
            input = timeoutDiagnostic;
          }
          yield* reportDiagnostic(
            {
              ...input,
              childMigrationBudgetMs: budgets.migrationMs ?? APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.migrationMs,
              drainBudgetMs: budgets.drainMs ?? APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.drainMs,
              elapsedMs: (yield* Clock.currentTimeMillis) - startedAt,
              totalBudgetMs: budgets.totalMs ?? APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.totalMs,
            },
            diagnostics,
          );
        }),
      ),
    );
  },
);

/** Continuation is explicit; the workflow separately verifies the completed migration's source and run. */
const runStageDemoMigration = Effect.fn('StageDemo.runMigration')(function* runStageDemoMigration(
  continuePublication: boolean,
) {
  if (!continuePublication) {
    return yield* migrateStageDemoOwnerSchemas();
  }
  const expectedRevision = yield* Config.String('ONTOS_RETIRED_COMPOSITION_REVISION').pipe(
    Effect.mapError(() => new StageDemoMigrationError({ message: 'The retired composition revision is required' })),
  );
  return yield* verifyMigratedApplicationCompositionForPublication(expectedRevision);
});

/** JSON is advisory only. A non-ready check exits unsuccessfully and never invokes migration. */
const reportReadiness = (result: ApplicationCompositionReadiness, diagnostics: StageDemoDiagnosticOptions = {}) =>
  Effect.gen(function* reportStageReadiness() {
    let status: StageDeployStatus = 'blocked';
    if (result.reason === DIAGNOSTIC_TIMEOUT) {
      status = DIAGNOSTIC_TIMEOUT;
    } else if (result.status === 'ready') {
      status = 'ready';
    } else if (result.reason === 'pending-work') {
      status = 'waiting';
    } else if (result.status === 'unknown') {
      status = 'unknown';
    }
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(ApplicationCompositionReadinessSchema))(result);
    yield* Console.log(json);
    yield* reportDiagnostic(
      {
        authorityPhase: result.authority?.phase ?? 'unknown',
        budgetMs: APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.diagnosticMs,
        counts: result.blockers,
        elapsedMs: null,
        migrationsCompleted: false,
        migrationStarted: false,
        phase: 'readiness',
        reason: result.reason,
        status,
      },
      diagnostics,
      'stderr',
    );
    if (result.status !== 'ready') {
      return yield* new StageDemoMigrationError({
        childStarted: false,
        message: `Read-only migration readiness: ${result.reason}. This result does not authorize migration.`,
        phase: 'readiness',
      });
    }
    return yield* Effect.void;
  });

export const stageDemoMigrationCommand = Command.make(
  'stage-demo-migrate',
  {
    continuePublication: Flag.Boolean('continue-publication').pipe(
      Flag.withDefault(false),
      Flag.withDescription('Verify an exact completed migration only; never recover an incomplete migration.'),
    ),
    drainBudgetMs: Flag.String('drain-budget-ms').pipe(
      Flag.withDefault(`${APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.drainMs}`),
      Flag.withDescription('Positive drain deadline in milliseconds, default 300000, within the total deadline.'),
    ),
    migrationBudgetMs: Flag.String('migration-budget-ms').pipe(
      Flag.withDefault(`${APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.migrationMs}`),
      Flag.withDescription(
        'Positive child deadline in milliseconds, default 840000, clamped to the remaining total deadline.',
      ),
    ),
    readiness: Flag.Boolean('readiness').pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        'Read-only advisory JSON and sanitized stderr; no lock or settlement; diagnostic deadline 50000ms.',
      ),
    ),
    totalBudgetMs: Flag.String('total-budget-ms').pipe(
      Flag.withDefault(`${APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.totalMs}`),
      Flag.withDescription(
        'Positive publication deadline in milliseconds, default and maximum 1200000, including lock waits.',
      ),
    ),
  },
  ({ continuePublication, drainBudgetMs, migrationBudgetMs, readiness, totalBudgetMs }) =>
    Effect.gen(function* runStageMigrationCommand() {
      const diagnostics = yield* configuredDiagnosticOptions;
      if (readiness && continuePublication) {
        return yield* new StageDemoMigrationError({
          message: 'Readiness and completed-migration continuation are mutually exclusive',
        });
      }
      if (readiness) {
        return yield* withApplicationCompositionReadinessDeadline(readApplicationCompositionReadiness).pipe(
          Effect.flatMap((result) => reportReadiness(result, diagnostics)),
        );
      }
      const values = [drainBudgetMs, migrationBudgetMs, totalBudgetMs];
      if (
        values.some(
          (value) =>
            !/^[1-9][0-9]*$/u.test(value) ||
            !Number.isSafeInteger(Number(value)) ||
            Number(value) > APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.totalMs,
        )
      ) {
        return yield* new StageDemoMigrationError({
          message: 'Phase budgets must be positive millisecond integers no greater than 1200000',
        });
      }
      if (continuePublication) {
        return yield* runStageDemoMigration(true);
      }
      return yield* migrateStageDemoOwnerSchemas(
        {
          drainMs: Number(drainBudgetMs),
          migrationMs: Number(migrationBudgetMs),
          totalMs: Number(totalBudgetMs),
        },
        diagnostics,
      );
    }),
);

if (import.meta.main) {
  const services = Layer.mergeAll(ApplicationCompositionAuthorityAdminDatabaseLive, ZeropsPublicApiLive).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
  );
  NodeRuntime.runMain(
    Effect.gen(function* runStageMigrationEntrypoint() {
      const diagnostics = yield* configuredDiagnosticOptions;
      const mode = yield* Deferred.make<boolean>();
      const command = Command.run({ version: '1.0.0' })(
        stageDemoMigrationCommand.pipe(
          Command.provide(() => services),
          // The parsed mode starts the deadline before service provisioning, without reparsing argv.
          Command.provideEffectDiscard(({ readiness }) => Deferred.succeed(mode, readiness)),
        ),
      ).pipe(
        Effect.catchTag('ApplicationCompositionAuthorityError', () =>
          Effect.flatMap(Deferred.await(mode), (readiness) =>
            readiness
              ? reportReadiness(
                  { advisoryOnly: true, reason: 'diagnostic-unavailable', status: 'unknown' },
                  diagnostics,
                )
              : reportDiagnostic(
                  {
                    authorityPhase: 'unknown',
                    migrationsCompleted: false,
                    migrationStarted: false,
                    phase: 'unknown',
                    reason: 'phase-failed',
                    status: 'failed',
                  },
                  diagnostics,
                ).pipe(Effect.andThen(Effect.fail(new StageDemoMigrationError({ message: AUTHORITY_FAILURE })))),
          ),
        ),
      );
      const watchdog = Deferred.await(mode).pipe(
        Effect.flatMap((readiness) =>
          readiness
            ? Effect.sleep(Duration.millis(APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.diagnosticMs)).pipe(
                Effect.andThen(
                  reportReadiness({ advisoryOnly: true, reason: DIAGNOSTIC_TIMEOUT, status: 'unknown' }, diagnostics),
                ),
              )
            : Effect.never,
        ),
      );
      return yield* Effect.raceFirst(command, watchdog);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}
