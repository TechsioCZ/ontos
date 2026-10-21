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

export type LegalAgreementsMarker = MicroVerticalBuildMarker;
export type LegalAgreementsReadiness = MicroVerticalReadiness;
export type OperationContext = MicroVerticalOperationContext;
export const legalAgreementsMarkerSchema = Schema.Struct({ ...MicroVerticalBuildMarkerSchema.fields });
export const legalAgreementsReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: legalAgreementsMarkerSchema,
});
export const legalAgreementsFoundationApi = HttpApi.make('LegalAgreementsApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/legal-agreements/readiness', { success: legalAgreementsReadinessSchema }),
  ),
);

export const legalAgreementsApi = HttpApi.make('LegalAgreementsApi')
  .addHttpApi(legalAgreementsFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(RecordsApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);
export const legalAgreementsOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'LegalAgreementsApi:foundation:readiness',
    routePath: '/legal-agreements/readiness',
  }),
} satisfies Record<string, OperationContext>;
export const legalAgreementsApiContract = {
  apiPrefix: '/legal-agreements-api',
  basePath: '/legal-agreements-api/legal-agreements',
  ownerId: 'legal-agreements',
  readinessPath: '/legal-agreements-api/legal-agreements/readiness',
} as const;
