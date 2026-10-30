import { DATABASE_IDENTITIES, loadDatabaseIdentityConnections, loadDatabaseConnectionPair } from '@app/core-runtime';
import { readAllocatedPermissionEnvironment } from './preproposal-basis-native.ts';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { Config, Effect, FileSystem, Path, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';

const applicationRoot = new URL('../../../../', import.meta.url).pathname;

class PreproposalBootstrapError extends Schema.TaggedError<PreproposalBootstrapError>()('PreproposalBootstrapError', {
  stage: Schema.String,
}) {}

/** Test infrastructure only. Migrate a fresh empty allocation, never the configured source. */
export const bootstrapPreproposalNativeSource = Effect.fn('PreproposalNative.bootstrapSource')(
  function* bootstrapPreproposalNativeSource() {
    const identities = yield* loadDatabaseIdentityConnections();
    const sourceConnections = yield* loadDatabaseConnectionPair();
    const source = yield* makeIsolatedNativeDatabaseFixture({
      mode: 'empty',
      purpose: 'stabilization-1257-approval-fresh-proof',
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
    // Explicit environment wins over dotenv in every migrator/verifier. Validate all
    // derived identities before any process can mutate the disposable allocation.
    yield* loadDatabaseIdentityConnections({ environment, envPath: '/dev/null' });
    const inherited = yield* Config.all({
      HOME: Config.String('HOME'),
      PATH: Config.String('PATH'),
      TMPDIR: Config.String('TMPDIR').pipe(Config.withDefault('/tmp')),
    });
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const taskRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'ontos-1257-native-' });
    const commands = ['db:migrate', 'db:verify'] as const;
    yield* Effect.forEach(
      commands,
      Effect.fn('PreproposalNative.bootstrapCommand')(function* bootstrapCommand(command) {
        yield* Effect.logInfo(`Preproposal standalone: ${command} on empty disposable source`);
        const child = yield* ChildProcess.make('pnpm', [command], {
          cwd: applicationRoot,
          env: { ...inherited, ...environment, APP_ENV_PATH: '/dev/null' },
          extendEnv: false,
          stderr: 'pipe',
          stdout: 'pipe',
        });
        // Raw tool output can contain connection configuration. Keep it private and
        // report only the command and exit status; receipts contain no credentials.
        const [exitCode] = yield* Effect.all(
          [child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)],
          { concurrency: 3 },
        );
        if (exitCode !== 0) {
          yield* new PreproposalBootstrapError({ stage: command });
        }
        yield* Effect.logInfo(`Preproposal standalone: ${command} passed`);
      }),
      { concurrency: 1, discard: true },
    );
    const receipt = yield* Schema.encodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          commands: Schema.Array(Schema.String),
          database: Schema.String,
          status: Schema.Literal('completed'),
          version: Schema.Literal(1),
        }),
      ),
    )({ commands, database: target, status: 'completed', version: 1 });
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
