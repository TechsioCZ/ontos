import { identity } from 'effect';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';

// <generated-governed-http-api-imports>
import { ApplicableTaxRuleSetApi } from './apis/applicable-tax-rule-set.ts';
import { CorrectTaxRuleRevisionActionApi } from './apis/correct-tax-rule-revision-action.ts';
import { CreateTaxRuleActionApi } from './apis/create-tax-rule-action.ts';
import { CreateTaxRuleRevisionActionApi } from './apis/create-tax-rule-revision-action.ts';
import { EndTaxFactAuthorityContractActionApi } from './apis/end-tax-fact-authority-contract-action.ts';
import { EndTaxRuleRevisionActionApi } from './apis/end-tax-rule-revision-action.ts';
import { EstablishTaxFactAuthorityContractActionApi } from './apis/establish-tax-fact-authority-contract-action.ts';
import { RecordTaxSourceAssertionActionApi } from './apis/record-tax-source-assertion-action.ts';
import { ReviseTaxFactAuthorityContractActionApi } from './apis/revise-tax-fact-authority-contract-action.ts';
import { SellingLegalEntityVatRegistrationStateApi } from './apis/selling-legal-entity-vat-registration-state.ts';
import { TaxFactAuthorityCurrentApi } from './apis/tax-fact-authority-current.ts';
import { TaxPrivacyOwnerCoverageApi } from './apis/tax-privacy-owner-coverage.ts';
import { TaxRuleHistoryApi } from './apis/tax-rule-history.ts';
import { TaxSourceAssertionHistoryApi } from './apis/tax-source-assertion-history.ts';
import { TaxSourceConflictDetailApi } from './apis/tax-source-conflict-detail.ts';
// </generated-governed-http-api-imports>

export const taxMarkerSchema = Schema.Struct({
  ...MicroVerticalBuildMarkerSchema.fields,
  kind: Schema.Literal('microvertical-delivery-unit'),
  schemaVersion: Schema.Literal(1),
});
export type TaxMarker = typeof taxMarkerSchema.Type;

export const taxReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: taxMarkerSchema,
});
export type TaxReadiness = typeof taxReadinessSchema.Type;

export type OperationContext = MicroVerticalOperationContext;

export const taxFoundationApi = HttpApi.make('TaxApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/tax/readiness', {
      success: taxReadinessSchema,
    }),
  ),
);

export const taxApi = HttpApi.make('TaxApi')
  .addHttpApi(taxFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ApplicableTaxRuleSetApi)
  .addHttpApi(CorrectTaxRuleRevisionActionApi)
  .addHttpApi(CreateTaxRuleActionApi)
  .addHttpApi(CreateTaxRuleRevisionActionApi)
  .addHttpApi(EndTaxFactAuthorityContractActionApi)
  .addHttpApi(EndTaxRuleRevisionActionApi)
  .addHttpApi(EstablishTaxFactAuthorityContractActionApi)
  .addHttpApi(RecordTaxSourceAssertionActionApi)
  .addHttpApi(ReviseTaxFactAuthorityContractActionApi)
  .addHttpApi(SellingLegalEntityVatRegistrationStateApi)
  .addHttpApi(TaxFactAuthorityCurrentApi)
  .addHttpApi(TaxPrivacyOwnerCoverageApi)
  .addHttpApi(TaxRuleHistoryApi)
  .addHttpApi(TaxSourceAssertionHistoryApi)
  .addHttpApi(TaxSourceConflictDetailApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const taxOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'TaxApi:tax:readiness',
    routePath: '/tax/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const taxApiContract = {
  apiPrefix: '/tax-api',
  basePath: '/tax-api/tax',
  ownerId: 'tax',
  readinessPath: '/tax-api/tax/readiness',
} as const;
