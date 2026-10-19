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

export type SiamparkOpsReadiness = MicroVerticalReadiness;
export const siamparkOpsMarkerSchema = Schema.Struct({ ...MicroVerticalBuildMarkerSchema.fields });
export const siamparkOpsReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: siamparkOpsMarkerSchema,
});

export type OperationContext = MicroVerticalOperationContext;

export const siamparkOpsFoundationApi = HttpApi.make('SiamparkOpsApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/siampark-ops/readiness', { success: siamparkOpsReadinessSchema }),
  ),
);

export const siamparkOpsApi = HttpApi.make('SiamparkOpsApi')
  .addHttpApi(siamparkOpsFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(RecordsApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const siamparkOpsOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'SiamparkOpsApi:foundation:readiness',
    routePath: '/siampark-ops/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const siamparkOpsApiContract = {
  apiPrefix: '/siampark-ops-api',
  basePath: '/siampark-ops-api/siampark-ops',
  ownerId: 'siampark-ops',
  readinessPath: '/siampark-ops-api/siampark-ops/readiness',
} as const;
