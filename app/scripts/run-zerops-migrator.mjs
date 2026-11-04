/// <reference types="node" />

import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Command, Flag } from 'effect/cli';
import { Reactivity } from 'effect/reactivity';
import { MIGRATION_REQUIREMENTS_ENV, MIGRATION_VERIFY_ONLY_ENV } from './application-migration-publication.mts';
import { pendingMigrationRuntimeIdentityIds } from './application-migration-inventory.mts';
import { Cause, Config, Effect, Exit, Layer, Option } from 'effect';

import {
  assertMigrationVerificationOnly,
  assertSameApplicationMigrationTargets,
  observeApplicationMigrationState,
  reconcileApplicationMigrationOwner,
  prepareApplicationMigrationPlan,
  readApplicationMigrationRequirements,
} from './application-migration-runtime.mts';

const appDirectory = fileURLToPath(new URL('../', import.meta.url));
const { spawn } = process.getBuiltinModule('node:child_process');
const migratorPort = Config.Int('MIGRATOR_PORT').pipe(Config.withDefault(8080));

class MigratorError extends Error {
  /**
   * @param {string} message - Description of the failed migrator operation.
   * @param {unknown} [cause] - Underlying platform failure, when available.
   */
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'MigratorError';
  }
}

/** @param {ReturnType<typeof spawn>} child - Child process owned by the Effect scope. */
const stopChild = (child) =>
  Effect.sync(() => {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
    }
  });

const run = Effect.fn('run')(
  /**
   * @param {string} command - Executable to start.
   * @param {readonly string[]} commandArguments - Arguments passed to the executable.
   * @param {string} cwd - Working directory for the child process.
   * @param {number} [timeout] - Bounded post-attempt verifier/grant process deadline in milliseconds.
   * @yields {unknown} Effect instructions interpreted by `Effect.fn`.
   */
  function* runEffect(command, commandArguments, cwd = appDirectory, timeout = 0) {
    const child = yield* Effect.acquireRelease(
      Effect.try({
        catch: (cause) => new MigratorError(`${command} failed to start`, cause),
        try: () => spawn(command, commandArguments, { cwd, killSignal: 'SIGKILL', stdio: 'inherit', timeout }),
      }),
      stopChild,
    );

    yield* Effect.callback((resume) => {
      const onError = (cause) => {
        resume(Effect.fail(new MigratorError(`${command} failed while running`, cause)));
      };
      /**
       * @param {number | null} code - Numeric process exit code.
       * @param {NodeJS.Signals | null} signal - Signal that terminated the process.
       */
      const onExit = (code, signal) => {
        if (code === 0) {
          resume(Effect.void);
          return;
        }
        const outcome = signal ?? `code ${String(code)}`;
        resume(Effect.fail(new MigratorError(`${command} exited with ${outcome}`)));
      };

      child.once('error', onError);
      child.once('exit', onExit);
      return Effect.sync(() => {
        child.off('error', onError);
        child.off('exit', onExit);
      });
    });
  },
);

/**
 * @param {string} relativePath - Application-relative script path.
 * @param {readonly string[]} [args] - Finite selected runtime options.
 * @param {number} [timeout] - Optional bounded owned process lifetime.
 */
const runAppScript = (relativePath, args = [], timeout = 0) =>
  run(process.execPath, [path.join(appDirectory, relativePath), ...args], appDirectory, timeout);
/**
 * @param {string} relativeDirectory - Application-relative package directory.
 * @param {string} config - Drizzle configuration filename.
 */
const migrate = (relativeDirectory, config) => {
  const workingDirectory = path.join(appDirectory, relativeDirectory);
  return run(
    path.join(workingDirectory, 'node_modules', '.bin', 'drizzle-kit'),
    ['migrate', '--config', config],
    workingDirectory,
  );
};

/** @param {ReturnType<typeof createServer>} server - Readiness server owned by the Effect scope. */
const closeServer = (server) =>
  Effect.callback((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return;
    }
    server.close(() => resume(Effect.void));
  });

