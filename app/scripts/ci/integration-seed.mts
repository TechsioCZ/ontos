#!/usr/bin/env node
/**
 * USAGE — workflow wiring (commands run from app/, never a persistent/shared database):
 * Producer job integration-seed-proof needs node-artifact-build. Keep checkout/install, download
 * node-units-* from THIS run, unpack, generate TLS+export SPICEDB_CA_CERT, start fresh Compose services.
 * Use the service-integration job environment, plus APP_ENV_PATH=/dev/null,
 * SPICEDB_DATABASE_PASSWORD and INTEGRATION_SEED_COMMERCE_AUTH_DATABASE_URL naming commerce_auth_runtime
 * with its consumer-supplied password (same local POSTGRES_DB); never persist these values.
 *   mise exec -- node scripts/ci/integration-seed.mts produce \
 *     --directory "$RUNNER_TEMP/integration-seed" --disposable
 *   mise exec -- node scripts/ci/worker-host-artifact.mts build \
 *     --directory "$RUNNER_TEMP/worker-host" \
 *     --from-proof "$RUNNER_TEMP/integration-seed-proof/outbox-worker-host-artifact"
 * Upload actions/upload-artifact name=integration-seed-${{ github.run_id }}
 * path=${{ runner.temp }}/integration-seed; worker upload: see worker-host-artifact.mts.
 * Keep existing always() Compose teardown. Do NOT upload integration-seed-proof (contains logs).
 *
 * Consumers need integration-seed-proof; keep install, same-run Node artifacts/native composition,
 * TLS generation and fresh Compose startup. Download integration-seed-${{ github.run_id }} into
 * $RUNNER_TEMP/integration-seed and integration-worker-host-${{ github.run_id }} into worker-host.
 * Export the SAME environment keys above, with this consumer's passwords, then:
 *   mise exec -- node scripts/ci/integration-seed.mts restore \
 *     --directory "$RUNNER_TEMP/integration-seed" --disposable --purpose ordinary-tests \
 *     --job-name "$CI_MATRIX_NAME" --root-suite "$ROOT_SUITE" --test-files "$CI_TEST_FILES" --jobs 4
 *   mise exec -- node scripts/ci/worker-host-artifact.mts use --directory "$RUNNER_TEMP/worker-host"
 * CI_MATRIX_NAME=${{ matrix.name }}; ROOT_SUITE=${{ matrix.root-suite || false }};
 * CI_TEST_FILES is a comma-separated explicit test-file list, empty for an ordinary package job.
 * root-suite is a String flag (true/false), not a Boolean switch.
 *
 * Replaces login initialization, runtime-role removal, assembled migrator proof, per-package
 * db:migrate+db:verify, grant audit and worker build-and-run in eligible CONSUMERS only.
 * produce runs every one of those steps unchanged and in the original order; proofs are not cached.
 * It never leaves a migrator, fixture server or worker process running. Node outputs/composition,
 * TLS private keys and gateway/auth secrets are NOT in this seed and stay consumer-local.
 *
 * NEVER seed Database, Migration, RLS, Authorization, and Outbox Integration; Root Integration
 * (all shards); Core Runtime Integration; Party Registry Integration;
 * Commerce Customer Context Integration (all shards);
 * or any migration/recovery test in MUST_MIGRATE_TESTS (integration-seed-model.mts).
 * Native-preproposal MUST still create/migrate its disposable source databases; never restore there.
 * Retain today's fresh setup for these jobs. They must exercise their own migration/recovery path.
 * Restore requires --purpose ordinary-tests and refuses --purpose migration-proof/recovery-proof/
 * fresh-database, root-suite=true and excluded job/file names. No migrations fallback exists.
 *
 * Contents: all three non-template databases (POSTGRES_DB, postgres, spicedb), schema+data+owners+
 * grants+extensions+journals, non-builtin role attributes/memberships and reviewed role/db settings,
 * schema fingerprints+journal row counts, SpiceDB schema and its asserted empty relationships.
 * trust.scope_sealing_keys DATA is excluded and regenerated from random UUIDs on restore. Auth/
 * commerce_auth credential tables and all other secret/password/token/key columns must be empty;
 * an unexpected credential row fails production rather than entering an uploaded dump.
 */
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import {
  COMMERCE_URL_KEY,
  MANIFEST_FILE,
  SEAL_TABLE,
  SeedManifest,
  assertSeedConsumer,
  manifestJson,
  seedFailure,
} from './integration-seed-model.mts';
import {
  assertClusterEvidence,
  assertDatabaseNames,
  assertEmptyDatabases,
  dumpDatabase,
  readDatabases,
  readMemberships,
  readRoles,
  readSettings,
  restoreDatabase,
  restoreRoles,
  restoreSettings,
  rolePasswords,
  validateArchive,
  validateSettings,
  withPostgresFiles,
} from './integration-seed-postgres.mts';
import {
  assertDisposable,
  emptyOutputDirectory,
  requiredEnvironment,
  readSourceRevision,
  runSeedCommand,
  seedSql,
} from './integration-seed-process.mts';
import { restoreSpiceDb, snapshotSpiceDb } from './integration-seed-spicedb.mts';

