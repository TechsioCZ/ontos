import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';
import { identity } from 'effect';

// <generated-governed-http-api-imports>
import { ApplyCommandActionApi } from './apis/apply-command-action.ts';
import { RecordsApi } from './apis/records.ts';
// </generated-governed-http-api-imports>

export type OperationContext = MicroVerticalOperationContext;
export const siamparkPropertyMarkerSchema = Schema.Struct({ ...MicroVerticalBuildMarkerSchema.fields });
export const siamparkPropertyReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: siamparkPropertyMarkerSchema,
});
export type SiamparkPropertyReadiness = typeof siamparkPropertyReadinessSchema.Type;
export const siamparkPropertyFoundationApi = HttpApi.make('SiamparkPropertyApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/siampark-property/readiness', { success: siamparkPropertyReadinessSchema }),
  ),
);
export const siamparkPropertyApi = HttpApi.make('SiamparkPropertyApi')
  .addHttpApi(siamparkPropertyFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(RecordsApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);
export const siamparkPropertyOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'SiamparkPropertyApi:siamparkProperty:readiness',
    routePath: '/siampark-property/readiness',
  }),
} satisfies Record<string, OperationContext>;
export const siamparkPropertyApiContract = {
  apiPrefix: '/siampark-property-api',
  basePath: '/siampark-property-api/siampark-property',
  ownerId: 'siampark-property',
  readinessPath: '/siampark-property-api/siampark-property/readiness',
} as const;
