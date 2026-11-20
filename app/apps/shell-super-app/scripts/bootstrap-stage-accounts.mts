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
import { AccessPeopleStoreLive } from '@app/core-runtime/access/intent/people-store';
import { AccessProjectionCompiler } from '@app/core-runtime/access/intent/projection-compiler';
import { AccessProjectionWriterLive } from '@app/core-runtime/access/intent/projection-writer';
import { AccessTeamStoreLive } from '@app/core-runtime/access/intent/teams';
import { TenantIntentLoaderLive } from '@app/core-runtime/access/intent/tenant-intent-loader';
import { AccessWriteJournalStoreLive } from '@app/core-runtime/access/lifecycle/persistence/journal-store';
import type { SpiceDbConfigValue } from '@app/core-runtime/access/spicedb-config';
import { CoreDatabaseLive } from '@app/core-runtime/db/client';
import type { CoreDatabase } from '@app/core-runtime/db/client';
import { readStageAccountsFileContents } from '@app/core-runtime/install/stage-accounts-file';
import { loadStageContextBootstrapConfiguration } from '@app/core-runtime/install/stage-context-bootstrap';
import type { InstallationRuntime } from '@app/core-runtime/install/stage-context-bootstrap';
import { AccessWorkloadSchema, DatabaseConfig, makeDatabaseIdentityEnrollmentLive } from '@app/core-runtime';
import type {
  AccessCatalogModule,
  DatabaseConnectionError,
  DatabaseConnectionPair,
  DatabaseIdentityEnrollmentContext,
} from '@app/core-runtime';
import { ConfigProvider, Console, Effect, Exit, FileSystem, Layer, Path, Redacted, Schema } from 'effect';
import type { Crypto } from 'effect';
import { Command, Flag } from 'effect/cli';

import { AuthDatabaseForExpectedRoleLive } from '../api/auth/db/client.ts';
import type { AuthDatabaseConnectionError } from '../api/auth/db/connection-error.ts';
import { SHELL_DATABASE_IDENTITY_ENROLLMENT } from '../api/database-identity-enrollment.ts';
import {
  StageAccountsBootstrapError,
  stageAccountsDatabases,
  stageAccountsDryRunLines,
  stageAccountsFailureLine,
} from '../api/auth/stage-accounts-bootstrap-contract.ts';
import type {
  StageAccountsBootstrapConfig,
  StageAccountsFileReader,
} from '../api/auth/stage-accounts-bootstrap-contract.ts';
import {
  bootstrapStageAccounts,
  loadStageAccountsConfiguration,
  rehearseStageAccounts,
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
export const stageAccessModules = Effect.gen(function* loadModules() {
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
    AccessPeopleStoreLive,
    AccessTeamStoreLive,
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

/** What one stage accounts run connects to: both PostgreSQL identities, checked as one pair, and the stage engine. */
export interface StageAccountsConnections {
  /** `runtime` is `DATABASE_URL`, `admin` is `DATABASE_ADMIN_URL`: two distinct logins of one database. */
  readonly databases: DatabaseConnectionPair;
  readonly spiceDb: Redacted.Redacted<SpiceDbConfigValue>;
}

/**
 * Every pool this finite command opens is its own, whatever the container sets. The stage container sets
 * `ONTOS_DATABASE_POOL_SHARED=true` for its long-running app host, which alone installs the registry shared pools draw
 * from and turns sharing off for every finite child it starts (`finiteProcessEnvironment` in
 * `scripts/zerops/app-host.mts`, not importable from the Shell). An operator runs this command beside that host, so it
 * applies the same rule itself: without it, building a client fails with "Shared database pools require a scoped
 * process host registry" before any statement. Every other pool setting is still read from the environment.
 */
const FinitePoolsLive = ConfigProvider.layerAdd(ConfigProvider.fromEnvRecord({ ONTOS_DATABASE_POOL_SHARED: 'false' }), {
  asPrimary: true,
});

/**
 * The Better Auth store of a stage accounts run: a private pool of the administrative connection, whose session is
 * confirmed on its first statement to be the login `DATABASE_ADMIN_URL` names.
 */
export const makeStageAccountsAuthDatabase = (databases: DatabaseConnectionPair) =>
  AuthDatabaseForExpectedRoleLive(databases.admin).pipe(Layer.provide(FinitePoolsLive));

/**
 * The whole graph of one stage accounts run, composed here because this script is a process root, and the only
 * composition the operator command and its integration test build: Core from `connections.databases.runtime`
 * (`DATABASE_URL`) and Better Auth from `connections.databases.admin` (`DATABASE_ADMIN_URL`), each on a private pool
 * (`FinitePoolsLive`). Core, its access writers, the projection writer and the revocation events the run records in its
 * own transaction share the runtime pool; the engine transport is opened with the graph and closed when the run ends.
 * Each client confirms on its first statement only that its session is the login of its own URL, so it cannot notice
 * two URLs swapped between the clients. What keeps them apart is this one function, which no caller can wire
 * differently; the integration test, which asserts through it that Better Auth's `session_user` is the administrative
 * login and Core's the runtime login; and Core's role check whenever it installs a scope (`scoped-transaction.ts`), which
 * fails closed for any role but the session-setting one its enrollment names, before Core reads or writes a tenant row.
 */
export const makeStageAccountsRuntime = (connections: StageAccountsConnections) => {
  const database = CoreDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, connections.databases.runtime)));
  const engine = Layer.effect(
    AccessProjectionCompiler,
    Effect.acquireRelease(
      Effect.sync(() => makeAccessProjectionTransport(Redacted.value(connections.spiceDb))),
      (transport) => Effect.sync(() => transport.close()),
    ).pipe(Effect.map((transport) => makeAccessProjectionCompiler(transport))),
  );
  return Layer.mergeAll(
    makeStageInstallationRuntime(database, engine),
    makeStageAccountsAuthDatabase(connections.databases),
  ).pipe(Layer.provide(FinitePoolsLive));
};

