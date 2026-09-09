// @effect-diagnostics nodeBuiltinImport:off processEnv:off -- Existing compatibility boundary; expires: 2026-12-31.
import { Console, Effect, Exit, Layer } from 'effect';

import { AuthConfig } from '../api/auth/config.ts';
import { AuthDatabaseLive } from '../api/auth/db/client.ts';
import { StageDemoBootstrapError } from '../api/auth/stage-demo-bootstrap-contract.ts';
import {
  bootstrapStageDemo,
  loadStageDemoConfiguration,
} from '../api/auth/stage-demo-bootstrap-runtime-infrastructure.ts';

const program = Effect.gen(function* bootstrapStageDemoProgram() {
  const configuration = yield* loadStageDemoConfiguration();
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
        `Stage demo bootstrap complete (${account.authUser} auth user): tenant=${account.tenantId} legalEntity=${account.legalEntityId} principal=${account.principalId} email=${account.email}`,
      ),
    { discard: true },
  );
}).pipe(
  Effect.tapError((failure) => Console.error(`Stage demo bootstrap failed: ${failure.reason}`)),
  Effect.tapDefect(() => Console.error('Stage demo bootstrap failed unexpectedly')),
);

const exit = await Effect.runPromiseExit(program);
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
