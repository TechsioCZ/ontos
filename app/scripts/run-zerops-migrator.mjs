/// <reference types="node" />
/* oxlint-disable sonarjs/no-duplicate-string -- The governed topology validator requires the literal Drizzle config name beside every ordered owner migration; expires: 2027-03-01. */

import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Cause, Config, Console, Duration, Effect, Layer, Option } from 'effect';
import { Reactivity } from 'effect/reactivity';

import { accessReleaseActivationArguments } from './access-release-activation-child.mts';
import { OwnerMigrationPlanner, OwnerMigrationPlannerLive } from './application-migration-pending.mts';
import { timedBootStage } from './zerops/boot-stage-timing.mts';
import { loadOptionalCommercePortalAuthDatabaseConfig } from '../verticals/commerce-customer-context/scripts/portal-auth-database-config.mts';

const appDirectory = fileURLToPath(new URL('../', import.meta.url));
const { spawn } = process.getBuiltinModule('node:child_process');
const migratorPort = Config.Int('MIGRATOR_PORT').pipe(Config.withDefault(8080));
/** How long the access catalog release activation may take before the release goes on without it. */
const ACCESS_RELEASE_ACTIVATION_BUDGET = Duration.minutes(5);
// The app host runs the same chain once before it publishes; the standalone migrator stays up for readiness.
const migrateOnce = Config.Boolean('MIGRATOR_ONCE').pipe(Config.withDefault(false));

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

/** How long a stopped child may take to finish before it is killed: a projection under way runs to its end. */
const CHILD_STOP_GRACE = Duration.minutes(2);

/**
 * Stops a child that is still running: SIGTERM, then wait for it to exit, and SIGKILL only once the grace is spent.
 * The access release activation turns SIGTERM into an interrupt and finishes a tenant projection that holds the
 * tenant's access fence before it exits, so the fence is never left held by a child stopped for time.
 * @param {ReturnType<typeof spawn>} child - Child process owned by the Effect scope.
 */
const stopChild = (child) =>
  Effect.callback((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.void);
      return Effect.void;
    }
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
    }, Duration.toMillis(CHILD_STOP_GRACE));
    const onExit = () => {
      clearTimeout(killer);
      resume(Effect.void);
    };
    child.once('exit', onExit);
    child.kill('SIGTERM');
    return Effect.sync(() => {
      clearTimeout(killer);
      child.off('exit', onExit);
    });
  });

