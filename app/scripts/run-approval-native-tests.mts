import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Effect, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { ChildProcess } from 'effect/process';

import { loadDatabaseIdentityConnections } from '../packages/core-runtime/src/db/config.ts';
import { APP_DATABASE_IDENTITY_ENROLLMENT, DATABASE_IDENTITIES } from '../database/identity-enrollment.ts';
import { loadSpiceDbConfig } from '../packages/core-runtime/src/permissions/config.ts';

class ApprovalNativeTestFailed extends Schema.TaggedError<ApprovalNativeTestFailed>()('ApprovalNativeTestFailed', {
  exitCode: Schema.Number,
}) {}

const freshProof = 'fresh-proof';
const genuineApproval = 'genuine-approval';

// Load configuration through the application-owned parsers. Credentials stay in the child
// environment; they are never printed, written into receipts, or passed as command arguments.
const cli = Command.make(
  'approval-native-tests',
  {
    testCase: Flag.Literals('case', [freshProof, genuineApproval]).pipe(Flag.withDefault(freshProof)),
    testName: Flag.String('name').pipe(Flag.withDefault('')),
  },
  ({ testCase, testName }) =>
    Effect.gen(function* runApprovalNativeTests() {
      const database = yield* loadDatabaseIdentityConnections({
        enrollment: APP_DATABASE_IDENTITY_ENROLLMENT,
        envPath: '/dev/null',
      });
      const permissions = yield* loadSpiceDbConfig({ envPath: '/dev/null' });
      const inherited = yield* Config.all({
        HOME: Config.String('HOME'),
        PATH: Config.String('PATH'),
        TMPDIR: Config.String('TMPDIR').pipe(Config.withDefault('/tmp')),
      });
      const preproposal =
        testCase === genuineApproval
          ? yield* Config.all({
              ONTOS_APPROVAL_NATIVE: Config.Boolean('ONTOS_APPROVAL_NATIVE').pipe(Config.map(String)),
              ONTOS_PREPROPOSAL_NATIVE: Config.Boolean('ONTOS_PREPROPOSAL_NATIVE').pipe(Config.map(String)),
              ONTOS_PREPROPOSAL_SOURCE_DATABASE: Config.schema(
                Schema.String.check(Schema.isPattern(/^ontos_test_[a-z0-9_]+$/u)),
                'ONTOS_PREPROPOSAL_SOURCE_DATABASE',
              ),
              ONTOS_PREPROPOSAL_TASK_ROOT: Config.schema(
                Schema.String.check(Schema.isPattern(/^\//u)),
                'ONTOS_PREPROPOSAL_TASK_ROOT',
              ),
            })
          : {};
      const environment = {
        ...inherited,
        ...preproposal,
        APP_ENV_PATH: '/dev/null',
        DATABASE_ADMIN_URL: database.admin.connectionString,
        ONTOS_PREPROPOSAL_STANDALONE: 'false',
        ...Object.fromEntries(
          DATABASE_IDENTITIES.map((identity) => [identity.urlKey, database.runtime[identity.id].connectionString]),
        ),
        SPICEDB_CA_CERT: permissions.caCertificate,
        SPICEDB_ENDPOINT: permissions.endpoint,
        SPICEDB_PRESHARED_KEY: permissions.preSharedKey,
        ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: permissions.deploymentEnvironment,
      };
      const child = yield* ChildProcess.make(
        'mise',
        [
          'exec',
          '--',
          'pnpm',
          '--filter',
          '@app/commerce-customer-context',
          'exec',
          'rstest',
          'run',
          '--project',
          'integration',
          testCase === freshProof
            ? 'tests/integration/purchase-approval-fresh-proof-postgres.test.ts'
            : 'tests/integration/preproposal-basis-postgres.test.ts',
          '--testTimeout',
          testCase === freshProof ? '180000' : '600000',
          ...(testName.length === 0 ? [] : ['-t', testName]),
        ],
        {
          cwd: new URL('../', import.meta.url).pathname,
          env: environment,
          extendEnv: false,
          stderr: 'inherit',
          stdin: 'inherit',
          stdout: 'inherit',
        },
      );
      const exitCode = Number(yield* child.exitCode);
      if (exitCode !== 0) {
        yield* new ApprovalNativeTestFailed({ exitCode });
      }
    }),
);

NodeRuntime.runMain(Command.run(cli, { version: '1.0.0' }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
