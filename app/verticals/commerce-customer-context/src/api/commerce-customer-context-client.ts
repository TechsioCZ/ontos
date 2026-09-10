import { Effect, makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import type {
  HttpClientError,
  HttpApi,
  HttpApiClient,
  HttpApiGroup,
  Schema,
} from '@modern-js/plugin-bff/effect-client';

import {
  commerceCustomerContextApiContract,
  commerceCustomerContextApi,
  commerceCustomerContextOperationContexts,
} from '../../shared/api.ts';
import type { OperationContext, CommerceCustomerContextReadiness } from '../../shared/api.ts';

export { Effect, runEffectRequest } from '@modern-js/plugin-bff/effect-client';
// <generated-action-http-client-exports>
export * from './add-saved-address-action-client.ts';
export * from './archive-customer-group-action-client.ts';
export * from './archive-customer-profile-action-client.ts';
export * from './assign-counterparty-price-group-action-client.ts';
export * from './assign-customer-group-action-client.ts';
export * from './assign-customer-price-group-action-client.ts';
export * from './attribute-guest-retail-customer-action-client.ts';
export * from './bind-retail-portal-profile-action-client.ts';
export * from './bootstrap-counterparty-access-administrator-action-client.ts';
export * from './change-counterparty-purchase-limit-action-client.ts';
export * from './change-customer-payment-terms-action-client.ts';
export * from './change-principal-purchase-limit-override-action-client.ts';
export * from './change-retail-payment-term-preference-action-client.ts';
export * from './claim-counterparty-access-invitation-action-client.ts';
export * from './clear-default-billing-address-action-client.ts';
export * from './clear-default-delivery-destination-action-client.ts';
export * from './consume-purchase-approval-action-client.ts';
export * from './create-approval-hierarchy-action-client.ts';
export * from './create-counterparty-access-invitation-action-client.ts';
export * from './create-counterparty-purchasing-profile-action-client.ts';
export * from './create-customer-group-action-client.ts';
export * from './create-purchase-proposal-revision-action-client.ts';
export * from './decide-purchase-approval-request-action-client.ts';
export * from './ensure-retail-customer-profile-action-client.ts';
export * from './grant-counterparty-commerce-access-action-client.ts';
export * from './migrate-counterparty-price-group-action-client.ts';
export * from './migrate-customer-price-group-action-client.ts';
export * from './open-profile-reconciliation-action-client.ts';
export * from './reactivate-customer-group-action-client.ts';
export * from './reactivate-customer-profile-action-client.ts';
export * from './recover-retail-portal-profile-binding-action-client.ts';
export * from './remove-counterparty-price-group-action-client.ts';
export * from './remove-customer-group-action-client.ts';
export * from './remove-customer-payment-term-action-client.ts';
export * from './remove-customer-price-group-action-client.ts';
export * from './remove-saved-address-action-client.ts';
export * from './repeat-counterparty-order-action-client.ts';
export * from './repeat-retail-order-action-client.ts';
export * from './reroute-purchase-approval-request-action-client.ts';
export * from './resend-counterparty-access-invitation-action-client.ts';
export * from './reserve-payment-term-retirement-action-client.ts';
export * from './resolve-profile-reconciliation-action-client.ts';
export * from './revalidate-purchase-approval-action-client.ts';
export * from './revoke-counterparty-access-invitation-action-client.ts';
export * from './revoke-counterparty-commerce-access-action-client.ts';
export * from './revoke-retail-portal-profile-binding-action-client.ts';
export * from './set-default-billing-address-action-client.ts';
export * from './set-default-delivery-destination-action-client.ts';
export * from './submit-purchase-approval-request-action-client.ts';
export * from './suspend-customer-profile-action-client.ts';
export * from './trigger-purchase-approval-action-client.ts';
export * from './update-customer-group-action-client.ts';
export * from './update-saved-address-action-client.ts';
// </generated-action-http-client-exports>
export * from './payment-term-affected-use-assessment-client.ts';
export {
  PaymentTermAffectedUseAssessmentRequestSchema,
  PaymentTermAffectedUseAssessmentResponseSchema,
} from '../../shared/api.ts';
export type {
  PaymentTermAffectedUseAssessmentRequest,
  PaymentTermAffectedUseAssessmentResponse,
} from '../../shared/api.ts';

type CommerceCustomerContextApiGroups =
  typeof commerceCustomerContextApi extends HttpApi.HttpApi<infer _ApiId, infer Groups>
    ? Groups
    : never;

export type CommerceCustomerContextClient = HttpApiClient.Client<
  Extract<CommerceCustomerContextApiGroups, HttpApiGroup.Constraint>,
  never,
  never
>;

export type CommerceCustomerContextClientError =
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

export type CommerceCustomerContextClientEffect<Success> = Effect.Effect<
  Success,
  CommerceCustomerContextClientError,
  never
>;

export interface CommerceCustomerContextClientOptions {
  baseUrl?: string | URL;
  locale?: string;
  operationContext?: OperationContext;
  traceparent?: string;
}

export const createCommerceCustomerContextClient = (
  options: CommerceCustomerContextClientOptions = {},
): CommerceCustomerContextClientEffect<CommerceCustomerContextClient> =>
  makeEffectHttpApiClient(commerceCustomerContextApi, {
    baseUrl: options.baseUrl ?? commerceCustomerContextApiContract.apiPrefix,
    requestContext: {
      ...(options.locale === undefined ? {} : { locale: options.locale }),
      ...(options.operationContext === undefined
        ? {}
        : { operationContext: options.operationContext }),
      ...(options.traceparent === undefined ? {} : { traceparent: options.traceparent }),
    },
  });

export const getCommerceCustomerContextReadiness = (
  options: CommerceCustomerContextClientOptions = {},
): CommerceCustomerContextClientEffect<CommerceCustomerContextReadiness> =>
  createCommerceCustomerContextClient({
    ...options,
    operationContext:
      options.operationContext ?? commerceCustomerContextOperationContexts.readiness,
  }).pipe(Effect.flatMap((client) => client.foundation.readiness({})));
