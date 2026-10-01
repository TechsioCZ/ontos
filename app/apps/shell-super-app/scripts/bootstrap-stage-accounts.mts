// @effect-diagnostics nodeBuiltinImport:off processEnv:off -- Existing compatibility boundary; expires: 2026-12-31.
import { NodeServices } from '@effect/platform-node';
import { readStageAccountsFileContents } from '@app/core-runtime/install/stage-accounts-file';
import { Console, Effect, Exit, Layer } from 'effect';

import { AuthConfig } from '../api/auth/config.ts';
import { AuthDatabaseLive } from '../api/auth/db/client.ts';
import { StageAccountsBootstrapError } from '../api/auth/stage-accounts-bootstrap-contract.ts';
import type { StageAccountsFileReader } from '../api/auth/stage-accounts-bootstrap-contract.ts';
import {
  bootstrapStageAccounts,
  loadStageAccountsConfiguration,
} from '../api/auth/stage-accounts-bootstrap-runtime-infrastructure.ts';

/** Reads the operator accounts file named by `ONTOS_STAGE_ACCOUNTS_FILE`; its values are never logged. */
const readAccountsFile: StageAccountsFileReader = (path) =>
  readStageAccountsFileContents(path).pipe(Effect.provide(NodeServices.layer));

const program = Effect.gen(function* bootstrapStageAccountsProgram() {
  const configuration = yield* loadStageAccountsConfiguration(readAccountsFile);
  const result = yield* bootstrapStageAccounts(configuration).pipe(
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
        `Stage accounts bootstrap complete (${account.authUser} auth user): tenant=${account.tenantId} legalEntity=${account.legalEntityId} principal=${account.principalId} email=${account.email}`,
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

const exit = await Effect.runPromiseExit(program);
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
