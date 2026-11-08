// @effect-diagnostics nodeBuiltinImport:off processEnv:off -- Existing compatibility boundary; expires: 2026-12-31.
import { NodeServices } from '@effect/platform-node';
import { TenantAccessBootstrapLive } from '@app/core-runtime/access/bootstrap';
import { AccessChangesStoreLive } from '@app/core-runtime/access/changes/persistence/drizzle-store';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '@app/core-runtime/access/compiler/spice-db-compiler';
import { AccessCatalogModulesSchema } from '@app/core-runtime/access/catalog';
import { AccessCatalogSnapshotWriterLive } from '@app/core-runtime/access/intent/catalog-snapshot-writer';
import { AccessMembershipStoreLive } from '@app/core-runtime/access/intent/memberships';
import { AccessProjectionCompiler } from '@app/core-runtime/access/intent/projection-compiler';
import { AccessProjectionWriterLive } from '@app/core-runtime/access/intent/projection-writer';
import { TenantIntentLoaderLive } from '@app/core-runtime/access/intent/tenant-intent-loader';
import { AccessWriteJournalStoreLive } from '@app/core-runtime/access/lifecycle/persistence/journal-store';
import { CoreDatabaseLive } from '@app/core-runtime/db/client';
import type { CoreDatabase } from '@app/core-runtime/db/client';
import { readStageAccountsFileContents } from '@app/core-runtime/install/stage-accounts-file';
import { loadStageContextBootstrapConfiguration } from '@app/core-runtime/install/stage-context-bootstrap';
import type { InstallationRuntime } from '@app/core-runtime/install/stage-context-bootstrap';
import {
  AccessWorkloadSchema,
  DatabaseConfig,
  makeDatabaseIdentityEnrollmentLive,
  parseDatabaseConfig,
} from '@app/core-runtime';
import type { DatabaseConnectionError, DatabaseIdentityEnrollmentContext } from '@app/core-runtime';
import { Console, Effect, Exit, FileSystem, Layer, Path, Redacted, Schema } from 'effect';
import type { Crypto } from 'effect';

import { AuthConfig } from '../api/auth/config.ts';
import { AuthDatabaseLive } from '../api/auth/db/client.ts';
import { SHELL_DATABASE_IDENTITY_ENROLLMENT } from '../api/database-identity-enrollment.ts';
import { StageAccountsBootstrapError } from '../api/auth/stage-accounts-bootstrap-contract.ts';
import type { StageAccountsFileReader } from '../api/auth/stage-accounts-bootstrap-contract.ts';
import {
  bootstrapStageAccountsFromEnvironment,
  loadStageAccountsConfiguration,
} from '../api/auth/stage-accounts-bootstrap-runtime-infrastructure.ts';

/** Reads the operator accounts file named by `ONTOS_STAGE_ACCOUNTS_FILE`; its values are never logged. */
const readAccountsFile: StageAccountsFileReader = (path) =>
  readStageAccountsFileContents(path).pipe(Effect.provide(NodeServices.layer));

/*
 * The pinned catalog artifact (O69): the repository tooling derives the composition's declaration
 * set once, commits it beside the workspace and the deployment ships it. Core never scans source
 * code, so this process root reads the artifact as data and decodes it through Core's own schema; a
 * stale artifact is caught by the `authorization:catalog:artifact:check` drift check, not here.
 */
const AUTHORIZATION_CATALOG_ARTIFACT_PATH = 'topology/authorization-catalog.json';

const AccessCatalogArtifactSchema = Schema.Struct({
  declaredWorkloadKeys: Schema.Array(AccessWorkloadSchema.fields.workloads.value).check(Schema.isUnique()),
  modules: AccessCatalogModulesSchema,
  schemaVersion: Schema.Literal(2),
});

/**
 * The composition the stage run serves: the pinned catalog artifact (O69), because a stage tenant's
 * release is compiled from every declaration the deployment's modules carry — Actions, governed reads,
 * shell pages and field groups. A deployment contract carries no read, and a stage owner denied every
 * read is not a bootstrap but a broken tenant.
 */
const stageAccessModules = Effect.gen(function* loadModules() {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const artifactPath = path.resolve(import.meta.dirname, '../../../', AUTHORIZATION_CATALOG_ARTIFACT_PATH);
  const source = yield* fileSystem.readFileString(artifactPath).pipe(
    Effect.mapError(
      () =>
        new StageAccountsBootstrapError({
          code: 'stage_accounts_configuration_invalid',
          reason: `The access catalog artifact ${AUTHORIZATION_CATALOG_ARTIFACT_PATH} could not be read`,
        }),
    ),
  );
  // The artifact is data until Core decodes it: an artifact that drifts from the descriptor contract
  // fails the run instead of publishing a release nobody declared (O69).
  const artifact = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AccessCatalogArtifactSchema))(source).pipe(
    Effect.mapError(
      () =>
        new StageAccountsBootstrapError({
          code: 'stage_accounts_configuration_invalid',
          reason: 'The access catalog artifact does not match the descriptor contract',
        }),
    ),
  );
  return { declaredWorkloadKeys: new Set(artifact.declaredWorkloadKeys), modules: artifact.modules };
});

