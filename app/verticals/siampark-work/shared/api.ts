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

export type SiamparkWorkReadiness = MicroVerticalReadiness;
export const siamparkWorkMarkerSchema = Schema.Struct({ ...MicroVerticalBuildMarkerSchema.fields });
export const siamparkWorkReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: siamparkWorkMarkerSchema,
});

export type OperationContext = MicroVerticalOperationContext;

export const siamparkWorkFoundationApi = HttpApi.make('SiamparkWorkApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/siampark-work/readiness', { success: siamparkWorkReadinessSchema }),
  ),
);

export const siamparkWorkApi = HttpApi.make('SiamparkWorkApi')
  .addHttpApi(siamparkWorkFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(RecordsApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const siamparkWorkOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'SiamparkWorkApi:foundation:readiness',
    routePath: '/siampark-work/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const siamparkWorkApiContract = {
  apiPrefix: '/siampark-work-api',
  basePath: '/siampark-work-api/siampark-work',
  ownerId: 'siampark-work',
  readinessPath: '/siampark-work-api/siampark-work/readiness',
} as const;
