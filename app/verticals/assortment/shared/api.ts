import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import { identity } from 'effect';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';

// <generated-governed-http-api-imports>
import { ConfigurationApi } from './apis/configuration.ts';
import { CreateApplicabilityBindingActionApi } from './apis/create-applicability-binding-action.ts';
import { CreateClosedAssortmentBoundaryActionApi } from './apis/create-closed-assortment-boundary-action.ts';
import { CreateRuleActionApi } from './apis/create-rule-action.ts';
import { CreateRuleRevisionActionApi } from './apis/create-rule-revision-action.ts';
import { DecisionExplanationApi } from './apis/decision-explanation.ts';
import { EndApplicabilityBindingActionApi } from './apis/end-applicability-binding-action.ts';
import { EndClosedAssortmentBoundaryActionApi } from './apis/end-closed-assortment-boundary-action.ts';
import { IssueAssortmentCommitmentConfirmationActionApi } from './apis/issue-assortment-commitment-confirmation-action.ts';
import { PurchaseApi } from './apis/purchase.ts';
import { ReplaceApplicabilityBindingActionApi } from './apis/replace-applicability-binding-action.ts';
import { ReplaceClosedAssortmentBoundaryActionApi } from './apis/replace-closed-assortment-boundary-action.ts';
import { RetireRuleActionApi } from './apis/retire-rule-action.ts';
import { VisibilityApi } from './apis/visibility.ts';
// </generated-governed-http-api-imports>

export const assortmentMarkerSchema = Schema.Struct({
  ...MicroVerticalBuildMarkerSchema.fields,
  kind: Schema.Literal('microvertical-delivery-unit'),
  schemaVersion: Schema.Literal(1),
});

export type AssortmentMarker = typeof assortmentMarkerSchema.Type;

export const assortmentReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: assortmentMarkerSchema,
});

export type AssortmentReadiness = typeof assortmentReadinessSchema.Type;

export type OperationContext = MicroVerticalOperationContext;

export const assortmentFoundationApi = HttpApi.make('AssortmentApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/assortment/readiness', { success: assortmentReadinessSchema }),
  ),
);

export const assortmentApi = HttpApi.make('AssortmentApi')
  .addHttpApi(assortmentFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ConfigurationApi)
  .addHttpApi(CreateApplicabilityBindingActionApi)
  .addHttpApi(CreateClosedAssortmentBoundaryActionApi)
  .addHttpApi(CreateRuleActionApi)
  .addHttpApi(CreateRuleRevisionActionApi)
  .addHttpApi(DecisionExplanationApi)
  .addHttpApi(EndApplicabilityBindingActionApi)
  .addHttpApi(EndClosedAssortmentBoundaryActionApi)
  .addHttpApi(IssueAssortmentCommitmentConfirmationActionApi)
  .addHttpApi(PurchaseApi)
  .addHttpApi(ReplaceApplicabilityBindingActionApi)
  .addHttpApi(ReplaceClosedAssortmentBoundaryActionApi)
  .addHttpApi(RetireRuleActionApi)
  .addHttpApi(VisibilityApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const assortmentOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'AssortmentApi:assortment:readiness',
    routePath: '/assortment/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const assortmentApiContract = {
  apiPrefix: '/assortment-api',
  basePath: '/assortment-api/assortment',
  ownerId: 'assortment',
  readinessPath: '/assortment-api/assortment/readiness',
} as const;
