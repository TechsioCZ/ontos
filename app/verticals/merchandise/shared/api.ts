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

export type MerchandiseReadiness = MicroVerticalReadiness;
export const merchandiseMarkerSchema = Schema.Struct({ ...MicroVerticalBuildMarkerSchema.fields });
export const merchandiseReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: merchandiseMarkerSchema,
});

export type OperationContext = MicroVerticalOperationContext;

export const merchandiseFoundationApi = HttpApi.make('MerchandiseApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/merchandise/readiness', { success: merchandiseReadinessSchema }),
  ),
);

export const merchandiseApi = HttpApi.make('MerchandiseApi')
  .addHttpApi(merchandiseFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(AgentReviewApi)
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(RecordsApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const merchandiseOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'MerchandiseApi:foundation:readiness',
    routePath: '/merchandise/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const merchandiseApiContract = {
  apiPrefix: '/merchandise-api',
  basePath: '/merchandise-api/merchandise',
  ownerId: 'merchandise',
  readinessPath: '/merchandise-api/merchandise/readiness',
} as const;
