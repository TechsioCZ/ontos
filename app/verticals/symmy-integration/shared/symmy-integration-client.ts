import { makeEffectBffClientOptions } from '@app/shared-contracts/client-runtime';
import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { Context, Layer } from 'effect';

import { symmyIntegrationApi, symmyIntegrationApiContract, symmyIntegrationOperationContexts } from './api.ts';

export { Effect, runEffectRequest } from '@modern-js/bff-effect/effect-client';
// <generated-action-http-client-exports>
export {
  executeAdmitSymmyJob,
  executeAdmitSymmyJobWithAuthorization,
} from '../src/api/admit-symmy-job-action-client.ts';
export type { AdmitSymmyJobActionClientOptions } from '../src/api/admit-symmy-job-action-client.ts';
export {
  executeAdmitSymmySync,
  executeAdmitSymmySyncWithAuthorization,
} from '../src/api/admit-symmy-sync-action-client.ts';
export type { AdmitSymmySyncActionClientOptions } from '../src/api/admit-symmy-sync-action-client.ts';
export {
  executeExecuteSymmyRetention,
  executeExecuteSymmyRetentionWithAuthorization,
} from '../src/api/execute-symmy-retention-action-client.ts';
export type { ExecuteSymmyRetentionActionClientOptions } from '../src/api/execute-symmy-retention-action-client.ts';
// </generated-action-http-client-exports>

const foundationClient = Effect.gen(function* makeSymmyIntegrationFoundationClient() {
  const options = yield* makeEffectBffClientOptions({
    defaultApiPrefix: symmyIntegrationApiContract.apiPrefix,
    requestContext: { operationContext: symmyIntegrationOperationContexts.readiness },
  });
  return yield* makeEffectHttpApiClient(symmyIntegrationApi, options);
});

type FoundationClient = Effect.Success<typeof foundationClient>;

export class SymmyIntegrationFoundationClient extends Context.Service<
  SymmyIntegrationFoundationClient,
  FoundationClient
>()('@app/symmy-integration/shared/symmy-integration-client/SymmyIntegrationFoundationClient') {}

export const SymmyIntegrationFoundationClientLive = Layer.effect(SymmyIntegrationFoundationClient, foundationClient);
export const getSymmyIntegrationReadiness = SymmyIntegrationFoundationClient.pipe(
  Effect.flatMap((client) => client.foundation.readiness({})),
);
