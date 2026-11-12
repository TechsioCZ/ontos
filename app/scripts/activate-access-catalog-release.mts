#!/usr/bin/env node
/**
 * Release activation of the access catalog (ADR-0030, Novinky): `packages/core-runtime/src/access/release/activation.ts`.
 *
 *   node scripts/activate-access-catalog-release.mts            # publish when newer, let "Plný přístup" follow it
 *   node scripts/activate-access-catalog-release.mts --dry-run  # the same decision and plan, without a write
 *
 * Both print the ordering decision (`published`, `Current`, `published_before`, `not_a_successor`) and, per active
 * tenant, whether it has an untouched "Plný přístup" to follow, the cells it gains and the Novinky items it gets.
 * They exit 0 only when the deployed catalog is `published` or `Current` and every tenant took it.
 *
 * The migrator runs it once per activation, after every migration and before the release takes the authority; a
 * local stack runs it after its permission bootstrap. It reads the deployed catalog as data (the committed
 * `topology/authorization-catalog.json`, decoded through Core's own schema), connects with the runtime identity
 * (`DATABASE_URL`) and projects through the one Core writer into SpiceDB (`SPICEDB_*`); `--dry-run` needs only
 * `DATABASE_URL`, reads in transactions PostgreSQL keeps read-only, takes no lock (an activation running at the
 * same time may publish right after it) and never reaches the engine. It prints counts, the
 * release identity and capability keys only. A failed tenant or a catalog that is not `published`/`Current` exits 1;
 * the migrator reports it and keeps the release booting, because authorization then simply stays at the previous
 * release.
 */
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '@app/core-runtime/access/compiler/spice-db-compiler';
import { NodeServices } from '@effect/platform-node';
import {
  Cause,
  Config,
  Console,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  Predicate,
  Redacted,
  Schema,
} from 'effect';
import { Command, Flag } from 'effect/cli';

import { APP_DATABASE_IDENTITY_ENROLLMENT } from '../database/identity-enrollment.ts';
import { AccessCatalogModulesSchema } from '../packages/core-runtime/src/access/catalog/module-schema.ts';
import {
  AccessChangesStoreLive,
  AccessReleaseStoreLive,
} from '../packages/core-runtime/src/access/changes/persistence/drizzle-store.ts';
import { AccessProjectionCompiler } from '../packages/core-runtime/src/access/intent/projection-compiler.ts';
import {
  AccessProjectionWriter,
  AccessProjectionWriterLive,
} from '../packages/core-runtime/src/access/intent/projection-writer.ts';
import { TenantIntentLoaderLive } from '../packages/core-runtime/src/access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../packages/core-runtime/src/access/lifecycle/persistence/journal-store.ts';
import { activateCatalogRelease, planCatalogRelease } from '../packages/core-runtime/src/access/release/activation.ts';
import type { CatalogReleaseActivationReport } from '../packages/core-runtime/src/access/release/activation.ts';
import { CoreDatabaseLive } from '../packages/core-runtime/src/db/client.ts';
import { DatabaseConfig, parseDatabaseConfig } from '../packages/core-runtime/src/db/config.ts';
import { DatabaseIdentityEnrollmentContext } from '../packages/core-runtime/src/db/database-identities.ts';
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

/** The runtime identity: the one database connection both the plan and the activation use. */
const DatabaseRuntimeLive = Layer.unwrap(
  Effect.gen(function* databaseRuntime() {
    const url = yield* Config.Redacted('DATABASE_URL').pipe(Effect.mapError(() => failure('DATABASE_URL is required')));
    const configuration = yield* parseDatabaseConfig({ DATABASE_URL: Redacted.value(url) }).pipe(
      Effect.mapError(() => failure('DATABASE_URL is not a runtime database address')),
    );
    return Layer.mergeAll(
      CoreDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, configuration))),
      Layer.succeed(DatabaseIdentityEnrollmentContext, APP_DATABASE_IDENTITY_ENROLLMENT),
    );
  }),
);

/** What a dry run reads with: the access stores over the database, and nothing that can reach the engine. */
const PlanRuntimeLive = Layer.mergeAll(AccessChangesStoreLive, AccessReleaseStoreLive).pipe(
  Layer.provideMerge(DatabaseRuntimeLive),
);

/** The activation adds the engine and the one projection writer. */
const ActivationRuntimeLive = Layer.unwrap(
  Effect.gen(function* activationRuntime() {
    const spiceDb = yield* loadSpiceDbConfig().pipe(Effect.mapError(() => failure('The SpiceDB settings are missing')));
    const engine = Layer.effect(
      AccessProjectionCompiler,
      Effect.acquireRelease(
        Effect.sync(() => makeAccessProjectionTransport(spiceDb)),
        (transport) => Effect.sync(() => transport.close()),
      ).pipe(Effect.map(makeAccessProjectionCompiler)),
    );
    const stores = Layer.mergeAll(TenantIntentLoaderLive, AccessWriteJournalStoreLive, PlanRuntimeLive).pipe(
      Layer.provideMerge(Layer.merge(DatabaseRuntimeLive, engine)),
    );
    return Layer.mergeAll(stores, AccessProjectionWriterLive.pipe(Layer.provide(stores)));
  }),
);

/** The ordering decision as the operator reads it. */
const orderingLabel = (report: CatalogReleaseActivationReport): string =>
  Match.value(report.ordering).pipe(
    Match.tagsExhaustive({
      Current: () => 'Current',
      NotASuccessor: () => 'not_a_successor',
      Publish: () => 'published',
      PublishedBefore: () => 'published_before',
    }),
  );

