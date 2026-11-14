import { OwnerActionApprovalApi } from '@app/core-runtime/access/approvals/owner-api';
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
import { EmployeesSearchApi } from './apis/employees-search.ts';
import { RecordsApi } from './apis/records.ts';
import { RequestSearchRebuildActionApi } from './apis/request-search-rebuild-action.ts';
import { UpdateEmployeeActionApi } from './apis/update-employee-action.ts';
// </generated-governed-http-api-imports>

export type WorkforceReadiness = MicroVerticalReadiness;
export const workforceMarkerSchema = Schema.Struct({
  ...MicroVerticalBuildMarkerSchema.fields,
  kind: Schema.Literal('microvertical-delivery-unit'),
  schemaVersion: Schema.Literal(1),
});
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
  .addHttpApi(OwnerActionApprovalApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(EmployeesSearchApi)
  .addHttpApi(RecordsApi)
  .addHttpApi(RequestSearchRebuildActionApi)
  .addHttpApi(UpdateEmployeeActionApi)
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