const PNPM = 'pnpm';
const VERSION_QUERY = "select current_setting('server_version')";
const MIGRATOR_ENVIRONMENT = {
  NODE_ENV: 'production',
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
  ULTRAMODERN_ZEROPS_SERVICE: 'migrator',
  MIGRATOR_PORT: '8080',
};

const runFullProof = (proofDirectory: string) =>
  Effect.gen(function* proveFreshSetup() {
    yield* assertEmptyDatabases();
    yield* emptyOutputDirectory(proofDirectory);
    yield* runSeedCommand(PNPM, ['db:bootstrap-runtime-role'], {
      env: {
        DATABASE_LOGIN_ROLE_POLICY: 'initialize-local',
        ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'development',
      },
    });
    const database = yield* requiredEnvironment('POSTGRES_DB');
    yield* seedSql(database, 'DROP OWNED BY ontos_runtime; DROP ROLE ontos_runtime;');
    const admin = yield* requiredEnvironment('DATABASE_ADMIN_URL');
    const commerceRuntime = yield* requiredEnvironment(COMMERCE_URL_KEY);
    yield* requiredEnvironment('SPICEDB_DATABASE_PASSWORD');
    yield* runSeedCommand(
      'sh',
      ['scripts/prove-zerops-migrator-artifact.sh', path.join(proofDirectory, 'zerops-migrator-artifact')],
      {
        env: {
          ...MIGRATOR_ENVIRONMENT,
          COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: admin,
          COMMERCE_PORTAL_AUTH_DATABASE_URL: commerceRuntime,
        },
      },
    );
    const perPackage = {
      COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: admin,
      COMMERCE_PORTAL_AUTH_DATABASE_URL: yield* requiredEnvironment('DATABASE_URL'),
    };
    yield* runSeedCommand(PNPM, ['db:migrate'], { env: perPackage });
    yield* runSeedCommand(PNPM, ['db:verify'], { env: perPackage });
    yield* runSeedCommand(PNPM, ['database-trust:audit']);
    return yield* runSeedCommand('sh', [
      'scripts/prove-outbox-worker-host-artifact.sh',
      path.join(proofDirectory, 'outbox-worker-host-artifact'),
    ]);
  });

const produce = (directory: string, disposable: boolean) =>
  Effect.scoped(
    Effect.gen(function* produceSeed() {
      yield* assertDisposable(disposable);
      yield* emptyOutputDirectory(directory);
      const temporaryRoot = yield* requiredEnvironment('RUNNER_TEMP');
      yield* runFullProof(path.join(temporaryRoot, 'integration-seed-proof'));
      const names = yield* readDatabases();
      yield* assertDatabaseNames(names);
      const settings = yield* readSettings();
      yield* validateSettings(settings);
      const databases = yield* withPostgresFiles((containerDirectory) =>
        Effect.forEach(names, (name, index) => dumpDatabase(name, index, directory, containerDirectory), {
          concurrency: 1,
        }),
      );
      const manifest = new SeedManifest({
        version: 1,
        sourceRevision: yield* readSourceRevision(),
        workflowRun: yield* requiredEnvironment('GITHUB_RUN_ID'),
        postgresVersion: (yield* seedSql('template1', VERSION_QUERY)).trim(),
        roles: yield* readRoles(),
        memberships: yield* readMemberships(),
        settings,
        databases,
        spiceSchema: yield* snapshotSpiceDb(),
        spiceRelationships: [],
        regeneratedTables: [SEAL_TABLE],
      });
      const fs = yield* FileSystem.FileSystem;
      // The completion marker is written last; failed production cannot yield a usable artifact.
      return yield* fs.writeFileString(
        path.join(directory, MANIFEST_FILE),
        yield* Schema.encodeEffect(manifestJson)(manifest),
      );
    }),
  );

