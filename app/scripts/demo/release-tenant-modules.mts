#!/usr/bin/env node
/**
 * Release step: install the modules stage's release rules require and a Tenant still lacks (`stage-tenant-modules.mts`:
 * Tax wherever Merchandise or Finance Billing is active), through
 * `packages/core-runtime/src/install/release-tenant-modules.ts`. The Tenants are derived from Core's module states.
 *
 * The app host runs it once per release, right after it publishes the composition, so the module is checked against
 * the composition that now serves. It acts as the platform: the state and history rows are written as `system`, and
 * each Tenant that gained a module is reconciled into SpiceDB under its platform release actor. It needs the host's
 * own settings only (`DATABASE_URL`, `SPICEDB_*`, `ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL`,
 * `ULTRAMODERN_DEPLOYMENT_ENVIRONMENT`); outside `stage` it does nothing. It prints one line per Tenant and module and
 * exits 1 when any of them failed, which the app host reports loudly without holding the boot.
 *
 *   node scripts/demo/release-tenant-modules.mts
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Cause, Config, Console, DateTime, Duration, Effect, Exit, Layer, Predicate, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { APP_DATABASE_IDENTITY_ENROLLMENT } from '../../database/identity-enrollment.ts';
import { AccessReleaseStoreLive } from '../../packages/core-runtime/src/access/changes/persistence/drizzle-store.ts';
import { CoreAuthorizationProjectionCompilerLive } from '../../packages/core-runtime/src/access/compiler/spice-db-compiler.ts';
import { AccessProjectionWriterLive } from '../../packages/core-runtime/src/access/intent/projection-writer.ts';
import { TenantIntentLoaderLive } from '../../packages/core-runtime/src/access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../../packages/core-runtime/src/access/lifecycle/persistence/journal-store.ts';
import { CoreDatabaseLive } from '../../packages/core-runtime/src/db/client.ts';
import { DatabaseConfig, parseDatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import { DatabaseIdentityEnrollmentContext } from '../../packages/core-runtime/src/db/database-identities.ts';
import {
  deriveReleaseTenantModules,
  installReleaseTenantModules,
} from '../../packages/core-runtime/src/install/release-tenant-modules.ts';
import type { ReleaseTenantModulesReport } from '../../packages/core-runtime/src/install/release-tenant-modules.ts';
import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
} from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { buildApplicationCompositionCatalog } from '../../packages/core-runtime/src/modules/application-composition-catalog.ts';
import { loadSpiceDbConfig, SpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { stageReleaseModuleRules } from './stage-tenant-modules.mts';

const LOG_PREFIX = '[release-modules]';
/**
 * The step's own time limit, enforced here and not by killing the process: installs stop being started at the
 * deadline, and a projection is only started with enough of it left to finish (`RELEASE_RECONCILE_RESERVE`).
 */
export const RELEASE_MODULES_BUDGET = Duration.minutes(3);

export class ReleaseTenantModulesFailure extends Schema.TaggedError<ReleaseTenantModulesFailure>()(
  'ReleaseTenantModulesFailure',
  { reason: Schema.String },
) {}
const failure = (reason: string) => new ReleaseTenantModulesFailure({ reason });

/** The runtime identity, the engine and the one projection writer, as the access release activation composes them. */
const ReleaseRuntimeLive = Layer.unwrap(
  Effect.gen(function* releaseModulesRuntime() {
    const url = yield* Config.Redacted('DATABASE_URL').pipe(Effect.mapError(() => failure('DATABASE_URL is required')));
    const configuration = yield* parseDatabaseConfig({ DATABASE_URL: Redacted.value(url) }).pipe(
      Effect.mapError(() => failure('DATABASE_URL is not a runtime database address')),
    );
    const spiceDb = yield* loadSpiceDbConfig().pipe(Effect.mapError(() => failure('The SpiceDB settings are missing')));
    const database = Layer.mergeAll(
      CoreDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, configuration))),
      Layer.succeed(DatabaseIdentityEnrollmentContext, APP_DATABASE_IDENTITY_ENROLLMENT),
    );
    const engine = CoreAuthorizationProjectionCompilerLive.pipe(Layer.provide(Layer.succeed(SpiceDbConfig, spiceDb)));
    const stores = Layer.mergeAll(TenantIntentLoaderLive, AccessWriteJournalStoreLive, AccessReleaseStoreLive).pipe(
      Layer.provideMerge(Layer.merge(database, engine)),
    );
    const composition = ActiveApplicationCompositionConfigLive.pipe(
      Layer.provide(ActiveApplicationCompositionSourceLive.pipe(Layer.provide(FetchHttpClient.layer))),
    );
    return Layer.mergeAll(stores, AccessProjectionWriterLive.pipe(Layer.provide(stores)), composition);
  }),
);

