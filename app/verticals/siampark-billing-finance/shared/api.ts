import { identity } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalBuildMarker, MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';

// <generated-governed-http-api-imports>
import { ApplyCommandActionApi } from './apis/apply-command-action.ts';
import { RecordsApi } from './apis/records.ts';
// </generated-governed-http-api-imports>

export type SiamparkBillingFinanceMarker = MicroVerticalBuildMarker;

export const siamparkBillingFinanceMarkerSchema = Schema.Struct({ ...MicroVerticalBuildMarkerSchema.fields });
export const siamparkBillingFinanceReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: siamparkBillingFinanceMarkerSchema,
});
export type SiamparkBillingFinanceReadiness = typeof siamparkBillingFinanceReadinessSchema.Type;

export type OperationContext = MicroVerticalOperationContext;

export const siamparkBillingFinanceFoundationApi = HttpApi.make('SiamparkBillingFinanceApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/siampark-billing-finance/readiness', {
      success: siamparkBillingFinanceReadinessSchema,
    }),
  ),
);

export const siamparkBillingFinanceApi = HttpApi.make('SiamparkBillingFinanceApi')
  .addHttpApi(siamparkBillingFinanceFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(RecordsApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const siamparkBillingFinanceOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'SiamparkBillingFinanceApi:siamparkBillingFinance:readiness',
    routePath: '/siampark-billing-finance/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const siamparkBillingFinanceApiContract = {
  apiPrefix: '/siampark-billing-finance-api',
  basePath: '/siampark-billing-finance-api/siampark-billing-finance',
  ownerId: 'siampark-billing-finance',
  readinessPath: '/siampark-billing-finance-api/siampark-billing-finance/readiness',
} as const;
