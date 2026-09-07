// @effect-diagnostics nodeBuiltinImport:off processEnv:off -- Existing compatibility boundary; expires: 2026-12-31.
import { Cause, Console, Effect, Exit } from 'effect';
import { bootstrapStageDemo } from '../api/auth/stage-demo-bootstrap-runtime-infrastructure.ts';

const program = Effect.gen(function* bootstrapStageDemoProgram() {
  const result = yield* bootstrapStageDemo();
  yield* Effect.forEach(
    result.accounts,
    (account) =>
      Console.log(
        `Stage demo bootstrap complete (${account.authUser} auth user): tenant=${account.tenantId} legalEntity=${account.legalEntityId} principal=${account.principalId} email=${account.email}`,
      ),
    { discard: true },
  );
}).pipe(
  Effect.tapCause((cause) => {
    const error = Cause.squash(cause);
    const message = error instanceof Error ? error.message : 'Unknown stage demo bootstrap failure';
    return Console.error(`Stage demo bootstrap failed: ${message}`);
  }),
);

const exit = await Effect.runPromiseExit(program);
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
