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

export type TaggingReadiness = MicroVerticalReadiness;
export const taggingMarkerSchema = Schema.Struct({ ...MicroVerticalBuildMarkerSchema.fields });
export const taggingReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: taggingMarkerSchema,
});

export type OperationContext = MicroVerticalOperationContext;

export const taggingFoundationApi = HttpApi.make('TaggingApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/tagging/readiness', { success: taggingReadinessSchema }),
  ),
);

export const taggingApi = HttpApi.make('TaggingApi')
  .addHttpApi(taggingFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(RecordsApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const taggingOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'TaggingApi:foundation:readiness',
    routePath: '/tagging/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const taggingApiContract = {
  apiPrefix: '/tagging-api',
  basePath: '/tagging-api/tagging',
  ownerId: 'tagging',
  readinessPath: '/tagging-api/tagging/readiness',
} as const;
