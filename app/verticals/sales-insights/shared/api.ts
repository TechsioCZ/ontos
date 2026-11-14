import { OwnerActionApprovalApi } from '@app/core-runtime/access/approvals/owner-api';
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
import { AssignMetricActionApi } from './apis/assign-metric-action.ts';
import { ChangeMetricStateActionApi } from './apis/change-metric-state-action.ts';
import { RecordsApi } from './apis/records.ts';
import { UpdateMetricActionApi } from './apis/update-metric-action.ts';
// </generated-governed-http-api-imports>

export type SalesInsightsReadiness = MicroVerticalReadiness;
export const salesInsightsMarkerSchema = Schema.Struct({
  ...MicroVerticalBuildMarkerSchema.fields,
  kind: Schema.Literal('microvertical-delivery-unit'),
  schemaVersion: Schema.Literal(1),
});
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
  .addHttpApi(OwnerActionApprovalApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(AssignMetricActionApi)
  .addHttpApi(ChangeMetricStateActionApi)
  .addHttpApi(RecordsApi)
  .addHttpApi(UpdateMetricActionApi)
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
