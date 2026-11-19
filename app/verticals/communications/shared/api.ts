import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';
import { identity } from 'effect';

export type OperationContext = MicroVerticalOperationContext;

export const communicationsMarkerSchema = Schema.Struct({
  ...MicroVerticalBuildMarkerSchema.fields,
  kind: Schema.Literal('microvertical-delivery-unit'),
  schemaVersion: Schema.Literal(1),
});
export type CommunicationsMarker = typeof communicationsMarkerSchema.Type;

export const communicationsReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: communicationsMarkerSchema,
});
export type CommunicationsReadiness = typeof communicationsReadinessSchema.Type;

export const communicationsFoundationApi = HttpApi.make('CommunicationsApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/communications/readiness', { success: communicationsReadinessSchema }),
  ),
);
// <generated-governed-http-api-imports>
// </generated-governed-http-api-imports>

export const communicationsApi = HttpApi.make('CommunicationsApi')
  .addHttpApi(communicationsFoundationApi)
  // <generated-governed-http-api-additions>
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const communicationsOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'CommunicationsApi:communications:readiness',
    routePath: '/communications/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const communicationsApiContract = {
  apiPrefix: '/communications-api',
  basePath: '/communications-api/communications',
  ownerId: 'communications',
  readinessPath: '/communications-api/communications/readiness',
} as const;
