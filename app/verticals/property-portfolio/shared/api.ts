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
export const propertyPortfolioMarkerSchema = Schema.Struct({ ...MicroVerticalBuildMarkerSchema.fields });
export const propertyPortfolioReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: propertyPortfolioMarkerSchema,
});
export type PropertyPortfolioReadiness = typeof propertyPortfolioReadinessSchema.Type;
export const propertyPortfolioFoundationApi = HttpApi.make('PropertyPortfolioApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/property-portfolio/readiness', { success: propertyPortfolioReadinessSchema }),
  ),
);
export const propertyPortfolioApi = HttpApi.make('PropertyPortfolioApi')
  .addHttpApi(propertyPortfolioFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(RecordsApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);
export const propertyPortfolioOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'PropertyPortfolioApi:propertyPortfolio:readiness',
    routePath: '/property-portfolio/readiness',
  }),
} satisfies Record<string, OperationContext>;
export const propertyPortfolioApiContract = {
  apiPrefix: '/property-portfolio-api',
  basePath: '/property-portfolio-api/property-portfolio',
  ownerId: 'property-portfolio',
  readinessPath: '/property-portfolio-api/property-portfolio/readiness',
} as const;
