// @effect-diagnostics nodeBuiltinImport:off processEnv:off -- Existing compatibility boundary; expires: 2026-12-31.
import { NodeServices } from '@effect/platform-node';
import { Console, Effect, Exit, FileSystem, Layer } from 'effect';

import { AuthConfig } from '../api/auth/config.ts';
import { AuthDatabaseLive } from '../api/auth/db/client.ts';
import { StageDemoBootstrapError } from '../api/auth/stage-demo-bootstrap-contract.ts';
import type { StageAccountsFileReader } from '../api/auth/stage-demo-bootstrap-contract.ts';
import {
  bootstrapStageDemo,
  loadStageDemoConfiguration,
} from '../api/auth/stage-demo-bootstrap-runtime-infrastructure.ts';

/** Reads the operator accounts file named by `ONTOS_STAGE_ACCOUNTS_FILE`; its values are never logged. */
const readAccountsFile: StageAccountsFileReader = (path) =>
  Effect.gen(function* readStageAccountsFile() {
    const fileSystem = yield* FileSystem.FileSystem;
    const [{ mode }, source] = yield* Effect.all([fileSystem.stat(path), fileSystem.readFileString(path, 'utf-8')], {
      concurrency: 2,
    });
    return { mode, source };
  }).pipe(
    Effect.mapError(
      (cause) =>
        new StageDemoBootstrapError({
          cause,
          code: 'stage_demo_configuration_invalid',
          reason: 'The stage accounts file could not be read',
        }),
    ),
    Effect.provide(NodeServices.layer),
  );

const program = Effect.gen(function* bootstrapStageDemoProgram() {
  const configuration = yield* loadStageDemoConfiguration(readAccountsFile);
  const result = yield* bootstrapStageDemo(configuration).pipe(
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
        new StageDemoBootstrapError({
          code: 'stage_demo_persistence_failed',
          reason: 'The stage authentication database could not be opened',
        }),
    ),
  );
  yield* Effect.forEach(
    result.accounts,
    (account) =>
      Console.log(
        `Stage demo bootstrap complete (${account.authUser} auth user, ${account.role}): tenant=${account.tenantId} legalEntity=${account.legalEntityId} principal=${account.principalId} email=${account.email}`,
      ),
    { discard: true },
  );
  yield* Effect.forEach(
    result.retiredAccounts,
    (account) => Console.log(`Retired stage account ${account.email}: ${account.status}`),
    { discard: true },
  );
}).pipe(
  Effect.tapError((failure) => Console.error(`Stage demo bootstrap failed: ${failure.reason}`)),
  Effect.tapDefect(() => Console.error('Stage demo bootstrap failed unexpectedly')),
);

const exit = await Effect.runPromiseExit(program);
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
