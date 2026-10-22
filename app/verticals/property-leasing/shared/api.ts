import { identity } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type {
  MicroVerticalBuildMarker,
  MicroVerticalReadiness,
  MicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';

// <generated-governed-http-api-imports>
import { AgentReviewApi } from './apis/agent-review.ts';
import { ApplyCommandActionApi } from './apis/apply-command-action.ts';
import { RecordsApi } from './apis/records.ts';
// </generated-governed-http-api-imports>

export type PropertyLeasingMarker = MicroVerticalBuildMarker;
export type PropertyLeasingReadiness = MicroVerticalReadiness;
export type OperationContext = MicroVerticalOperationContext;
export const propertyLeasingMarkerSchema = Schema.Struct({ ...MicroVerticalBuildMarkerSchema.fields });
export const propertyLeasingReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: propertyLeasingMarkerSchema,
});
export const propertyLeasingFoundationApi = HttpApi.make('PropertyLeasingApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/property-leasing/readiness', { success: propertyLeasingReadinessSchema }),
  ),
);

export const propertyLeasingApi = HttpApi.make('PropertyLeasingApi')
  .addHttpApi(propertyLeasingFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(AgentReviewApi)
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(RecordsApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);
export const propertyLeasingOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'PropertyLeasingApi:foundation:readiness',
    routePath: '/property-leasing/readiness',
  }),
} satisfies Record<string, OperationContext>;
export const propertyLeasingApiContract = {
  apiPrefix: '/property-leasing-api',
  basePath: '/property-leasing-api/property-leasing',
  ownerId: 'property-leasing',
  readinessPath: '/property-leasing-api/property-leasing/readiness',
} as const;
