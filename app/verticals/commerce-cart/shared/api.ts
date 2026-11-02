import { identity } from 'effect';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';

// <generated-governed-http-api-imports>
import { CloseCartDraftActionApi } from './apis/close-cart-draft-action.ts';
import { CreateCartDraftActionApi } from './apis/create-cart-draft-action.ts';
import { FinalCartCandidateApi } from './apis/final-cart-candidate.ts';
import { FinalizeCartCandidateActionApi } from './apis/finalize-cart-candidate-action.ts';
import { InitializePopulationAuthorityActionApi } from './apis/initialize-population-authority-action.ts';
import { OpenSelectionPopulationApi } from './apis/open-selection-population.ts';
import { PreapprovalCartObservationApi } from './apis/preapproval-cart-observation.ts';
import { ReviseCartDraftActionApi } from './apis/revise-cart-draft-action.ts';
// </generated-governed-http-api-imports>

export const commerceCartMarkerSchema = Schema.Struct({
  ...MicroVerticalBuildMarkerSchema.fields,
  kind: Schema.Literal('microvertical-delivery-unit'),
  schemaVersion: Schema.Literal(1),
});
export type CommerceCartMarker = typeof commerceCartMarkerSchema.Type;

export const commerceCartReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: commerceCartMarkerSchema,
});
export type CommerceCartReadiness = typeof commerceCartReadinessSchema.Type;

export type OperationContext = MicroVerticalOperationContext;

export const commerceCartFoundationApi = HttpApi.make('CommerceCartApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/commerce-cart/readiness', { success: commerceCartReadinessSchema }),
  ),
);
export const commerceCartApi = HttpApi.make('CommerceCartApi')
  .addHttpApi(commerceCartFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(CloseCartDraftActionApi)
  .addHttpApi(CreateCartDraftActionApi)
  .addHttpApi(FinalCartCandidateApi)
  .addHttpApi(FinalizeCartCandidateActionApi)
  .addHttpApi(InitializePopulationAuthorityActionApi)
  .addHttpApi(OpenSelectionPopulationApi)
  .addHttpApi(PreapprovalCartObservationApi)
  .addHttpApi(ReviseCartDraftActionApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const commerceCartOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'CommerceCartApi:commerceCart:readiness',
    routePath: '/commerce-cart/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const commerceCartApiContract = {
  apiPrefix: '/commerce-cart-api',
  basePath: '/commerce-cart-api/commerce-cart',
  ownerId: 'commerce-cart',
  readinessPath: '/commerce-cart-api/commerce-cart/readiness',
} as const;
