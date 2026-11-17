import { DATABASE_IDENTITIES, loadDatabaseIdentityConnections, loadDatabaseConnectionPair } from '@app/core-runtime';
import { readAllocatedPermissionEnvironment } from './preproposal-basis-native.ts';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { Config, Effect, FileSystem, Path, Schema } from 'effect';
import { ChildProcess } from 'effect/process';

const sourcePreparation = 'schema-only';
const applicationRoot = new URL('../../../../', import.meta.url).pathname;

class PreproposalBootstrapError extends Schema.TaggedError<PreproposalBootstrapError>()('PreproposalBootstrapError', {
  stage: Schema.String,
}) {}

/** Test infrastructure only. Clone the verified schema without source data or authority. */
export const bootstrapPreproposalNativeSource = Effect.fn('PreproposalNative.bootstrapSource')(
  function* bootstrapPreproposalNativeSource() {
    const identities = yield* loadDatabaseIdentityConnections();
    const sourceConnections = yield* loadDatabaseConnectionPair();
    const source = yield* makeIsolatedNativeDatabaseFixture({
      mode: sourcePreparation,
      purpose: 'implementation-1290-preproposal-native-source',
      sourceConnections,
    });
    const target = source.connections.admin.database;
    const retarget = (connectionString: string) => {
      const url = new URL(connectionString);
      url.pathname = `/${target}`;
      return url.href;
    };
    const environment = {
      DATABASE_ADMIN_URL: source.connections.admin.connectionString,
      DATABASE_URL: source.connections.runtime.connectionString,
      ...Object.fromEntries(
        DATABASE_IDENTITIES.map((identity) => [
          identity.urlKey,
          retarget(identities.runtime[identity.id].connectionString),
        ]),
      ),
    };
    // Explicit environment wins over dotenv. Validate all derived identities
    // before any owner process can mutate the disposable allocation.
    yield* loadDatabaseIdentityConnections({ environment, envPath: '/dev/null' });
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const taskRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'ontos-1257-native-' });
    const receipt = yield* Schema.encodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          database: Schema.String,
          preparation: Schema.Literal(sourcePreparation),
          status: Schema.Literal('completed'),
          version: Schema.Literal(1),
        }),
      ),
    )({ database: target, preparation: sourcePreparation, status: 'completed', version: 1 });
    yield* fileSystem.writeFileString(path.join(taskRoot, 'source-bootstrap-completed.json'), receipt, {
      flag: 'wx',
      mode: 0o600,
    });
    return {
      ...environment,
      ONTOS_PREPROPOSAL_SOURCE_DATABASE: target,
      ONTOS_PREPROPOSAL_TASK_ROOT: taskRoot,
    };
  },
);

/** A real child environment also reaches Core loaders that intentionally read process env. */
export const runStandalonePreproposalNativeTest = Effect.fn('PreproposalNative.standaloneTest')(
  function* runStandalonePreproposalNativeTest(approval: boolean) {
    const permissions = yield* readAllocatedPermissionEnvironment();
    const environment = yield* bootstrapPreproposalNativeSource();
    const inherited = yield* Config.all({
      HOME: Config.String('HOME'),
      // The container the isolated-database fixture runs pg_dump/psql in; a lane-owned stack names its own.
      ONTOS_TEST_DB_CONTAINER: Config.String('ONTOS_TEST_DB_CONTAINER').pipe(Config.withDefault('ontos-db')),
      PATH: Config.String('PATH'),
      TMPDIR: Config.String('TMPDIR').pipe(Config.withDefault('/tmp')),
    });
    const child = yield* ChildProcess.make(
      process.execPath,
      [
        'scripts/run-approval-native-tests.mts',
        '--case',
        'genuine-approval',
        '--name',
        approval ? 'submits and approves' : 'produces an exact preproposal basis',
      ],
      {
        cwd: applicationRoot,
        env: {
          ...inherited,
          ...environment,
          APP_ENV_PATH: '/dev/null',
          ...permissions,
          ONTOS_APPROVAL_NATIVE: String(approval),
          ONTOS_PREPROPOSAL_NATIVE: String(!approval),
          ONTOS_PREPROPOSAL_STANDALONE: 'false',
        },
        extendEnv: false,
        stderr: 'inherit',
        stdout: 'inherit',
      },
    );
    if ((yield* child.exitCode) !== 0) {
      return yield* new PreproposalBootstrapError({ stage: 'registered-native-chain' });
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const receipt = yield* Schema.encodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          approval: Schema.Boolean,
          exitCode: Schema.Literal(0),
          status: Schema.Literal('ASSERTIONS_COMPLETED'),
        }),
      ),
    )({ approval, exitCode: 0, status: 'ASSERTIONS_COMPLETED' });
    yield* fileSystem.writeFileString(
      path.join(environment.ONTOS_PREPROPOSAL_TASK_ROOT, 'native-run-completed.json'),
      receipt,
      { flag: 'wx', mode: 0o600 },
    );
    return environment.ONTOS_PREPROPOSAL_TASK_ROOT;
  },
);