const invalid = (error: { readonly reason: string }) =>
  new StageAccountsBootstrapError({ code: 'stage_accounts_configuration_invalid', reason: error.reason });

/**
 * This command's connections, from the container's own environment: `DATABASE_URL` and `DATABASE_ADMIN_URL` must be
 * two distinct logins (the runtime login is never `postgres`) of the same server, port and database, refused before
 * either pool opens, and the engine is stage-private SpiceDB.
 */
const stageAccountsConnections = Effect.fn('StageAccountsBootstrap.connections')(function* stageAccountsConnectionsOf(
  databaseAdminUrl: string,
) {
  const stage = yield* loadStageContextBootstrapConfiguration().pipe(Effect.mapError(invalid));
  const databases = yield* stageAccountsDatabases({
    DATABASE_ADMIN_URL: databaseAdminUrl,
    DATABASE_URL: Redacted.value(stage.databaseUrl),
  });
  return { databases, spiceDb: stage.spiceDb } satisfies StageAccountsConnections;
});

/** A pool that cannot be opened is this command's failure, reported with the reason it recorded. */
const reportUnopenedPools = function reportUnopenedPools<Value, Requirements>(
  run: Effect.Effect<
    Value,
    AuthDatabaseConnectionError | DatabaseConnectionError | StageAccountsBootstrapError,
    Requirements
  >,
) {
  return run.pipe(
    Effect.catchTags({
      AuthDatabaseConnectionError: () =>
        new StageAccountsBootstrapError({
          code: 'stage_accounts_persistence_failed',
          reason: 'The stage authentication database could not be opened',
        }),
      DatabaseConnectionError: ({ reason }) =>
        new StageAccountsBootstrapError({ code: 'stage_accounts_persistence_failed', reason }),
    }),
  );
};

