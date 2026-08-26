// @effect-diagnostics nodeBuiltinImport:off processEnv:off
import { Effect } from 'effect';
import { bootstrapStageDemo } from '../api/auth/stage-demo-bootstrap-runtime-infrastructure.ts';

try {
  const result = await Effect.runPromise(bootstrapStageDemo());
  console.log(
    `Stage demo bootstrap complete (${result.authUser} auth user): tenant=${result.tenantId} legalEntity=${result.legalEntityId} principal=${result.principalId} email=${result.email}`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown stage demo bootstrap failure';
  console.error(`Stage demo bootstrap failed: ${message}`);
  process.exitCode = 1;
}
