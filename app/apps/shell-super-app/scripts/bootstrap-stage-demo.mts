// @effect-diagnostics nodeBuiltinImport:off processEnv:off
import { Effect } from 'effect';
import { bootstrapStageDemo } from '../api/auth/stage-demo-bootstrap-runtime-infrastructure.ts';

try {
  const result = await Effect.runPromise(bootstrapStageDemo());
  for (const account of result.accounts) {
    console.log(
      `Stage demo bootstrap complete (${account.authUser} auth user): tenant=${account.tenantId} legalEntity=${account.legalEntityId} principal=${account.principalId} email=${account.email}`,
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown stage demo bootstrap failure';
  console.error(`Stage demo bootstrap failed: ${message}`);
  process.exitCode = 1;
}
