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

export type CrmActivitiesReadiness = MicroVerticalReadiness;
export const crmActivitiesMarkerSchema = Schema.Struct({ ...MicroVerticalBuildMarkerSchema.fields });
export const crmActivitiesReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: crmActivitiesMarkerSchema,
});

export type OperationContext = MicroVerticalOperationContext;

export const crmActivitiesFoundationApi = HttpApi.make('CrmActivitiesApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/crm-activities/readiness', {
      success: crmActivitiesReadinessSchema,
    }),
  ),
);

export const crmActivitiesApi = HttpApi.make('CrmActivitiesApi')
  .addHttpApi(crmActivitiesFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(RecordsApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const crmActivitiesOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'CrmActivitiesApi:foundation:readiness',
    routePath: '/crm-activities/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const crmActivitiesApiContract = {
  apiPrefix: '/crm-activities-api',
  basePath: '/crm-activities-api/crm-activities',
  ownerId: 'crm-activities',
  readinessPath: '/crm-activities-api/crm-activities/readiness',
} as const;