const restore = (input: {
  readonly directory: string;
  readonly disposable: boolean;
  readonly purpose: string;
  readonly jobName: string;
  readonly rootSuite: string;
  readonly testFiles: string;
  readonly jobs: number;
}) =>
  Effect.scoped(
    Effect.gen(function* restoreSeed() {
      yield* assertSeedConsumer({
        purpose: input.purpose,
        jobName: input.jobName,
        rootSuite: input.rootSuite !== 'false',
        testFiles: input.testFiles.split(',').filter((file) => file !== ''),
      });
      yield* assertDisposable(input.disposable);
      if (!Number.isInteger(input.jobs) || input.jobs < 1 || input.jobs > 8) {
        return yield* seedFailure('--jobs must be an integer between 1 and 8');
      }
      const fs = yield* FileSystem.FileSystem;
      const manifest = yield* Schema.decodeEffect(manifestJson)(
        yield* fs.readFileString(path.join(input.directory, MANIFEST_FILE)),
      );
      const revision = yield* readSourceRevision();
      const postgresVersion = (yield* seedSql('template1', VERSION_QUERY)).trim();
      if (
        manifest.sourceRevision !== revision ||
        manifest.workflowRun !== (yield* requiredEnvironment('GITHUB_RUN_ID')) ||
        manifest.postgresVersion !== postgresVersion
      ) {
        return yield* seedFailure('Seed source/run/PostgreSQL version mismatch; rebuild the seed in this workflow');
      }
      yield* assertDatabaseNames(manifest.databases.map(({ evidence }) => evidence.name));
      yield* validateSettings(manifest.settings);
      yield* Effect.forEach(manifest.databases, (database) => validateArchive(database, input.directory), {
        concurrency: 1,
      });
      yield* assertEmptyDatabases();
      const existingNames = yield* readDatabases();
      if (existingNames.some((name) => !manifest.databases.some(({ evidence }) => evidence.name === name))) {
        return yield* seedFailure('Unexpected existing database; seed restore refuses to mutate the cluster');
      }
      yield* snapshotSpiceDb();
      const passwords = yield* rolePasswords();
      yield* restoreRoles(manifest, passwords);
      yield* withPostgresFiles((containerDirectory) =>
        Effect.forEach(
          manifest.databases,
          (database) => restoreDatabase(database, input.directory, containerDirectory, input.jobs),
          { concurrency: 1, discard: true },
        ),
      );
      yield* restoreSettings(manifest.settings);
      yield* assertClusterEvidence(manifest);
      return yield* restoreSpiceDb(manifest.spiceSchema);
    }),
  );

const directoryFlag = Flag.String('directory');
const disposableFlag = Flag.Boolean('disposable').pipe(Flag.withDefault(false));
const produceCommand = Command.make(
  'produce',
  { directory: directoryFlag, disposable: disposableFlag },
  ({ directory, disposable }) => produce(path.resolve(directory), disposable),
);
const restoreCommand = Command.make(
  'restore',
  {
    directory: directoryFlag,
    disposable: disposableFlag,
    purpose: Flag.Literals('purpose', ['ordinary-tests', 'migration-proof', 'recovery-proof', 'fresh-database']),
    jobName: Flag.String('job-name'),
    rootSuite: Flag.Literals('root-suite', ['true', 'false']),
    testFiles: Flag.String('test-files'),
    jobs: Flag.Int('jobs').pipe(Flag.withDefault(4)),
  },
  (input) => restore({ ...input, directory: path.resolve(input.directory) }),
);
const cli = Command.make('integration-seed').pipe(Command.withSubcommands([produceCommand, restoreCommand]));
if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(Command.run(cli, { version: '1.0.0' })).pipe(Layer.provide(NodeServices.layer)),
    ).pipe(Effect.scoped),
  );
}
