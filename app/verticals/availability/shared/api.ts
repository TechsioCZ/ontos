// <generated-governed-http-api-imports>
import { CurrentAvailabilityApi } from './apis/current-availability.ts';
// </generated-governed-http-api-imports>

import { identity } from 'effect';

import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';

export const availabilityMarkerSchema = MicroVerticalBuildMarkerSchema;
export type AvailabilityMarker = typeof availabilityMarkerSchema.Type;

export type AvailabilityReadiness = typeof availabilityReadinessSchema.Type;
export const availabilityReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: availabilityMarkerSchema,
});

export type OperationContext = MicroVerticalOperationContext;

export const availabilityFoundationApi = HttpApi.make('AvailabilityApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/availability/readiness', { success: availabilityReadinessSchema }),
  ),
);
export const availabilityApi = HttpApi.make('AvailabilityApi')
  .addHttpApi(availabilityFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(CurrentAvailabilityApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const availabilityOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'AvailabilityApi:availability:readiness',
    routePath: '/availability/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const availabilityApiContract = {
  apiPrefix: '/availability-api',
  basePath: '/availability-api/availability',
  ownerId: 'availability',
  readinessPath: '/availability-api/availability/readiness',
} as const;