/** One native installation graph, including the enrollment required by scoped identity bootstrap writes. */
export const makeStageInstallationRuntime = (
  database: Layer.Layer<CoreDatabase, DatabaseConnectionError>,
  engine: Layer.Layer<AccessProjectionCompiler>,
) => {
  const memberships = AccessMembershipStoreLive;
  // The shell's own enrollment names the session-setting role this run connects as; the access stores and
  // the projection writer install every tenant scope from it, never from an assumed identity.
  const enrollment = makeDatabaseIdentityEnrollmentLive(SHELL_DATABASE_IDENTITY_ENROLLMENT);
  const platform = Layer.mergeAll(database, engine, enrollment);
  const stores = Layer.mergeAll(
    TenantIntentLoaderLive,
    AccessWriteJournalStoreLive,
    AccessChangesStoreLive,
    memberships,
  ).pipe(Layer.provide(platform));
  const catalog = AccessCatalogSnapshotWriterLive.pipe(Layer.provide(stores));
  const writer = AccessProjectionWriterLive.pipe(Layer.provide(Layer.mergeAll(stores, platform)));
  const bootstrap = TenantAccessBootstrapLive.pipe(Layer.provide(Layer.mergeAll(stores, platform, catalog, writer)));
  return Layer.mergeAll(bootstrap, writer, catalog, stores, platform) satisfies Layer.Layer<
    InstallationRuntime | DatabaseIdentityEnrollmentContext,
    DatabaseConnectionError,
    Crypto.Crypto
  >;
};

/**
 * The installation runtime of this command: one runtime pool, one engine transport and the six access
 * writers, composed here because this script is a process root. The administrative connection is separate
 * and used only by Better Auth below.
 */
const stageInstallationRuntime = Effect.gen(function* buildStageInstallationRuntime() {
  const stage = yield* loadStageContextBootstrapConfiguration();
  const databaseConfiguration = yield* parseDatabaseConfig({ DATABASE_URL: Redacted.value(stage.databaseUrl) }).pipe(
    Effect.mapError(
      (error) =>
        new StageAccountsBootstrapError({
          code: 'stage_accounts_configuration_invalid',
          reason: error.reason,
        }),
    ),
  );
  const database = CoreDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, databaseConfiguration)));
  // The engine transport belongs to this run: it is opened with the layer and closed when the run ends.
  const engine = Layer.effect(
    AccessProjectionCompiler,
    Effect.acquireRelease(
      Effect.sync(() => makeAccessProjectionTransport(Redacted.value(stage.spiceDb))),
      (transport) => Effect.sync(() => transport.close()),
    ).pipe(Effect.map((transport) => makeAccessProjectionCompiler(transport))),
  );
  return makeStageInstallationRuntime(database, engine);
});

const program = Effect.gen(function* bootstrapStageAccountsProgram() {
  const { declaredWorkloadKeys, modules } = yield* stageAccessModules;
  const configuration = yield* loadStageAccountsConfiguration(readAccountsFile, declaredWorkloadKeys);
  // A pool that cannot be opened is this command's failure, reported with the reason it recorded.
  const runtime = yield* stageInstallationRuntime.pipe(
    Effect.mapError(
      (error) =>
        new StageAccountsBootstrapError({
          code: 'stage_accounts_persistence_failed',
          reason: error.reason,
        }),
    ),
  );
  const result = yield* bootstrapStageAccountsFromEnvironment(readAccountsFile, { declaredWorkloadKeys, modules }).pipe(
    Effect.provide(runtime),
    Effect.provide(
      AuthDatabaseLive.pipe(
        Layer.provide(
          Layer.succeed(AuthConfig, {
            baseUrl: configuration.authBaseUrl,
            connectionString: configuration.databaseAdminUrl,
            secret: configuration.authSecret,
            secureCookies: true,
            supportUserIds: [],
            trustedOrigins: [configuration.authBaseUrl],
          }),
        ),
      ),
    ),
    Effect.catchTag(
      'AuthDatabaseConnectionError',
      () =>
        new StageAccountsBootstrapError({
          code: 'stage_accounts_persistence_failed',
          reason: 'The stage authentication database could not be opened',
        }),
    ),
  );
  yield* Effect.forEach(
    result.accounts,
    (account) =>
      Console.log(
        `Stage accounts bootstrap complete (${account.authUser} auth user): tenant=${account.tenantId} legalEntity=${account.legalEntityId} principal=${account.principalId} owner=${account.owner} roles=${account.roles.join(',')} email=${account.email}`,
      ),
    { discard: true },
  );
  yield* Effect.forEach(
    result.retiredAccounts,
    (account) => Console.log(`Retired stage account ${account.email}: ${account.status}`),
    { discard: true },
  );
}).pipe(
  Effect.tapError((failure) => Console.error(`Stage accounts bootstrap failed: ${failure.reason}`)),
  Effect.tapDefect(() => Console.error('Stage accounts bootstrap failed unexpectedly')),
);

if (import.meta.main) {
  const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(NodeServices.layer), Effect.scoped));
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
