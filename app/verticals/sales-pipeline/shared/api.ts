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

export type SalesPipelineReadiness = MicroVerticalReadiness;
export const salesPipelineMarkerSchema = Schema.Struct({ ...MicroVerticalBuildMarkerSchema.fields });
export const salesPipelineReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: salesPipelineMarkerSchema,
});

export type OperationContext = MicroVerticalOperationContext;

export const salesPipelineFoundationApi = HttpApi.make('SalesPipelineApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/sales-pipeline/readiness', { success: salesPipelineReadinessSchema }),
  ),
);

export const salesPipelineApi = HttpApi.make('SalesPipelineApi')
  .addHttpApi(salesPipelineFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(RecordsApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const salesPipelineOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'SalesPipelineApi:foundation:readiness',
    routePath: '/sales-pipeline/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const salesPipelineApiContract = {
  apiPrefix: '/sales-pipeline-api',
  basePath: '/sales-pipeline-api/sales-pipeline',
  ownerId: 'sales-pipeline',
  readinessPath: '/sales-pipeline-api/sales-pipeline/readiness',
} as const;
