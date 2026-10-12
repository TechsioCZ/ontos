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

export type SiamparkAgreementsMarker = MicroVerticalBuildMarker;
export type SiamparkAgreementsReadiness = MicroVerticalReadiness;
export type OperationContext = MicroVerticalOperationContext;
export const siamparkAgreementsMarkerSchema = Schema.Struct({ ...MicroVerticalBuildMarkerSchema.fields });
export const siamparkAgreementsReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: siamparkAgreementsMarkerSchema,
});
export const siamparkAgreementsFoundationApi = HttpApi.make('SiamparkAgreementsApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/siampark-agreements/readiness', { success: siamparkAgreementsReadinessSchema }),
  ),
);

export const siamparkAgreementsApi = HttpApi.make('SiamparkAgreementsApi')
  .addHttpApi(siamparkAgreementsFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(RecordsApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);
export const siamparkAgreementsOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'SiamparkAgreementsApi:foundation:readiness',
    routePath: '/siampark-agreements/readiness',
  }),
} satisfies Record<string, OperationContext>;
export const siamparkAgreementsApiContract = {
  apiPrefix: '/siampark-agreements-api',
  basePath: '/siampark-agreements-api/siampark-agreements',
  ownerId: 'siampark-agreements',
  readinessPath: '/siampark-agreements-api/siampark-agreements/readiness',
} as const;
