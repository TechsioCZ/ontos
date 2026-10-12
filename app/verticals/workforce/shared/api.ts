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

export type WorkforceReadiness = MicroVerticalReadiness;
export const workforceMarkerSchema = Schema.Struct({ ...MicroVerticalBuildMarkerSchema.fields });
export const workforceReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: workforceMarkerSchema,
});

export type OperationContext = MicroVerticalOperationContext;

export const workforceFoundationApi = HttpApi.make('WorkforceApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/workforce/readiness', { success: workforceReadinessSchema }),
  ),
);

export const workforceApi = HttpApi.make('WorkforceApi')
  .addHttpApi(workforceFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(RecordsApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const workforceOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'WorkforceApi:foundation:readiness',
    routePath: '/workforce/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const workforceApiContract = {
  apiPrefix: '/workforce-api',
  basePath: '/workforce-api/workforce',
  ownerId: 'workforce',
  readinessPath: '/workforce-api/workforce/readiness',
} as const;