const serveReadiness = Effect.fn('serveReadiness')(
  /**
   * @param {number} port - Port used by the readiness server.
   * @yields {unknown} Effect instructions interpreted by `Effect.fn`.
   */
  function* serveReadinessEffect(port) {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        createServer((request, response) => {
          if (request.url === '/ready') {
            response.writeHead(200, {
              'content-type': 'text/plain; charset=utf-8',
            });
            response.end('ready\n');
            return;
          }
          response.writeHead(404).end();
        }),
      ),
      closeServer,
    );

    yield* Effect.callback((resume) => {
      const onError = (cause) => resume(Effect.fail(new MigratorError('The migration readiness server failed', cause)));
      const onListening = () => {
        console.log(`Migration verification complete; readiness listening on port ${String(port)}`);
      };
      const onSignal = () => resume(Effect.void);

      server.once('error', onError);
      server.once('listening', onListening);
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      server.listen(port, '0.0.0.0');

      return Effect.sync(() => {
        server.off('error', onError);
        server.off('listening', onListening);
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      });
    });
  },
);

const recoveryProcessTimeout = 120_000;
/** @param {import('./application-migration-inventory.mts').ApplicationMigrationStream} stream - Source-owned verifier gateways. */
const verifyOwner = (stream) =>
  stream.verifierPaths.length === 0
    ? Effect.fail(new MigratorError('Selected migration owner has no genuine schema verifier'))
    : Effect.forEach(stream.verifierPaths, (verifier) => runAppScript(verifier, [], recoveryProcessTimeout), {
        concurrency: 1,
        discard: true,
      });
/**
 * @param {import('./application-migration-inventory.mts').ApplicationMigrationStream} stream - Selected owner.
 * @param {readonly string[]} identities - Actual pending SQL and owner identity requirements.
 */
const refreshOwnerGrants = (stream, identities) => {
  if (stream.database === 'portal-auth') {
    return runAppScript(
      'verticals/commerce-customer-context/scripts/bootstrap-portal-auth-runtime-role.mts',
      [],
      recoveryProcessTimeout,
    );
  }
  if (identities.length === 0) {
    return Effect.void;
  }
  return runAppScript(
    'scripts/postgres/bootstrap-runtime-role.mts',
    ['--identities', identities.join(',')],
    recoveryProcessTimeout,
  );
};

/**
 * @param {string | undefined} requirementsPath - Reviewed finite requirements; omitted preserves all owners.
 * @param {boolean} verifyOnly - Refuse pending DDL even if observations changed since publication planning.
 */
