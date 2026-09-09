import { identity } from 'effect';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@app/shared-contracts';
import type {
  MicroVerticalBuildMarker,
  MicroVerticalOperationContext,
  MicroVerticalReadiness,
} from '@app/shared-contracts';
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  Schema,
} from '@modern-js/plugin-bff/effect-client';

export type CommerceFxMarker = MicroVerticalBuildMarker;

export type CommerceFxReadiness = MicroVerticalReadiness;

export const commerceFxMarkerSchema: Schema.Codec<CommerceFxMarker> =
  MicroVerticalBuildMarkerSchema;

export const commerceFxReadinessSchema: Schema.Codec<CommerceFxReadiness> =
  MicroVerticalReadinessSchema;

export type OperationContext = MicroVerticalOperationContext;

export const commerceFxFoundationApi = HttpApi.make('CommerceFxApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/commerce-fx/readiness', {
      success: commerceFxReadinessSchema,
    }),
  ),
);

// <generated-governed-http-api-imports>
import { ChangeManualCommercialRatePolicyActionApi } from './apis/change-manual-commercial-rate-policy-action.ts';
import { CommercialFxConversionApi } from './apis/commercial-fx-conversion.ts';
// </generated-governed-http-api-imports>

export {
  CommercialFxConversionApi,
  CommercialFxConversionRequestSchema,
  CommercialFxConversionResponseSchema,
} from './apis/commercial-fx-conversion.ts';
export type {
  CommercialFxConversionRequest,
  CommercialFxConversionResponse,
} from './apis/commercial-fx-conversion.ts';

export const commerceFxApi = HttpApi.make('CommerceFxApi')
  .addHttpApi(commerceFxFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ChangeManualCommercialRatePolicyActionApi)
  .addHttpApi(CommercialFxConversionApi)
  // </generated-governed-http-api-additions>
  .pipe(identity);
export const commerceFxOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'CommerceFxApi:commerceFx:readiness',
    routePath: '/commerce-fx/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const commerceFxApiContract = {
  apiPrefix: '/commerce-fx-api',
  basePath: '/commerce-fx-api/commerce-fx',
  ownerId: 'commerce-fx',
  readinessPath: '/commerce-fx-api/commerce-fx/readiness',
} as const;