/** The dry run (`--dry-run`): it rolls its move transaction back, writes nothing and prints what the real run would do. */
const dryRunOf = Effect.fn('StageAccountsBootstrap.dryRun')(function* dryRunEffect(
  configuration: StageAccountsBootstrapConfig,
  modules: readonly AccessCatalogModule[],
  connections: StageAccountsConnections,
) {
  const rehearsal = yield* rehearseStageAccounts(configuration, { modules }).pipe(
    Effect.provide(makeStageAccountsRuntime(connections)),
    reportUnopenedPools,
  );
  yield* Effect.forEach(stageAccountsDryRunLines(rehearsal), (line) => Console.log(line), { discard: true });
});

/** The real run: it reconciles the file and prints what it did. */
const realRunOf = Effect.fn('StageAccountsBootstrap.realRun')(function* realRunEffect(
  configuration: StageAccountsBootstrapConfig,
  modules: readonly AccessCatalogModule[],
  connections: StageAccountsConnections,
) {
  const result = yield* bootstrapStageAccounts(configuration, { modules }).pipe(
    Effect.provide(makeStageAccountsRuntime(connections)),
    reportUnopenedPools,
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
    result.attachedLogins,
    (login) =>
      Console.log(`Attached stage login ${login.email}: tenant=${login.tenantId} principal=${login.principalId}`),
    { discard: true },
  );
  yield* Effect.forEach(
    result.retiredPrincipals,
    (retired) =>
      Console.log(
        `Retired stage Principal of ${retired.email}: tenant=${retired.tenantId} principal=${retired.principalId}`,
      ),
    { discard: true },
  );
  yield* Effect.forEach(
    result.endedConnectedApps,
    (app) =>
      Console.log(
        `Ended connected app "${app.clientName}" (${app.clientId}) of ${app.email}: tenant=${app.tenantId} grant=${app.grantId} was=${app.status} lastUsed=${app.lastUsedAt?.toISOString() ?? 'never'}`,
      ),
    { discard: true },
  );
  yield* Effect.forEach(
    result.retiredAccounts,
    (account) => Console.log(`Retired stage account ${account.email}: ${account.status}`),
    { discard: true },
  );
});

/** One run of the operator command: the dry run when `dryRun`, else the real run. */
const program = (dryRun: boolean) =>
  Effect.gen(function* stageAccountsProgram() {
    const { declaredWorkloadKeys, modules } = yield* stageAccessModules;
    const configuration = yield* loadStageAccountsConfiguration(readAccountsFile, declaredWorkloadKeys);
    const connections = yield* stageAccountsConnections(configuration.databaseAdminUrl);
    return yield* (dryRun ? dryRunOf : realRunOf)(configuration, modules, connections);
  }).pipe(
    Effect.tapError((failure) => Console.error(stageAccountsFailureLine(failure))),
    Effect.tapDefect(() => Console.error('Stage accounts bootstrap failed unexpectedly')),
  );

/**
 * The operator command line: no flag is the real run, `--dry-run` its dry run. The parser refuses any other argument
 * before the command reads its file or opens a connection, so a mistyped flag never starts the real run.
 */
export const makeStageAccountsCommand = function makeStageAccountsCommand<Failure, Requirements>(
  run: (dryRun: boolean) => Effect.Effect<void, Failure, Requirements>,
) {
  return Command.make(
    'bootstrap-stage-accounts',
    {
      dryRun: Flag.Boolean('dry-run').pipe(
        Flag.withDefault(false),
        Flag.withDescription(
          "Run the move transaction with the real run's locks and writes, roll it back, and print what the real run would do",
        ),
      ),
    },
    ({ dryRun }) => run(dryRun),
  ).pipe(Command.withDescription('Reconcile the operator stage accounts file named by ONTOS_STAGE_ACCOUNTS_FILE'));
};

export const main = Command.run({ version: '1.0.0' })(makeStageAccountsCommand(program));

if (import.meta.main) {
  const exit = await Effect.runPromiseExit(main.pipe(Effect.provide(NodeServices.layer), Effect.scoped));
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
