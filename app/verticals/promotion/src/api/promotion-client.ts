import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { makeEffectBffClientOptions } from '@app/shared-contracts/client-runtime';
import type { EffectBffClientOptions } from '@app/shared-contracts/client-runtime';
import { Context, Layer } from 'effect';
import type { HttpApiClient } from 'effect/http-api';
import { promotionApi, promotionApiContract } from '../../shared/api.ts';

// <generated-action-http-client-exports>
export {
  executeCreatePromotionDraft,
  executeCreatePromotionDraftWithAuthorization,
} from './create-promotion-draft-action-client.ts';
export type { CreatePromotionDraftActionClientOptions } from './create-promotion-draft-action-client.ts';
export {
  executeCreatePromotionSuccessor,
  executeCreatePromotionSuccessorWithAuthorization,
} from './create-promotion-successor-action-client.ts';
export type { CreatePromotionSuccessorActionClientOptions } from './create-promotion-successor-action-client.ts';
export {
  executeDisablePromotion,
  executeDisablePromotionWithAuthorization,
} from './disable-promotion-action-client.ts';
export type { DisablePromotionActionClientOptions } from './disable-promotion-action-client.ts';
export { executeDisableVoucher, executeDisableVoucherWithAuthorization } from './disable-voucher-action-client.ts';
export type { DisableVoucherActionClientOptions } from './disable-voucher-action-client.ts';
export {
  executeEditPromotionDraft,
  executeEditPromotionDraftWithAuthorization,
} from './edit-promotion-draft-action-client.ts';
export type { EditPromotionDraftActionClientOptions } from './edit-promotion-draft-action-client.ts';
export { executeEndPromotion, executeEndPromotionWithAuthorization } from './end-promotion-action-client.ts';
export type { EndPromotionActionClientOptions } from './end-promotion-action-client.ts';
export {
  executeProvisionVoucher,
  executeProvisionVoucherWithAuthorization,
} from './provision-voucher-action-client.ts';
export type { ProvisionVoucherActionClientOptions } from './provision-voucher-action-client.ts';
export {
  executePublishPromotion,
  executePublishPromotionWithAuthorization,
} from './publish-promotion-action-client.ts';
export type { PublishPromotionActionClientOptions } from './publish-promotion-action-client.ts';
export { executeRetirePromotion, executeRetirePromotionWithAuthorization } from './retire-promotion-action-client.ts';
export type { RetirePromotionActionClientOptions } from './retire-promotion-action-client.ts';
export { executeSetBasisPolicy, executeSetBasisPolicyWithAuthorization } from './set-basis-policy-action-client.ts';
export type { SetBasisPolicyActionClientOptions } from './set-basis-policy-action-client.ts';
export { executeSetCartRanking, executeSetCartRankingWithAuthorization } from './set-cart-ranking-action-client.ts';
export type { SetCartRankingActionClientOptions } from './set-cart-ranking-action-client.ts';
export {
  executeSetShippingRanking,
  executeSetShippingRankingWithAuthorization,
} from './set-shipping-ranking-action-client.ts';
export type { SetShippingRankingActionClientOptions } from './set-shipping-ranking-action-client.ts';
// </generated-action-http-client-exports>

export class PromotionApiClient extends Context.Service<
  PromotionApiClient,
  HttpApiClient.ForApi<typeof promotionApi>
>()('@app/promotion/api/promotion-client/PromotionApiClient') {}

/** Trusted transport configuration is supplied once by the application or test composition. */
export const PromotionClientConfiguration = Context.Reference<EffectBffClientOptions>(
  '@app/promotion/api/promotion-client/PromotionClientConfiguration',
  { defaultValue: () => ({}) },
);
export const PromotionApiClientLive = Layer.effect(
  PromotionApiClient,
  Effect.gen(function* makePromotionClient() {
    const options = yield* PromotionClientConfiguration;
    const clientOptions = yield* makeEffectBffClientOptions({
      ...options,
      defaultApiPrefix: promotionApiContract.apiPrefix,
    });
    return yield* makeEffectHttpApiClient(promotionApi, clientOptions);
  }),
);
export const getPromotionReadiness = PromotionApiClient.pipe(
  Effect.flatMap((client) => client.foundation.readiness({})),
);