/** One line per decision; ids, module keys and counts only. */
export const reportLines = (report: ReleaseTenantModulesReport): readonly string[] => [
  ...report.modules.map(
    ({ detail, moduleKey, outcome, tenantId }) =>
      `${LOG_PREFIX} tenant ${tenantId} ${moduleKey}: ${outcome} (${detail})`,
  ),
  ...report.reconciles.map(({ deletions, failure: reconcileFailure, tenantId, touches }) =>
    reconcileFailure === undefined
      ? `${LOG_PREFIX} tenant ${tenantId}: reconciled, SpiceDB +${String(touches)}/-${String(deletions)}`
      : `${LOG_PREFIX} tenant ${tenantId}: RECONCILE FAILED (${reconcileFailure}); the module's rights stay denied until the next reconcile of the Tenant: this step reconciles it again on the next deploy, and the fence sweep heals it within minutes if the failed write kept the Tenant closed`,
  ),
];

/** What makes the step fail loudly: a module it could not decide or install, or a Tenant it could not project. */
export const reportProblems = (report: ReleaseTenantModulesReport): readonly string[] => [
  ...report.modules
    .filter(({ outcome }) => outcome === 'failed' || outcome === 'not_published')
    .map(({ moduleKey, tenantId }) => `${tenantId} ${moduleKey}`),
  ...report.reconciles.flatMap(({ failure: reconcileFailure, tenantId }) =>
    reconcileFailure === undefined ? [] : [`${tenantId} reconcile`],
  ),
];

/** Installs the declared modules against the active composition; the caller supplies the release runtime. */
export const installDeclaredModules = Effect.gen(function* installDeclaredModulesProgram() {
  const snapshot = yield* (yield* ActiveApplicationCompositionService).load.pipe(
    Effect.mapError(() => failure('the active composition could not be loaded')),
  );
  const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition).pipe(
    Effect.mapError(() => failure('the active composition does not form a module catalog')),
  );
  const deadline = DateTime.addDuration(yield* DateTime.now, RELEASE_MODULES_BUDGET);
  const modules = yield* deriveReleaseTenantModules(stageReleaseModuleRules).pipe(
    Effect.mapError(() => failure('the Tenant module states could not be read')),
  );
  const report = yield* installReleaseTenantModules({
    catalog,
    deadline,
    modules,
    runReference: snapshot.composition.revision,
  });
  for (const line of reportLines(report)) {
    yield* Console.log(line);
  }
  const problems = reportProblems(report);
  return problems.length === 0 ? yield* Effect.void : yield* failure(`not installed: ${problems.join(', ')}`);
});

/** Only stage declares Tenant modules; elsewhere the step changes nothing. */
const stageOnly = Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT').pipe(Config.withDefault(''));

const failureReason = (cause: Cause.Cause<unknown>): string => {
  if (Cause.hasInterruptsOnly(cause)) {
    return 'stopped by a signal; a projection already under way was finished first';
  }
  const problem = Cause.squash(cause);
  if (Schema.is(ReleaseTenantModulesFailure)(problem)) {
    return problem.reason;
  }
  return Predicate.hasProperty(problem, '_tag') ? `unexpected failure (${String(problem._tag)})` : 'unexpected failure';
};

// The process is stopped with SIGTERM (by the app host, or by a container shutdown). `runMain` turns that into an
// interrupt, so every finalizer runs: a projection that already took a Tenant's access fence runs to its end and
// gives the fence back (the writer makes that stretch uninterruptible) instead of the process dying with it held.
if (import.meta.main) {
  const program = Effect.gen(function* releaseTenantModulesProgram() {
    const environment = yield* stageOnly;
    return environment === 'stage'
      ? yield* installDeclaredModules
      : yield* Console.log(
          `${LOG_PREFIX} ${environment || 'this environment'} declares no Tenant modules; nothing to do`,
        );
  });
  NodeRuntime.runMain(
    program.pipe(
      Effect.provide(ReleaseRuntimeLive),
      // `onExit`, not `tapCause`: it also runs when a signal interrupts the run, so a stop is never silent.
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? Console.error(`${LOG_PREFIX} RELEASE MODULE INSTALLATION FAILED: ${failureReason(exit.cause)}`)
          : Effect.void,
      ),
      Effect.provide(NodeServices.layer),
    ),
    { disableErrorReporting: true },
  );
}
