import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';
import { identity } from 'effect';

// <generated-governed-http-api-imports>
import { AdmitSymmyJobActionApi } from './apis/admit-symmy-job-action.ts';
import { AdmitSymmySyncActionApi } from './apis/admit-symmy-sync-action.ts';
import { ExecuteSymmyRetentionActionApi } from './apis/execute-symmy-retention-action.ts';
import { SymmyJobPrivacyExecutionApi } from './apis/symmy-job-privacy-execution.ts';
import { SymmyJobStatusApi } from './apis/symmy-job-status.ts';
import { SymmyRouteContextApi } from './apis/symmy-route-context.ts';
import { SymmySourceOrganizationFactsApi } from './apis/symmy-source-organization-facts.ts';
import { SymmySyncAdmissionApi } from './apis/symmy-sync-admission.ts';
// </generated-governed-http-api-imports>

export const symmyIntegrationMarkerSchema = Schema.Struct({
  ...MicroVerticalBuildMarkerSchema.fields,
  kind: Schema.Literal('microvertical-delivery-unit'),
  schemaVersion: Schema.Literal(1),
});

export const symmyIntegrationReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: symmyIntegrationMarkerSchema,
});

export type OperationContext = MicroVerticalOperationContext;

export const symmyIntegrationFoundationApi = HttpApi.make('SymmyIntegrationApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/symmy-integration/readiness', { success: symmyIntegrationReadinessSchema }),
  ),
);

export const symmyIntegrationApi = HttpApi.make('SymmyIntegrationApi')
  .addHttpApi(symmyIntegrationFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(AdmitSymmyJobActionApi)
  .addHttpApi(AdmitSymmySyncActionApi)
  .addHttpApi(ExecuteSymmyRetentionActionApi)
  .addHttpApi(SymmyJobPrivacyExecutionApi)
  .addHttpApi(SymmyJobStatusApi)
  .addHttpApi(SymmyRouteContextApi)
  .addHttpApi(SymmySourceOrganizationFactsApi)
  .addHttpApi(SymmySyncAdmissionApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const symmyIntegrationOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'SymmyIntegrationApi:symmyIntegration:readiness',
    routePath: '/symmy-integration/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const symmyIntegrationApiContract = {
  apiPrefix: '/symmy-integration-api',
  basePath: '/symmy-integration-api/symmy-integration',
  ownerId: 'symmy-integration',
  readinessPath: '/symmy-integration-api/symmy-integration/readiness',
} as const;
