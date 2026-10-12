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

export type SiamparkRelationshipsReadiness = MicroVerticalReadiness;
export const siamparkRelationshipsMarkerSchema = Schema.Struct({ ...MicroVerticalBuildMarkerSchema.fields });
export const siamparkRelationshipsReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: siamparkRelationshipsMarkerSchema,
});

export type OperationContext = MicroVerticalOperationContext;

export const siamparkRelationshipsFoundationApi = HttpApi.make('SiamparkRelationshipsApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/siampark-relationships/readiness', {
      success: siamparkRelationshipsReadinessSchema,
    }),
  ),
);

export const siamparkRelationshipsApi = HttpApi.make('SiamparkRelationshipsApi')
  .addHttpApi(siamparkRelationshipsFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(RecordsApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const siamparkRelationshipsOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'SiamparkRelationshipsApi:foundation:readiness',
    routePath: '/siampark-relationships/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const siamparkRelationshipsApiContract = {
  apiPrefix: '/siampark-relationships-api',
  basePath: '/siampark-relationships-api/siampark-relationships',
  ownerId: 'siampark-relationships',
  readinessPath: '/siampark-relationships-api/siampark-relationships/readiness',
} as const;
