import { makeEffectBffClientOptions } from '@app/shared-contracts/client-runtime';
import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { Context, Layer } from 'effect';
import { commerceCartApiContract, commerceCartApi, commerceCartOperationContexts } from './api';

export { Effect, runEffectRequest } from '@modern-js/bff-effect/effect-client';
// <generated-action-http-client-exports>
export {
  executeCloseCartDraft,
  executeCloseCartDraftWithAuthorization,
} from '../src/api/close-cart-draft-action-client.ts';
export type { CloseCartDraftActionClientOptions } from '../src/api/close-cart-draft-action-client.ts';
export {
  executeCreateCartDraft,
  executeCreateCartDraftWithAuthorization,
} from '../src/api/create-cart-draft-action-client.ts';
export type { CreateCartDraftActionClientOptions } from '../src/api/create-cart-draft-action-client.ts';
export {
  executeInitializePopulationAuthority,
  executeInitializePopulationAuthorityWithAuthorization,
} from '../src/api/initialize-population-authority-action-client.ts';
export type { InitializePopulationAuthorityActionClientOptions } from '../src/api/initialize-population-authority-action-client.ts';
export {
  executeReviseCartDraft,
  executeReviseCartDraftWithAuthorization,
} from '../src/api/revise-cart-draft-action-client.ts';
export type { ReviseCartDraftActionClientOptions } from '../src/api/revise-cart-draft-action-client.ts';
export * from '../src/api/finalize-cart-candidate-action-client.ts';
// </generated-action-http-client-exports>

const foundationClient = Effect.gen(function* acquireCartFoundationClient() {
  const clientOptions = yield* makeEffectBffClientOptions({
    defaultApiPrefix: commerceCartApiContract.apiPrefix,
    requestContext: { operationContext: commerceCartOperationContexts.readiness },
  });
  return yield* makeEffectHttpApiClient(commerceCartApi, clientOptions);
});
type FoundationClient = Effect.Success<typeof foundationClient>;
/** Readiness transport is acquired once per composed Layer lifetime. */
export class CommerceCartFoundationClient extends Context.Service<CommerceCartFoundationClient, FoundationClient>()(
  '@app/commerce-cart/shared/commerce-cart-client/CommerceCartFoundationClient',
) {}
export const CommerceCartFoundationClientLive = Layer.effect(CommerceCartFoundationClient, foundationClient);
/** Business operations use their standalone assertion-bound generated clients. */
export const getCommerceCartReadiness = CommerceCartFoundationClient.pipe(
  Effect.flatMap((client) => client.foundation.readiness({})),
);