const previousNote = (report: CatalogReleaseActivationReport): string =>
  report.previousEntries === undefined ? '' : ` (previous release ${String(report.previousEntries)})`;

const tenantLine = (tenant: CatalogReleaseActivationReport['tenants'][number]): string => {
  if (tenant.outcome === 'skipped') {
    return `[access-release] tenant ${tenant.tenantId}: skipped; ${tenant.reason ?? 'nothing to follow'}`;
  }
  const parts = [
    `tenant ${tenant.tenantId}: ${tenant.outcome}`,
    tenant.presetFound
      ? `"Plný přístup" found, +${String(tenant.presetCellsAdded)} cells`
      : '"Plný přístup" none to follow',
    `Novinky ${String(tenant.items)}`,
    `${String(tenant.elapsedMillis)} ms`,
  ];
  if (tenant.outcome !== 'planned') {
    parts.push(`SpiceDB +${String(tenant.relationshipTouches)}/-${String(tenant.relationshipDeletions)}`);
  }
  if (tenant.inertKeys.length > 0) {
    parts.push(`inert ${tenant.inertKeys.join(',')}`);
  }
  if (tenant.reason !== undefined) {
    parts.push(tenant.reason);
  }
  return `[access-release] ${parts.join('; ')}`;
};

const SHOWN_UNCOVERED_KEYS = 5;

/**
 * A deployment whose catalog does not become or stay the newest release changes nothing — and says so as a failed
 * activation, so the migrator's report shows it and nobody mistakes it for a release that took effect.
 */
const supersededReason = (report: CatalogReleaseActivationReport): Option.Option<string> =>
  Match.value(report.ordering).pipe(
    Match.tagsExhaustive({
      Current: () => Option.none<string>(),
      NotASuccessor: ({ uncoveredKeys }) => {
        const shown = uncoveredKeys.slice(0, SHOWN_UNCOVERED_KEYS).join(', ');
        const more = uncoveredKeys.length > SHOWN_UNCOVERED_KEYS ? ', …' : '';
        return Option.some(
          [
            `the deployed catalog ${report.deployedReleaseId} is not a successor of the newest release ${report.releaseId}:`,
            `it lacks or narrows ${String(uncoveredKeys.length)} of its capabilities (${shown}${more}).`,
            'Nothing was published and no tenant changed; every later deployment lacking them is refused the same way',
            'until an operator resolves it (docs/architecture/AUTHORIZATION.md, "Release activation").',
          ].join(' '),
        );
      },
      Publish: () => Option.none<string>(),
      PublishedBefore: () =>
        Option.some(
          `the deployed catalog ${report.deployedReleaseId} was published before and the newer release ${report.releaseId} serves; nothing changed`,
        ),
    }),
  );

/** Counts, the release identity and capability keys only: nothing here is a secret or a person's data. */
const printReport = Effect.fn('AccessCatalogReleaseActivation.print')(function* printReport(
  report: CatalogReleaseActivationReport,
  dryRun: boolean,
) {
  const prefix = dryRun ? 'dry run (nothing written): ' : '';
  yield* Console.log(
    `[access-release] ${prefix}deployed catalog ${report.deployedReleaseId}: ${orderingLabel(report)}; newest release ${report.releaseId}: ${String(report.entries)} capabilities${previousNote(report)}`,
  );
  for (const tenant of report.tenants) {
    yield* Console.log(tenantLine(tenant));
  }
  const superseded = supersededReason(report);
  if (Option.isSome(superseded)) {
    return yield* failure(superseded.value);
  }
  const failed = report.tenants.filter(({ outcome }) => outcome === 'failed');
  if (failed.length > 0) {
    return yield* failure(
      `${String(failed.length)} tenant(s) kept their previous release; the next activation retries them`,
    );
  }
  return report;
});

/**
 * A dry run never reaches the engine: the plan never reconciles, and the writer a dry run is composed with
 * refuses every use, so neither the SpiceDB settings nor a connection is needed for it.
 */
const DryRunRuntimeLive = Layer.merge(
  PlanRuntimeLive,
  Layer.succeed(AccessProjectionWriter, {
    reconcileTenant: () => Effect.die(failure('a dry run never writes the projection')),
  }),
);

const run = Effect.fn('AccessCatalogReleaseActivation.run')(function* runDeployedCatalog(dryRun: boolean) {
  const modules = yield* deployedModules;
  const report = yield* (dryRun ? planCatalogRelease({ modules }) : activateCatalogRelease({ modules })).pipe(
    Effect.mapError((cause) => failure(cause.reason)),
  );
  return yield* printReport(report, dryRun);
});

/** `--dry-run` is optional: the migrator starts this script with no argument at all (`run-zerops-migrator.mjs`). */
export const command = Command.make(
  'activate-access-catalog-release',
  { dryRun: Flag.Boolean('dry-run').pipe(Flag.withDefault(false)) },
  ({ dryRun }) => run(dryRun),
).pipe(Command.provide(({ dryRun }) => (dryRun ? DryRunRuntimeLive : ActivationRuntimeLive)));

/** The one loud line for every failure: arguments, settings, the runtime it is composed with, or the run itself. */
const failureReason = (cause: Cause.Cause<unknown>): string => {
  const problem = Cause.squash(cause);
  if (Schema.is(AccessCatalogReleaseActivationFailure)(problem)) {
    return problem.reason;
  }
  return Predicate.hasProperty(problem, '_tag') ? `unexpected failure (${String(problem._tag)})` : 'unexpected failure';
};

if (import.meta.main) {
  const exit = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.tapCause((cause) =>
        Console.error(`[access-release] ACCESS CATALOG RELEASE ACTIVATION FAILED: ${failureReason(cause)}`),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
