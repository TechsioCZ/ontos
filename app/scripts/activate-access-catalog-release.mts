#!/usr/bin/env node
/**
 * Release activation of the access catalog (ADR-0030, Novinky): `packages/core-runtime/src/access/release/activation.ts`.
 *
 *   node scripts/activate-access-catalog-release.mts            # publish when newer, let "Plný přístup" follow it
 *   node scripts/activate-access-catalog-release.mts --dry-run  # the same plan, read-only
 *
 * The migrator runs it once per activation, after every migration and before the release takes the authority; a
 * local stack runs it after its permission bootstrap. It reads the deployed catalog as data (the committed
 * `topology/authorization-catalog.json`, decoded through Core's own schema), connects with the runtime identity
 * (`DATABASE_URL`) and projects through the one Core writer into SpiceDB (`SPICEDB_*`). It prints counts, the
 * release identity and capability keys only. A failed tenant exits 1; the migrator reports it and keeps the release
 * booting, because authorization then simply stays at the previous release.
 */
import { NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Exit, FileSystem, Layer, Match, Path, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { APP_DATABASE_IDENTITY_ENROLLMENT } from '../database/identity-enrollment.ts';
import { AccessCatalogModulesSchema } from '../packages/core-runtime/src/access/catalog/module-schema.ts';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '../packages/core-runtime/src/access/compiler/spice-db-compiler.ts';
import {
  AccessChangesStoreLive,
  AccessReleaseStoreLive,
} from '../packages/core-runtime/src/access/changes/persistence/drizzle-store.ts';
import { AccessProjectionCompiler } from '../packages/core-runtime/src/access/intent/projection-compiler.ts';
import { AccessProjectionWriterLive } from '../packages/core-runtime/src/access/intent/projection-writer.ts';
import { TenantIntentLoaderLive } from '../packages/core-runtime/src/access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../packages/core-runtime/src/access/lifecycle/persistence/journal-store.ts';
import { activateCatalogRelease } from '../packages/core-runtime/src/access/release/activation.ts';
import type { CatalogReleaseActivationReport } from '../packages/core-runtime/src/access/release/activation.ts';
import { CoreDatabaseLive } from '../packages/core-runtime/src/db/client.ts';
import { DatabaseConfig, parseDatabaseConfig } from '../packages/core-runtime/src/db/config.ts';
import { makeDatabaseIdentityEnrollmentLive } from '../packages/core-runtime/src/db/database-identities.ts';
import { loadSpiceDbConfig } from '../packages/core-runtime/src/permissions/config.ts';

const AUTHORIZATION_CATALOG_ARTIFACT_PATH = 'topology/authorization-catalog.json';

export class AccessCatalogReleaseActivationFailure extends Schema.TaggedError<AccessCatalogReleaseActivationFailure>()(
  'AccessCatalogReleaseActivationFailure',
  { reason: Schema.String },
) {}
const failure = (reason: string) => new AccessCatalogReleaseActivationFailure({ reason });

/** Only the declarations matter here; the artifact's workload keys belong to the stage account bootstrap. */
const ArtifactSchema = Schema.Struct({
  modules: AccessCatalogModulesSchema,
  schemaVersion: Schema.Literal(2),
});

/** The deployed catalog, as data: the artifact this release ships, decoded through Core's own schema (O69). */
const deployedModules = Effect.gen(function* readDeployedCatalog() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = yield* fileSystem
    .readFileString(path.resolve(import.meta.dirname, '..', AUTHORIZATION_CATALOG_ARTIFACT_PATH))
    .pipe(Effect.mapError(() => failure(`${AUTHORIZATION_CATALOG_ARTIFACT_PATH} could not be read`)));
  const artifact = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ArtifactSchema))(source).pipe(
    Effect.mapError(() => failure(`${AUTHORIZATION_CATALOG_ARTIFACT_PATH} does not match the descriptor contract`)),
  );
  return artifact.modules;
});

