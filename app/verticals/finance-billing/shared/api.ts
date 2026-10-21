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

export type FinanceBillingMarker = MicroVerticalBuildMarker;

export const financeBillingMarkerSchema = Schema.Struct({ ...MicroVerticalBuildMarkerSchema.fields });
export const financeBillingReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: financeBillingMarkerSchema,
});
export type FinanceBillingReadiness = typeof financeBillingReadinessSchema.Type;

export type OperationContext = MicroVerticalOperationContext;

export const financeBillingFoundationApi = HttpApi.make('FinanceBillingApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/finance-billing/readiness', {
      success: financeBillingReadinessSchema,
    }),
  ),
);

export const financeBillingApi = HttpApi.make('FinanceBillingApi')
  .addHttpApi(financeBillingFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(RecordsApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const financeBillingOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'FinanceBillingApi:financeBilling:readiness',
    routePath: '/finance-billing/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const financeBillingApiContract = {
  apiPrefix: '/finance-billing-api',
  basePath: '/finance-billing-api/finance-billing',
  ownerId: 'finance-billing',
  readinessPath: '/finance-billing-api/finance-billing/readiness',
} as const;
