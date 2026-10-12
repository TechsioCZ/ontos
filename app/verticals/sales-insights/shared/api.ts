import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalReadiness, MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';
import { identity } from 'effect';

// <generated-governed-http-api-imports>

import { ApplyCommandActionApi } from './apis/apply-command-action.ts';
import { RecordsApi } from './apis/records.ts';
// </generated-governed-http-api-imports>

export type SalesInsightsReadiness = MicroVerticalReadiness;
export const salesInsightsMarkerSchema = Schema.Struct({ ...MicroVerticalBuildMarkerSchema.fields });
export const salesInsightsReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: salesInsightsMarkerSchema,
});

export type OperationContext = MicroVerticalOperationContext;

export const salesInsightsFoundationApi = HttpApi.make('SalesInsightsApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/sales-insights/readiness', { success: salesInsightsReadinessSchema }),
  ),
);

export const salesInsightsApi = HttpApi.make('SalesInsightsApi')
  .addHttpApi(salesInsightsFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(RecordsApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const salesInsightsOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'SalesInsightsApi:foundation:readiness',
    routePath: '/sales-insights/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const salesInsightsApiContract = {
  apiPrefix: '/sales-insights-api',
  basePath: '/sales-insights-api/sales-insights',
  ownerId: 'sales-insights',
  readinessPath: '/sales-insights-api/sales-insights/readiness',
} as const;
