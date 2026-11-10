import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';
import { identity } from 'effect';

// <generated-governed-http-api-imports>
import { CreatePromotionDraftActionApi } from './apis/create-promotion-draft-action.ts';
import { CreatePromotionSuccessorActionApi } from './apis/create-promotion-successor-action.ts';
import { DisablePromotionActionApi } from './apis/disable-promotion-action.ts';
import { DisableVoucherActionApi } from './apis/disable-voucher-action.ts';
import { EditPromotionDraftActionApi } from './apis/edit-promotion-draft-action.ts';
import { EndPromotionActionApi } from './apis/end-promotion-action.ts';
import { PreviewPromotionsApi } from './apis/preview-promotions.ts';
import { ProvisionVoucherActionApi } from './apis/provision-voucher-action.ts';
import { PublishPromotionActionApi } from './apis/publish-promotion-action.ts';
import { ReadPromotionPoliciesApi } from './apis/read-promotion-policies.ts';
import { ReadPromotionsApi } from './apis/read-promotions.ts';
import { ReadVouchersApi } from './apis/read-vouchers.ts';
import { RetirePromotionActionApi } from './apis/retire-promotion-action.ts';
import { SetBasisPolicyActionApi } from './apis/set-basis-policy-action.ts';
import { SetCartRankingActionApi } from './apis/set-cart-ranking-action.ts';
import { SetShippingRankingActionApi } from './apis/set-shipping-ranking-action.ts';
// </generated-governed-http-api-imports>

export type OperationContext = MicroVerticalOperationContext;
export const promotionMarkerSchema = Schema.Struct({
  ...MicroVerticalBuildMarkerSchema.fields,
  kind: Schema.Literal('microvertical-delivery-unit'),
  schemaVersion: Schema.Literal(1),
});
export const promotionReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: promotionMarkerSchema,
});
export type PromotionReadiness = typeof promotionReadinessSchema.Type;
export const promotionFoundationApi = HttpApi.make('PromotionApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/promotion/readiness', { success: promotionReadinessSchema }),
  ),
);

export const promotionApi = HttpApi.make('PromotionApi')
  .addHttpApi(promotionFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(CreatePromotionDraftActionApi)
  .addHttpApi(CreatePromotionSuccessorActionApi)
  .addHttpApi(DisablePromotionActionApi)
  .addHttpApi(DisableVoucherActionApi)
  .addHttpApi(EditPromotionDraftActionApi)
  .addHttpApi(EndPromotionActionApi)
  .addHttpApi(PreviewPromotionsApi)
  .addHttpApi(ProvisionVoucherActionApi)
  .addHttpApi(PublishPromotionActionApi)
  .addHttpApi(ReadPromotionPoliciesApi)
  .addHttpApi(ReadPromotionsApi)
  .addHttpApi(ReadVouchersApi)
  .addHttpApi(RetirePromotionActionApi)
  .addHttpApi(SetBasisPolicyActionApi)
  .addHttpApi(SetCartRankingActionApi)
  .addHttpApi(SetShippingRankingActionApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const promotionOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'PromotionApi:promotion:readiness',
    routePath: '/promotion/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const promotionApiContract = {
  apiPrefix: '/promotion-api',
  basePath: '/promotion-api/promotion',
  ownerId: 'promotion',
  readinessPath: '/promotion-api/promotion/readiness',
} as const;