const main = (requirementsPath, verifyOnly) =>
  Effect.scoped(
    Effect.gen(function* migratorEffect() {
      const requirements = yield* readApplicationMigrationRequirements(requirementsPath);
      const before = yield* prepareApplicationMigrationPlan(requirements);
      yield* Effect.logInfo('Application migration selection', {
        nativeTargets: before.nativeTargets,
        plan: before.plan,
      });
      if (verifyOnly) {
        yield* assertMigrationVerificationOnly(before.plan);
      }
      let infrastructurePrepared = false;
      for (const owner of before.plan.owners) {
        const stream = before.streams.find((candidate) => candidate.ownerId === owner.ownerId);
        if (stream === undefined) {
          return yield* Effect.fail(new MigratorError('Selected migration stream is unavailable'));
        }
        // Ordered restart preflight: a journaled uncertain owner must verify before later owner DDL.
        if (owner.pendingMigrations.length === 0) {
          yield* verifyOwner(stream);
          continue;
        }
        // Restart preflight above precedes every later DDL, including the full-mode infrastructure prerequisite.
        if (requirements.mode === 'all' && !infrastructurePrepared) {
          yield* runAppScript('scripts/postgres/bootstrap-spicedb-database.mts');
          infrastructurePrepared = true;
        }
        const identities = pendingMigrationRuntimeIdentityIds(stream, owner.pendingMigrations);
        if (identities.length > 0) {
          yield* runAppScript('scripts/postgres/bootstrap-runtime-role.mts', ['--identities', identities.join(',')]);
        }
        for (const preparation of stream.preparationScripts) {
          yield* runAppScript(preparation);
        }
        // Role/bootstrap preparation can change the catalog legitimately; retain a fresh native before-state.
        const fresh = yield* prepareApplicationMigrationPlan(requirements);
        yield* assertSameApplicationMigrationTargets(before.nativeTargets, fresh.nativeTargets);
        const attempted = fresh.plan.owners.find((candidate) => candidate.ownerId === owner.ownerId);
        if (attempted === undefined) {
          return yield* Effect.fail(new MigratorError('Selected native migration observation is unavailable'));
        }
        if (attempted.pendingMigrations.length === 0) {
          yield* verifyOwner(stream);
        } else {
          const verifyCommitted = refreshOwnerGrants(stream, identities).pipe(Effect.andThen(verifyOwner(stream)));
          const inspectOutcome = Effect.gen(function* observeNativeOutcome() {
            const observed = yield* observeApplicationMigrationState([stream]);
            yield* assertSameApplicationMigrationTargets(
              fresh.nativeTargets.filter((target) => target.databaseKind === stream.database),
              observed.nativeTargets,
            );
            const [afterOwner] = observed.observations;
            if (afterOwner === undefined) {
              return yield* Effect.fail(new MigratorError('The native migration outcome could not be observed'));
            }
            return yield* reconcileApplicationMigrationOwner(attempted, afterOwner, verifyCommitted);
          });
          yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* reconcileNativeAttempt() {
              const operation = yield* Effect.exit(
                restore(Effect.scoped(migrate(stream.directory, stream.configFile))),
              );
              const reconciliation = yield* Effect.exit(inspectOutcome);
              if (Exit.isFailure(operation)) {
                yield* Effect.logError(
                  'Native owner attempt failed; original failure and sealed reconciliation debt retained',
                  {
                    outcome: Exit.isSuccess(reconciliation) ? reconciliation.value : 'unverified',
                    ownerId: owner.ownerId,
                  },
                );
                return yield* Effect.failCause(operation.cause);
              }
              if (Exit.isFailure(reconciliation)) {
                return yield* Effect.failCause(reconciliation.cause);
              }
              if (reconciliation.value !== 'committed') {
                return yield* Effect.fail(
                  new MigratorError('Native migrator returned without committing the planned owner journal and schema'),
                );
              }
              return yield* Effect.void;
            }),
          );
        }
      }
      // Re-observe committed journals before reporting completion; a child exit alone is not durable evidence.
      const after = yield* prepareApplicationMigrationPlan(requirements);
      yield* assertSameApplicationMigrationTargets(before.nativeTargets, after.nativeTargets);
      if (after.plan.owners.some((owner) => owner.pendingMigrations.length > 0)) {
        return yield* Effect.fail(
          new MigratorError('Selected migrations remain pending after the native migrator returned'),
        );
      }
      const verifiers = after.plan.owners.filter((owner) => owner.verify).map((owner) => owner.ownerId);
      if (verifiers.length > 0) {
        yield* runAppScript(
          'scripts/verify-application-db-schema.mts',
          requirementsPath === undefined ? [] : ['--requirements', requirementsPath],
        );
      }
      yield* Effect.logInfo('Application migration verification complete', {
        nativeTargets: after.nativeTargets,
        owners: after.plan.owners.map((owner) => ({
          ...owner,
          verification: owner.verify ? 'verified' : owner.verification,
        })),
      });
      return yield* serveReadiness(yield* migratorPort);
    }).pipe(Effect.tapCause((cause) => Effect.logError(Cause.pretty(cause)))),
  );
const cli = Command.make(
  'run-zerops-migrator',
  {
    requirements: Flag.String('requirements').pipe(
      Flag.withFallbackConfig(Config.String(MIGRATION_REQUIREMENTS_ENV)),
      Flag.optional,
    ),
    verifyOnly: Flag.Boolean('verify-only').pipe(
      Flag.withFallbackConfig(Config.Boolean(MIGRATION_VERIFY_ONLY_ENV)),
      Flag.withDefault(false),
    ),
  },
  ({ requirements, verifyOnly }) => main(Option.getOrUndefined(requirements), verifyOnly),
);
if (import.meta.main) {
  const exit = await Effect.runPromiseExit(
    Command.run(cli, { version: '1.0.0' }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
