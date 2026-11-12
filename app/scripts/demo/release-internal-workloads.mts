#!/usr/bin/env node
/**
 * Release step: register every module's own declared internal workload, per tenant and company, through
 * `packages/core-runtime/src/install/release-internal-workloads.ts`. The platform does it, so no person ever registers
 * or keys an internal workload; storefront and other external workload bindings stay operator data
 * (`register-stage-workloads.mts`).
 *
 * The app host runs it before its boot's key provisioning, so a workload registered here gets its key in the same
 * boot, and again after the composition is published (behind the release-time module install), so a module installed
 * by that release gets its registrations at once; when that second run changed anything, the host renews the keys of
 * the modules concerned. The local demo runs it after the permissions step, before it provisions keys. It needs only
 * `DATABASE_URL`; it writes no relationship tuple. It prints one line per tenant and exits 1 when any tenant failed,
 * which the host reports loudly without holding the boot.
 *
 *   node scripts/demo/release-internal-workloads.mts [--run <reference>]
 */
import { randomUUID } from 'node:crypto';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Cause, Config, Console, Effect, Exit, FileSystem, Layer, Option, Predicate, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { APP_DATABASE_IDENTITY_ENROLLMENT } from '../../database/identity-enrollment.ts';
import { AccessReleaseStoreLive } from '../../packages/core-runtime/src/access/changes/persistence/drizzle-store.ts';
import { CoreDatabase, CoreDatabaseLive } from '../../packages/core-runtime/src/db/client.ts';
import { DatabaseConfig, parseDatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import { makeDatabaseIdentityEnrollmentLive } from '../../packages/core-runtime/src/db/database-identities.ts';
import type { InternalWorkloadDeclaration } from '../../packages/core-runtime/src/install/internal-workload-plan.ts';
import { registerReleaseInternalWorkloads } from '../../packages/core-runtime/src/install/release-internal-workloads.ts';
import type { ReleaseInternalWorkloadTenantReport } from '../../packages/core-runtime/src/install/release-internal-workloads.ts';
import { WorkloadKeySchema } from '../../packages/core-runtime/src/authorization/access-declaration.ts';
import { MODULE_INTERNAL_WORKLOADS } from '../zerops/module-credentials.mts';

const LOG_PREFIX = '[release-internal-workloads]';
const CATALOG_ARTIFACT = new URL('../../topology/authorization-catalog.json', import.meta.url);

export class ReleaseInternalWorkloadsFailure extends Schema.TaggedError<ReleaseInternalWorkloadsFailure>()(
  'ReleaseInternalWorkloadsFailure',
  { reason: Schema.String },
) {}
const failure = (reason: string) => new ReleaseInternalWorkloadsFailure({ reason });

const CatalogArtifactSchema = Schema.Struct({ declaredWorkloadKeys: Schema.Array(WorkloadKeySchema) });

/** The module key a workload belongs to (O73: a module namespace and one name), e.g. `demo.crm.party-intake` → `demo.crm`. */
export const moduleKeyOfWorkload = (workloadKey: string): string => workloadKey.slice(0, workloadKey.lastIndexOf('.'));

/**
 * The internal workloads to register: a module's own internal workload (`MODULE_INTERNAL_WORKLOADS`) that the reviewed
 * catalogue also declares. One the catalogue no longer declares is not wanted, so its registrations are retired.
 */
export const internalWorkloadDeclarations = (
  internal: ReadonlyMap<string, readonly string[]>,
  declared: ReadonlySet<string>,
): readonly InternalWorkloadDeclaration[] =>
  [...internal].flatMap(([appId, workloadKeys]) =>
    workloadKeys.flatMap((workloadKey) =>
      declared.has(workloadKey) ? [{ appId, moduleKey: moduleKeyOfWorkload(workloadKey), workloadKey }] : [],
    ),
  );

/** One line per tenant: what it holds now, as counts; ids of tenants only, never a key. */
export const reportLine = (report: ReleaseInternalWorkloadTenantReport): string => {
  if (report.failed !== null) {
    return `${LOG_PREFIX} tenant ${report.tenantId}: FAILED (${report.failed}); what was done before the failure stays and the next run completes it`;
  }
  const held = report.held === 0 ? '' : `, ${String(report.held)} held as an administrator set them`;
  return `${LOG_PREFIX} tenant ${report.tenantId}: ${String(report.registered)} registered, ${String(report.retired)} retired, ${String(report.unchanged)} unchanged${held}`;
};

const ReleaseRuntimeLive = Layer.unwrap(
  Effect.gen(function* releaseRuntime() {
    const url = yield* Config.Redacted('DATABASE_URL').pipe(Effect.mapError(() => failure('DATABASE_URL is required')));
    const configuration = yield* parseDatabaseConfig({ DATABASE_URL: Redacted.value(url) }).pipe(
      Effect.mapError(() => failure('DATABASE_URL is not a runtime database address')),
    );
    const database = Layer.mergeAll(
      CoreDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, configuration))),
      makeDatabaseIdentityEnrollmentLive(APP_DATABASE_IDENTITY_ENROLLMENT),
    );
    return Layer.mergeAll(database, AccessReleaseStoreLive.pipe(Layer.provide(database)));
  }),
);

/** Registers the declared internal workloads in every tenant; fails when any tenant failed. */
export const registerDeclaredInternalWorkloads = Effect.fn('ReleaseInternalWorkloads.program')(function* program(
  runReference: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const catalog = yield* fs.readFileString(CATALOG_ARTIFACT.pathname).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(CatalogArtifactSchema))),
    Effect.mapError(() => failure('the reviewed authorization catalogue artefact could not be read')),
  );
  const declarations = internalWorkloadDeclarations(MODULE_INTERNAL_WORKLOADS, new Set(catalog.declaredWorkloadKeys));
  const { executor } = yield* CoreDatabase;
  const reports = yield* registerReleaseInternalWorkloads(
    { enrollment: APP_DATABASE_IDENTITY_ENROLLMENT, executor },
    { declarations, runReference },
  ).pipe(Effect.mapError((cause) => failure(cause.reason)));
  for (const report of reports) {
    yield* Console.log(reportLine(report));
  }
  const failed = reports.filter(({ failed: reason }) => reason !== null).map(({ tenantId }) => tenantId);
  return failed.length === 0 ? reports : yield* failure(`tenants not converged: ${failed.join(', ')}`);
});

const failureReason = (cause: Cause.Cause<unknown>): string => {
  const problem = Cause.squash(cause);
  if (Schema.is(ReleaseInternalWorkloadsFailure)(problem)) {
    return problem.reason;
  }
  return Predicate.hasProperty(problem, '_tag') ? `unexpected failure (${String(problem._tag)})` : 'unexpected failure';
};

const command = Command.make('release-internal-workloads', { run: Flag.String('run').pipe(Flag.optional) }, ({ run }) =>
  registerDeclaredInternalWorkloads(Option.getOrElse(run, () => `release:${randomUUID()}`)),
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.provide(ReleaseRuntimeLive),
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? Console.error(`${LOG_PREFIX} INTERNAL WORKLOAD REGISTRATION FAILED: ${failureReason(exit.cause)}`)
          : Effect.void,
      ),
      Effect.provide(NodeServices.layer),
    ),
    { disableErrorReporting: true },
  );
}
