import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalReadiness, MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';
import { identity } from 'effect';

// <generated-governed-http-api-imports>
import { AgentReviewApi } from './apis/agent-review.ts';
import { ApplyCommandActionApi } from './apis/apply-command-action.ts';
import { RecordsApi } from './apis/records.ts';
// </generated-governed-http-api-imports>

export type WorkTasksReadiness = MicroVerticalReadiness;
export const workTasksMarkerSchema = Schema.Struct({ ...MicroVerticalBuildMarkerSchema.fields });
export const workTasksReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: workTasksMarkerSchema,
});

export type OperationContext = MicroVerticalOperationContext;

export const workTasksFoundationApi = HttpApi.make('WorkTasksApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/work-tasks/readiness', { success: workTasksReadinessSchema }),
  ),
);

export const workTasksApi = HttpApi.make('WorkTasksApi')
  .addHttpApi(workTasksFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(AgentReviewApi)
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(RecordsApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const workTasksOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'WorkTasksApi:foundation:readiness',
    routePath: '/work-tasks/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const workTasksApiContract = {
  apiPrefix: '/work-tasks-api',
  basePath: '/work-tasks-api/work-tasks',
  ownerId: 'work-tasks',
  readinessPath: '/work-tasks-api/work-tasks/readiness',
} as const;
