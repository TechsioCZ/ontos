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

import { RecordsApi } from './apis/records.ts';
import { ApplyCommandActionApi } from './apis/apply-command-action.ts';
// </generated-governed-http-api-imports>

export type SiamparkOccupancyMarker = MicroVerticalBuildMarker;
export type SiamparkOccupancyReadiness = MicroVerticalReadiness;
export type OperationContext = MicroVerticalOperationContext;
export const siamparkOccupancyMarkerSchema = Schema.Struct({ ...MicroVerticalBuildMarkerSchema.fields });
export const siamparkOccupancyReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: siamparkOccupancyMarkerSchema,
});
export const siamparkOccupancyFoundationApi = HttpApi.make('SiamparkOccupancyApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/siampark-occupancy/readiness', { success: siamparkOccupancyReadinessSchema }),
  ),
);

export const siamparkOccupancyApi = HttpApi.make('SiamparkOccupancyApi')
  .addHttpApi(siamparkOccupancyFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(RecordsApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);
export const siamparkOccupancyOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'SiamparkOccupancyApi:foundation:readiness',
    routePath: '/siampark-occupancy/readiness',
  }),
} satisfies Record<string, OperationContext>;
export const siamparkOccupancyApiContract = {
  apiPrefix: '/siampark-occupancy-api',
  basePath: '/siampark-occupancy-api/siampark-occupancy',
  ownerId: 'siampark-occupancy',
  readinessPath: '/siampark-occupancy-api/siampark-occupancy/readiness',
} as const;
