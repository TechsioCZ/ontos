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

export type FacilityOperationsReadiness = MicroVerticalReadiness;
export const facilityOperationsMarkerSchema = Schema.Struct({ ...MicroVerticalBuildMarkerSchema.fields });
export const facilityOperationsReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: facilityOperationsMarkerSchema,
});

export type OperationContext = MicroVerticalOperationContext;

export const facilityOperationsFoundationApi = HttpApi.make('FacilityOperationsApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/facility-operations/readiness', { success: facilityOperationsReadinessSchema }),
  ),
);

export const facilityOperationsApi = HttpApi.make('FacilityOperationsApi')
  .addHttpApi(facilityOperationsFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(RecordsApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const facilityOperationsOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'FacilityOperationsApi:foundation:readiness',
    routePath: '/facility-operations/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const facilityOperationsApiContract = {
  apiPrefix: '/facility-operations-api',
  basePath: '/facility-operations-api/facility-operations',
  ownerId: 'facility-operations',
  readinessPath: '/facility-operations-api/facility-operations/readiness',
} as const;