const run = Effect.fn('run')(
  /**
   * @param {string} command - Executable to start.
   * @param {readonly string[]} commandArguments - Arguments passed to the executable.
   * @param {string} cwd - Working directory for the child process.
   * @yields {unknown} Effect instructions interpreted by `Effect.fn`.
   */
  function* runEffect(command, commandArguments, cwd = appDirectory) {
    const child = yield* Effect.acquireRelease(
      Effect.try({
        catch: (cause) => new MigratorError(`${command} failed to start`, cause),
        try: () => spawn(command, commandArguments, { cwd, stdio: 'inherit' }),
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
 * @param {readonly string[]} [scriptArguments] - Arguments after the script path.
 */
const runAppScript = (relativePath, scriptArguments = []) =>
  run(process.execPath, [path.join(appDirectory, relativePath), ...scriptArguments]);

/** @param {'core' | 'party'} owner - Reviewed owner whose histories converge as one ordered group. */
const migrateConvergentOwner = (owner) =>
  run(process.execPath, [path.join(appDirectory, 'scripts/migration-convergence-cli.mts'), owner]);

/**
 * One owner's native migration. `drizzle-kit migrate` is left out only when its journal provably holds every local
 * migration by name and SQL hash (Drizzle's own name rule) AND drizzle-kit's own folder checks pass in process
 * (`application-migration-pending.mts`); any doubt starts it exactly as before. Either way the owner gets one line.
 * @param {string} relativeDirectory - Application-relative package directory.
 * @param {string} config - Drizzle configuration filename.
 */
const migrate = (relativeDirectory, config) =>
  Effect.gen(function* migrateOwner() {
    const owner = `${relativeDirectory} (${config})`;
    const decision = yield* (yield* OwnerMigrationPlanner).decide(relativeDirectory, config);
    if (decision.nothingToApply) {
      return yield* Console.log(`[migrator] ${owner}: ${decision.reason}; drizzle-kit not started`);
    }
    yield* Console.log(`[migrator] ${owner}: ${decision.reason}; running drizzle-kit migrate`);
    const workingDirectory = path.join(appDirectory, relativeDirectory);
    yield* run(
      path.join(workingDirectory, 'node_modules', '.bin', 'drizzle-kit'),
      ['migrate', '--config', config],
      workingDirectory,
    );
    const applied = decision.pending.length > 0 ? `applied ${String(decision.pending.length)}` : 'migrate finished';
    return yield* Console.log(`[migrator] ${owner}: ${applied}`);
  });

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

/**
 * Access catalog release activation: publishes the deployed catalog when it is newer, lets "Plný přístup" follow it
 * and records Novinky for every other role. It never fails the release: authorization then stays at the previous
 * release, which keeps every new capability denied, and the next activation retries. It is bounded, and its child
 * process is stopped on expiry, so an unreachable engine never holds a deployment.
 */
const activateAccessRelease = Effect.scoped(
  run(process.execPath, [...accessReleaseActivationArguments(appDirectory)]),
).pipe(
  Effect.timeoutOrElse({
    duration: ACCESS_RELEASE_ACTIVATION_BUDGET,
    orElse: () => Effect.fail(new MigratorError('the activation exceeded its time budget')),
  }),
  // Timed before the failure is reported and let go, so a failed or overrun activation logs `outcome=failed`.
  timedBootStage('migrator.access-release-activation'),
  Effect.matchEffect({
    onFailure: (error) =>
      Effect.logError(
        `ACCESS CATALOG RELEASE ACTIVATION FAILED (${error.message}); authorization stays at the previous release until the next activation`,
      ),
    onSuccess: () => Effect.void,
  }),
);

const ownerMigrations = Effect.gen(function* ownerMigrationsEffect() {
  yield* migrateConvergentOwner('core');
  yield* migrate('apps/shell-super-app', 'drizzle.auth.config.ts');
  yield* migrateConvergentOwner('party');
  yield* migrate('verticals/payment-term-catalog', 'drizzle.config.ts');
  yield* migrate('verticals/price-group-catalog', 'drizzle.config.ts');
  yield* migrate('verticals/assortment', 'drizzle.config.ts');
  yield* migrate('verticals/commerce-customer-context', 'drizzle.config.ts');
  yield* migrate('verticals/commerce-market-catalog', 'drizzle.config.ts');
  yield* migrate('verticals/catalog', 'drizzle.config.ts');
  yield* migrate('verticals/inventory', 'drizzle.config.ts');
  yield* migrate('verticals/pricing', 'drizzle.config.ts');
  yield* migrate('verticals/privacy', 'drizzle.config.ts');
  yield* migrate('verticals/storefront-registry', 'drizzle.config.ts');
  yield* migrate('verticals/tax', 'drizzle.config.ts');
  // <generated-vertical-provider-migrations>
  yield* migrate('verticals/property-portfolio', 'drizzle.config.ts');
  yield* migrate('verticals/property-leasing', 'drizzle.config.ts');
  yield* migrate('verticals/legal-agreements', 'drizzle.config.ts');
  yield* migrate('verticals/work-tasks', 'drizzle.config.ts');
  yield* migrate('verticals/workforce', 'drizzle.config.ts');
  yield* migrate('verticals/tagging', 'drizzle.config.ts');
  yield* migrate('verticals/sales-pipeline', 'drizzle.config.ts');
  yield* migrate('verticals/merchandise', 'drizzle.config.ts');
  yield* migrate('verticals/facility-operations', 'drizzle.config.ts');
  yield* migrate('verticals/sales-insights', 'drizzle.config.ts');
  yield* migrate('verticals/finance-billing', 'drizzle.config.ts');
  yield* migrate('verticals/crm-activities', 'drizzle.config.ts');
  yield* migrate('verticals/crm', 'drizzle.config.ts');
  yield* migrate('verticals/projects', 'drizzle.config.ts');
  yield* migrate('verticals/commerce-cart', 'drizzle.config.ts');
  yield* migrate('verticals/commerce-order', 'drizzle.config.ts');
  yield* migrate('verticals/payment', 'drizzle.config.ts');
  yield* migrate('verticals/promotion', 'drizzle.config.ts');
  yield* migrate('verticals/symmy-integration', 'drizzle.config.ts');
  // </generated-vertical-provider-migrations>
  return yield* Effect.void;
});

/** Role bootstrap, every owner's migrations, the role bootstrap again and the optional portal-auth database. */
const migrations = Effect.gen(function* migrationsEffect() {
  // Validate the optional owner's complete configuration before any migration writes.
  const portalAuthDatabase = yield* loadOptionalCommercePortalAuthDatabaseConfig();
  yield* runAppScript('scripts/postgres/bootstrap-spicedb-database.mts').pipe(
    timedBootStage('migrator.spicedb-database-bootstrap'),
  );
  yield* runAppScript('scripts/postgres/bootstrap-runtime-role.mts').pipe(timedBootStage('migrator.runtime-role'));
  yield* ownerMigrations.pipe(timedBootStage('migrator.owner-migrations'));
  yield* runAppScript('scripts/postgres/bootstrap-runtime-role.mts').pipe(
    timedBootStage('migrator.runtime-role-after-migrations'),
  );
  if (Option.isSome(portalAuthDatabase)) {
    yield* Effect.gen(function* portalAuthDatabaseEffect() {
      yield* migrate('verticals/commerce-customer-context', 'drizzle.portal-auth.config.ts');
      yield* runAppScript('verticals/commerce-customer-context/scripts/bootstrap-portal-auth-runtime-role.mts');
      yield* runAppScript('verticals/commerce-customer-context/scripts/verify-portal-auth-db-schema.mts');
    }).pipe(timedBootStage('migrator.portal-auth'));
  }
  return yield* Effect.void;
});

/**
 * Owner schema verifiers at once on stage. Each is one Node process with one or two admin connections for read-only
 * catalog queries, so six add at most twelve connections to db18 (150 slots) while the old release still serves from
 * its pools of six per process and role, and about 1 GiB of short-lived processes beside the starting owners.
 */
const OWNER_VERIFIER_CONCURRENCY = 6;

/**
 * The old gate order, serial: every owner's schema is verified, and only then does the access catalog release
 * activation start. A schema that fails its check stops the boot before the activation can publish a catalog,
 * extend "Plný přístup" or reconcile SpiceDB.
 */
const verificationAndActivation = Effect.gen(function* verificationAndActivationEffect() {
  yield* runAppScript('scripts/verify-application-db-schema.mts', [
    '--concurrency',
    String(OWNER_VERIFIER_CONCURRENCY),
  ]).pipe(timedBootStage('migrator.schema-verification'));
  return yield* activateAccessRelease;
});

const main = Effect.scoped(
  Effect.gen(function* migratorEffect() {
    yield* Effect.andThen(migrations, verificationAndActivation).pipe(timedBootStage('migrator.total'));
    if (!(yield* migrateOnce)) {
      yield* serveReadiness(yield* migratorPort);
    }
  }).pipe(Effect.tapCause((cause) => Effect.logError(Cause.pretty(cause)))),
);

/** The migrator process's services, provided once at its executable edge. */
const MigratorLive = Layer.mergeAll(
  NodeServices.layer,
  OwnerMigrationPlannerLive(appDirectory).pipe(Layer.provide(Reactivity.layer)),
);

// SIGTERM (a container stop) interrupts the migrator instead of killing it, so its running child is stopped
// gracefully by `stopChild` rather than orphaned or killed in the middle of a projection.
NodeRuntime.runMain(main.pipe(Effect.provide(MigratorLive)), { disableErrorReporting: true });