/** The runtime identity, the access stores and the one projection writer, composed once for this process. */
const ActivationRuntimeLive = Layer.unwrap(
  Effect.gen(function* activationRuntime() {
    const url = yield* Config.Redacted('DATABASE_URL').pipe(Effect.mapError(() => failure('DATABASE_URL is required')));
    const configuration = yield* parseDatabaseConfig({ DATABASE_URL: Redacted.value(url) }).pipe(
      Effect.mapError(() => failure('DATABASE_URL is not a runtime database address')),
    );
    const spiceDb = yield* loadSpiceDbConfig().pipe(Effect.mapError(() => failure('The SpiceDB settings are missing')));
    const engine = Layer.effect(
      AccessProjectionCompiler,
      Effect.acquireRelease(
        Effect.sync(() => makeAccessProjectionTransport(spiceDb)),
        (transport) => Effect.sync(() => transport.close()),
      ).pipe(Effect.map(makeAccessProjectionCompiler)),
    );
    const platform = Layer.mergeAll(
      CoreDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, configuration))),
      makeDatabaseIdentityEnrollmentLive(APP_DATABASE_IDENTITY_ENROLLMENT),
      engine,
    );
    const stores = Layer.mergeAll(
      TenantIntentLoaderLive,
      AccessWriteJournalStoreLive,
      AccessChangesStoreLive,
      AccessReleaseStoreLive,
    ).pipe(Layer.provideMerge(platform));
    return Layer.mergeAll(stores, AccessProjectionWriterLive.pipe(Layer.provide(stores)));
  }),
);

const orderingLabel = (report: CatalogReleaseActivationReport): string =>
  Match.value(report.ordering).pipe(
    Match.tag('Publish', () => 'published'),
    Match.tag('Current', () => 'current'),
    Match.tag('Superseded', ({ reason }) => `superseded (${reason}); no tenant changed`),
    Match.exhaustive,
  );

const previousNote = (report: CatalogReleaseActivationReport): string =>
  report.previousEntries === undefined ? '' : ` (previous release ${String(report.previousEntries)})`;

const tenantLine = (tenant: CatalogReleaseActivationReport['tenants'][number]): string => {
  const parts = [
    `tenant ${tenant.tenantId}: ${tenant.outcome}`,
    `"Plný přístup" +${String(tenant.presetCellsAdded)} cells`,
    `Novinky ${String(tenant.items)}`,
  ];
  if (tenant.inertKeys.length > 0) {
    parts.push(`inert ${tenant.inertKeys.join(',')}`);
  }
  if (tenant.reason !== undefined) {
    parts.push(tenant.reason);
  }
  return `[access-release] ${parts.join('; ')}`;
};

/** Counts, the release identity and capability keys only: nothing here is a secret or a person's data. */
const printReport = Effect.fn('AccessCatalogReleaseActivation.print')(function* printReport(
  report: CatalogReleaseActivationReport,
  dryRun: boolean,
) {
  const prefix = dryRun ? 'dry run: ' : '';
  yield* Console.log(
    `[access-release] ${prefix}release ${report.releaseId} ${orderingLabel(report)}: ${String(report.entries)} capabilities${previousNote(report)}`,
  );
  for (const tenant of report.tenants) {
    yield* Console.log(tenantLine(tenant));
  }
  const failed = report.tenants.filter(({ outcome }) => outcome === 'failed');
  if (failed.length > 0) {
    return yield* failure(
      `${String(failed.length)} tenant(s) kept their previous release; the next activation retries them`,
    );
  }
  return report;
});

const activate = Effect.fn('AccessCatalogReleaseActivation.run')(function* activateDeployedCatalog(dryRun: boolean) {
  const modules = yield* deployedModules;
  const report = yield* activateCatalogRelease({ dryRun, modules }).pipe(
    Effect.mapError((cause) => failure(cause.reason)),
  );
  return yield* printReport(report, dryRun);
});

const command = Command.make('activate-access-catalog-release', { dryRun: Flag.Boolean('dry-run') }, ({ dryRun }) =>
  activate(dryRun).pipe(
    Effect.tapError((problem) =>
      Console.error(
        `[access-release] ACCESS CATALOG RELEASE ACTIVATION FAILED: ${Schema.is(AccessCatalogReleaseActivationFailure)(problem) ? problem.reason : 'unexpected failure'}`,
      ),
    ),
  ),
).pipe(Command.provide(ActivationRuntimeLive));

if (import.meta.main) {
  const exit = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(Effect.provide(NodeServices.layer)),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
