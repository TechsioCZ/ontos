import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';
import { identity } from 'effect';

// <generated-governed-http-api-imports>
import { ActivateTemplateRevisionActionApi } from './apis/activate-template-revision-action.ts';
import { DeactivateTemplateRevisionActionApi } from './apis/deactivate-template-revision-action.ts';
import { InvalidateTemplateRevisionActionApi } from './apis/invalidate-template-revision-action.ts';
import { LanguagePolicyApi } from './apis/language-policy.ts';
import { MessageHistoryDetailApi } from './apis/message-history-detail.ts';
import { MessageHistoryListApi } from './apis/message-history-list.ts';
import { PrepareTemplateRevisionActionApi } from './apis/prepare-template-revision-action.ts';
import { PrivacyOwnerCoverageApi } from './apis/privacy-owner-coverage.ts';
import { PrivacyOwnerExecutionOutcomeApi } from './apis/privacy-owner-execution-outcome.ts';
import { RecordOwnerExecutionEvidenceActionApi } from './apis/record-owner-execution-evidence-action.ts';
import { SetLanguagePolicyActionApi } from './apis/set-language-policy-action.ts';
import { SubmitCommunicationRequestActionApi } from './apis/submit-communication-request-action.ts';
// </generated-governed-http-api-imports>

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
export const communicationsApi = HttpApi.make('CommunicationsApi')
  .addHttpApi(communicationsFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ActivateTemplateRevisionActionApi)
  .addHttpApi(DeactivateTemplateRevisionActionApi)
  .addHttpApi(InvalidateTemplateRevisionActionApi)
  .addHttpApi(LanguagePolicyApi)
  .addHttpApi(MessageHistoryDetailApi)
  .addHttpApi(MessageHistoryListApi)
  .addHttpApi(PrepareTemplateRevisionActionApi)
  .addHttpApi(PrivacyOwnerCoverageApi)
  .addHttpApi(PrivacyOwnerExecutionOutcomeApi)
  .addHttpApi(RecordOwnerExecutionEvidenceActionApi)
  .addHttpApi(SetLanguagePolicyActionApi)
  .addHttpApi(SubmitCommunicationRequestActionApi)
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
