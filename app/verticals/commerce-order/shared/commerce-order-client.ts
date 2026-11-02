import { makeEffectBffClientOptions } from '@app/shared-contracts/client-runtime';
import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { Context, Layer } from 'effect';
import type { HttpApi, HttpApiClient } from 'effect/http-api';

import { commerceOrderApiContract, commerceOrderApi, commerceOrderOperationContexts } from './api';

export { Effect, runEffectRequest } from '@modern-js/bff-effect/effect-client';
// <generated-action-http-client-exports>
export * from '../src/api/cancel-order-commitment-action-client.ts';
export * from '../src/api/commit-order-action-client.ts';
export * from '../src/api/complete-order-approval-consumption-action-client.ts';
export * from '../src/api/complete-order-preparation-action-client.ts';
export * from '../src/api/prepare-order-commitment-action-client.ts';
export * from '../src/api/reconcile-order-approval-action-client.ts';
export * from '../src/api/record-order-proof-set-action-client.ts';
export * from '../src/api/record-precommit-failure-action-client.ts';
export * from '../src/api/revalidate-order-commitment-action-client.ts';
// </generated-action-http-client-exports>

type OrderApiGroups = typeof commerceOrderApi extends HttpApi.HttpApi<string, infer Groups> ? Groups : never;
/** Only the foundation group is reachable through this Service; the business groups have standalone clients. */
type FoundationClient = Pick<HttpApiClient.Client<OrderApiGroups>, 'foundation'>;
type ClientOptionsEffect = ReturnType<typeof makeEffectBffClientOptions>;
const foundationClient: Effect.Effect<FoundationClient, Effect.Error<ClientOptionsEffect>> = Effect.gen(
  function* acquireOrderFoundationClient() {
    const clientOptions = yield* makeEffectBffClientOptions({
      defaultApiPrefix: commerceOrderApiContract.apiPrefix,
      requestContext: { operationContext: commerceOrderOperationContexts.readiness },
    });
    return yield* makeEffectHttpApiClient(commerceOrderApi, clientOptions);
  },
);
/** Readiness transport is acquired once per composed Layer lifetime. */
export class CommerceOrderFoundationClient extends Context.Service<CommerceOrderFoundationClient, FoundationClient>()(
  '@app/commerce-order/shared/commerce-order-client/CommerceOrderFoundationClient',
) {}
export const CommerceOrderFoundationClientLive = Layer.effect(CommerceOrderFoundationClient, foundationClient);
/** Business operations use their standalone assertion-bound generated clients. */
export const getCommerceOrderReadiness = CommerceOrderFoundationClient.pipe(
  Effect.flatMap((client) => client.foundation.readiness({})),
);
