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

export type CrmReadiness = MicroVerticalReadiness;
export const crmMarkerSchema = Schema.Struct({ ...MicroVerticalBuildMarkerSchema.fields });
export const crmReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: crmMarkerSchema,
});

export type OperationContext = MicroVerticalOperationContext;

export const crmFoundationApi = HttpApi.make('CrmApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/crm/readiness', { success: crmReadinessSchema }),
  ),
);

export const crmApi = HttpApi.make('CrmApi')
  .addHttpApi(crmFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(RecordsApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const crmOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'CrmApi:foundation:readiness',
    routePath: '/crm/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const crmApiContract = {
  apiPrefix: '/crm-api',
  basePath: '/crm-api/crm',
  ownerId: 'crm',
  readinessPath: '/crm-api/crm/readiness',
} as const;
