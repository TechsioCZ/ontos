import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import type {
  HttpClientError,
  HttpApi,
  HttpApiClient,
  HttpApiGroup,
  Schema,
} from '@modern-js/bff-effect/effect-client';

import {
  commerceCustomerContextApiContract,
  commerceCustomerContextApi,
  commerceCustomerContextOperationContexts,
} from '../../shared/api.ts';
import type { OperationContext, CommerceCustomerContextReadiness } from '../../shared/api.ts';

export { Effect } from '@modern-js/bff-effect/effect-client';
// <generated-action-http-client-exports>
export { executeAddSavedAddressWithAuthorization, executeAddSavedAddress } from './add-saved-address-action-client.ts';
export type { AddSavedAddressActionClientOptions } from './add-saved-address-action-client.ts';
export {
  executeArchiveCustomerGroupWithAuthorization,
  executeArchiveCustomerGroup,
} from './archive-customer-group-action-client.ts';
export type { ArchiveCustomerGroupActionClientOptions } from './archive-customer-group-action-client.ts';
export {
  executeArchiveCustomerProfileWithAuthorization,
  executeArchiveCustomerProfile,
} from './archive-customer-profile-action-client.ts';
export type { ArchiveCustomerProfileActionClientOptions } from './archive-customer-profile-action-client.ts';
export {
  executeAssignCounterpartyPriceGroupWithAuthorization,
  executeAssignCounterpartyPriceGroup,
} from './assign-counterparty-price-group-action-client.ts';
export type { AssignCounterpartyPriceGroupActionClientOptions } from './assign-counterparty-price-group-action-client.ts';
export {
  executeAssignCustomerGroupWithAuthorization,
  executeAssignCustomerGroup,
} from './assign-customer-group-action-client.ts';
export type { AssignCustomerGroupActionClientOptions } from './assign-customer-group-action-client.ts';
export {
  executeAssignCustomerPriceGroupWithAuthorization,
  executeAssignCustomerPriceGroup,
} from './assign-customer-price-group-action-client.ts';
export type { AssignCustomerPriceGroupActionClientOptions } from './assign-customer-price-group-action-client.ts';
export {
  executeAttributeGuestRetailCustomerWithAuthorization,
  executeAttributeGuestRetailCustomer,
} from './attribute-guest-retail-customer-action-client.ts';
export type { AttributeGuestRetailCustomerActionClientOptions } from './attribute-guest-retail-customer-action-client.ts';
export {
  executeBindRetailPortalProfileWithAuthorization,
  executeBindRetailPortalProfile,
} from './bind-retail-portal-profile-action-client.ts';
export type { BindRetailPortalProfileActionClientOptions } from './bind-retail-portal-profile-action-client.ts';
export {
  executeBootstrapCounterpartyAccessAdministratorWithAuthorization,
  executeBootstrapCounterpartyAccessAdministrator,
} from './bootstrap-counterparty-access-administrator-action-client.ts';
export type { BootstrapCounterpartyAccessAdministratorActionClientOptions } from './bootstrap-counterparty-access-administrator-action-client.ts';
export {
  executeChangeCounterpartyPurchaseLimitWithAuthorization,
  executeChangeCounterpartyPurchaseLimit,
} from './change-counterparty-purchase-limit-action-client.ts';
export type { ChangeCounterpartyPurchaseLimitActionClientOptions } from './change-counterparty-purchase-limit-action-client.ts';
export {
  executeChangeCustomerPaymentTermsWithAuthorization,
  executeChangeCustomerPaymentTerms,
} from './change-customer-payment-terms-action-client.ts';
export type { ChangeCustomerPaymentTermsActionClientOptions } from './change-customer-payment-terms-action-client.ts';
export {
  executeChangePrincipalPurchaseLimitOverrideWithAuthorization,
  executeChangePrincipalPurchaseLimitOverride,
} from './change-principal-purchase-limit-override-action-client.ts';
export type { ChangePrincipalPurchaseLimitOverrideActionClientOptions } from './change-principal-purchase-limit-override-action-client.ts';
export {
  executeChangeRetailPaymentTermPreferenceWithAuthorization,
  executeChangeRetailPaymentTermPreference,
} from './change-retail-payment-term-preference-action-client.ts';
export type { ChangeRetailPaymentTermPreferenceActionClientOptions } from './change-retail-payment-term-preference-action-client.ts';
export {
  executeClaimCounterpartyAccessInvitationWithAuthorization,
  executeClaimCounterpartyAccessInvitation,
} from './claim-counterparty-access-invitation-action-client.ts';
export type { ClaimCounterpartyAccessInvitationActionClientOptions } from './claim-counterparty-access-invitation-action-client.ts';
export {
  executeClaimPortalEnrollmentTransitionWithAuthorization,
  executeClaimPortalEnrollmentTransition,
} from './claim-portal-enrollment-transition-action-client.ts';
export type { ClaimPortalEnrollmentTransitionActionClientOptions } from './claim-portal-enrollment-transition-action-client.ts';
export {
  executeClearDefaultBillingAddressWithAuthorization,
  executeClearDefaultBillingAddress,
} from './clear-default-billing-address-action-client.ts';
export type { ClearDefaultBillingAddressActionClientOptions } from './clear-default-billing-address-action-client.ts';
export {
  executeClearDefaultDeliveryDestinationWithAuthorization,
  executeClearDefaultDeliveryDestination,
} from './clear-default-delivery-destination-action-client.ts';
export type { ClearDefaultDeliveryDestinationActionClientOptions } from './clear-default-delivery-destination-action-client.ts';
export {
  executeConsumePurchaseApprovalWithAuthorization,
  executeConsumePurchaseApproval,
} from './consume-purchase-approval-action-client.ts';
export type { ConsumePurchaseApprovalActionClientOptions } from './consume-purchase-approval-action-client.ts';
export {
  executeCreateApprovalHierarchyWithAuthorization,
  executeCreateApprovalHierarchy,
} from './create-approval-hierarchy-action-client.ts';
export type { CreateApprovalHierarchyActionClientOptions } from './create-approval-hierarchy-action-client.ts';
export {
  executeCreateCounterpartyAccessInvitationWithAuthorization,
  executeCreateCounterpartyAccessInvitation,
} from './create-counterparty-access-invitation-action-client.ts';
export type { CreateCounterpartyAccessInvitationActionClientOptions } from './create-counterparty-access-invitation-action-client.ts';
export {
  executeCreateCounterpartyPurchasingProfileWithAuthorization,
  executeCreateCounterpartyPurchasingProfile,
} from './create-counterparty-purchasing-profile-action-client.ts';
export type { CreateCounterpartyPurchasingProfileActionClientOptions } from './create-counterparty-purchasing-profile-action-client.ts';
export {
  executeCreateCustomerGroupWithAuthorization,
  executeCreateCustomerGroup,
} from './create-customer-group-action-client.ts';
export type { CreateCustomerGroupActionClientOptions } from './create-customer-group-action-client.ts';
export {
  executeCreatePurchaseProposalRevisionWithAuthorization,
  executeCreatePurchaseProposalRevision,
} from './create-purchase-proposal-revision-action-client.ts';
export type { CreatePurchaseProposalRevisionActionClientOptions } from './create-purchase-proposal-revision-action-client.ts';
export {
  executeDecidePurchaseApprovalRequestWithAuthorization,
  executeDecidePurchaseApprovalRequest,
} from './decide-purchase-approval-request-action-client.ts';
export type { DecidePurchaseApprovalRequestActionClientOptions } from './decide-purchase-approval-request-action-client.ts';
export {
  executeEnsureRetailCustomerProfileWithAuthorization,
  executeEnsureRetailCustomerProfile,
} from './ensure-retail-customer-profile-action-client.ts';
export type { EnsureRetailCustomerProfileActionClientOptions } from './ensure-retail-customer-profile-action-client.ts';
export {
  executeExecutePrivacyMeasureWithAuthorization,
  executeExecutePrivacyMeasure,
} from './execute-privacy-measure-action-client.ts';
export type { ExecutePrivacyMeasureActionClientOptions } from './execute-privacy-measure-action-client.ts';
export {
  executeGrantCounterpartyCommerceAccessWithAuthorization,
  executeGrantCounterpartyCommerceAccess,
} from './grant-counterparty-commerce-access-action-client.ts';
export type { GrantCounterpartyCommerceAccessActionClientOptions } from './grant-counterparty-commerce-access-action-client.ts';
export {
  executeMigrateCounterpartyPriceGroupWithAuthorization,
  executeMigrateCounterpartyPriceGroup,
} from './migrate-counterparty-price-group-action-client.ts';
export type { MigrateCounterpartyPriceGroupActionClientOptions } from './migrate-counterparty-price-group-action-client.ts';
export {
  executeMigrateCustomerPriceGroupWithAuthorization,
  executeMigrateCustomerPriceGroup,
} from './migrate-customer-price-group-action-client.ts';
export type { MigrateCustomerPriceGroupActionClientOptions } from './migrate-customer-price-group-action-client.ts';
export {
  executeOpenProfileReconciliationWithAuthorization,
  executeOpenProfileReconciliation,
} from './open-profile-reconciliation-action-client.ts';
export type { OpenProfileReconciliationActionClientOptions } from './open-profile-reconciliation-action-client.ts';
export {
  executeReactivateCustomerGroupWithAuthorization,
  executeReactivateCustomerGroup,
} from './reactivate-customer-group-action-client.ts';
export type { ReactivateCustomerGroupActionClientOptions } from './reactivate-customer-group-action-client.ts';
export {
  executeReactivateCustomerProfileWithAuthorization,
  executeReactivateCustomerProfile,
} from './reactivate-customer-profile-action-client.ts';
export type { ReactivateCustomerProfileActionClientOptions } from './reactivate-customer-profile-action-client.ts';
export {
  executeRecordPortalEnrollmentOutcomeWithAuthorization,
  executeRecordPortalEnrollmentOutcome,
} from './record-portal-enrollment-outcome-action-client.ts';
export type { RecordPortalEnrollmentOutcomeActionClientOptions } from './record-portal-enrollment-outcome-action-client.ts';
export {
  executeRecoverRetailPortalProfileBindingWithAuthorization,
  executeRecoverRetailPortalProfileBinding,
} from './recover-retail-portal-profile-binding-action-client.ts';
export type { RecoverRetailPortalProfileBindingActionClientOptions } from './recover-retail-portal-profile-binding-action-client.ts';
export {
  executeRemoveCounterpartyPriceGroupWithAuthorization,
  executeRemoveCounterpartyPriceGroup,
} from './remove-counterparty-price-group-action-client.ts';
export type { RemoveCounterpartyPriceGroupActionClientOptions } from './remove-counterparty-price-group-action-client.ts';
export {
  executeRemoveCustomerGroupWithAuthorization,
  executeRemoveCustomerGroup,
} from './remove-customer-group-action-client.ts';
export type { RemoveCustomerGroupActionClientOptions } from './remove-customer-group-action-client.ts';
export {
  executeRemoveCustomerPaymentTermWithAuthorization,
  executeRemoveCustomerPaymentTerm,
} from './remove-customer-payment-term-action-client.ts';
export type { RemoveCustomerPaymentTermActionClientOptions } from './remove-customer-payment-term-action-client.ts';
export {
  executeRemoveCustomerPriceGroupWithAuthorization,
  executeRemoveCustomerPriceGroup,
} from './remove-customer-price-group-action-client.ts';
export type { RemoveCustomerPriceGroupActionClientOptions } from './remove-customer-price-group-action-client.ts';
export {
  executeRemoveSavedAddressWithAuthorization,
  executeRemoveSavedAddress,
} from './remove-saved-address-action-client.ts';
export type { RemoveSavedAddressActionClientOptions } from './remove-saved-address-action-client.ts';
export {
  executeRepeatCounterpartyOrderWithAuthorization,
  executeRepeatCounterpartyOrder,
} from './repeat-counterparty-order-action-client.ts';
export type { RepeatCounterpartyOrderActionClientOptions } from './repeat-counterparty-order-action-client.ts';
export {
  executeRepeatRetailOrderWithAuthorization,
  executeRepeatRetailOrder,
} from './repeat-retail-order-action-client.ts';
export type { RepeatRetailOrderActionClientOptions } from './repeat-retail-order-action-client.ts';
export {
  executeReroutePurchaseApprovalRequestWithAuthorization,
  executeReroutePurchaseApprovalRequest,
} from './reroute-purchase-approval-request-action-client.ts';
export type { ReroutePurchaseApprovalRequestActionClientOptions } from './reroute-purchase-approval-request-action-client.ts';
export {
  executeResendCounterpartyAccessInvitationWithAuthorization,
  executeResendCounterpartyAccessInvitation,
} from './resend-counterparty-access-invitation-action-client.ts';
export type { ResendCounterpartyAccessInvitationActionClientOptions } from './resend-counterparty-access-invitation-action-client.ts';
export {
  executeReserveMarketRetirementWithAuthorization,
  executeReserveMarketRetirement,
} from './reserve-market-retirement-action-client.ts';
export type { ReserveMarketRetirementActionClientOptions } from './reserve-market-retirement-action-client.ts';
export {
  executeReservePaymentTermRetirementWithAuthorization,
  executeReservePaymentTermRetirement,
} from './reserve-payment-term-retirement-action-client.ts';
export type { ReservePaymentTermRetirementActionClientOptions } from './reserve-payment-term-retirement-action-client.ts';
export {
  executeResolveProfileReconciliationWithAuthorization,
  executeResolveProfileReconciliation,
} from './resolve-profile-reconciliation-action-client.ts';
export type { ResolveProfileReconciliationActionClientOptions } from './resolve-profile-reconciliation-action-client.ts';
export {
  executeRevalidatePurchaseApprovalWithAuthorization,
  executeRevalidatePurchaseApproval,
} from './revalidate-purchase-approval-action-client.ts';
export type { RevalidatePurchaseApprovalActionClientOptions } from './revalidate-purchase-approval-action-client.ts';
export {
  executeRevokeCounterpartyAccessInvitationWithAuthorization,
  executeRevokeCounterpartyAccessInvitation,
} from './revoke-counterparty-access-invitation-action-client.ts';
export type { RevokeCounterpartyAccessInvitationActionClientOptions } from './revoke-counterparty-access-invitation-action-client.ts';
export {
  executeRevokeCounterpartyCommerceAccessWithAuthorization,
  executeRevokeCounterpartyCommerceAccess,
} from './revoke-counterparty-commerce-access-action-client.ts';
export type { RevokeCounterpartyCommerceAccessActionClientOptions } from './revoke-counterparty-commerce-access-action-client.ts';
export {
  executeRevokeRetailPortalProfileBindingWithAuthorization,
  executeRevokeRetailPortalProfileBinding,
} from './revoke-retail-portal-profile-binding-action-client.ts';
export type { RevokeRetailPortalProfileBindingActionClientOptions } from './revoke-retail-portal-profile-binding-action-client.ts';
export {
  executeSetDefaultBillingAddressWithAuthorization,
  executeSetDefaultBillingAddress,
} from './set-default-billing-address-action-client.ts';
export type { SetDefaultBillingAddressActionClientOptions } from './set-default-billing-address-action-client.ts';
export {
  executeSetDefaultDeliveryDestinationWithAuthorization,
  executeSetDefaultDeliveryDestination,
} from './set-default-delivery-destination-action-client.ts';
export type { SetDefaultDeliveryDestinationActionClientOptions } from './set-default-delivery-destination-action-client.ts';
export {
  executeStartPortalEnrollmentWithAuthorization,
  executeStartPortalEnrollment,
} from './start-portal-enrollment-action-client.ts';
export type { StartPortalEnrollmentActionClientOptions } from './start-portal-enrollment-action-client.ts';
export {
  executeSubmitPurchaseApprovalRequestWithAuthorization,
  executeSubmitPurchaseApprovalRequest,
} from './submit-purchase-approval-request-action-client.ts';
export type { SubmitPurchaseApprovalRequestActionClientOptions } from './submit-purchase-approval-request-action-client.ts';
export {
  executeSuspendCustomerProfileWithAuthorization,
  executeSuspendCustomerProfile,
} from './suspend-customer-profile-action-client.ts';
export type { SuspendCustomerProfileActionClientOptions } from './suspend-customer-profile-action-client.ts';
export {
  executeTerminatePortalEnrollmentWithAuthorization,
  executeTerminatePortalEnrollment,
} from './terminate-portal-enrollment-action-client.ts';
export type { TerminatePortalEnrollmentActionClientOptions } from './terminate-portal-enrollment-action-client.ts';
export {
  executeTriggerPurchaseApprovalWithAuthorization,
  executeTriggerPurchaseApproval,
} from './trigger-purchase-approval-action-client.ts';
export type { TriggerPurchaseApprovalActionClientOptions } from './trigger-purchase-approval-action-client.ts';
export {
  executeUpdateCustomerGroupWithAuthorization,
  executeUpdateCustomerGroup,
} from './update-customer-group-action-client.ts';
export type { UpdateCustomerGroupActionClientOptions } from './update-customer-group-action-client.ts';
export {
  executeUpdateSavedAddressWithAuthorization,
  executeUpdateSavedAddress,
} from './update-saved-address-action-client.ts';
export type { UpdateSavedAddressActionClientOptions } from './update-saved-address-action-client.ts';
// </generated-action-http-client-exports>
export {
  executeCommerceQuantityResolutionWithAuthorization,
  executeCommerceQuantityResolution,
} from './commerce-quantity-resolution-client.ts';
export type { CommerceQuantityResolutionClientOptions } from './commerce-quantity-resolution-client.ts';
export {
  executeEffectiveCustomerGroupMembershipSetV1WithAuthorization,
  executeEffectiveCustomerGroupMembershipSetV1,
} from './effective-customer-group-membership-set-v1-client.ts';
export type { EffectiveCustomerGroupMembershipSetV1ClientOptions } from './effective-customer-group-membership-set-v1-client.ts';
export {
  executeMarketBootstrapPolicyCurrentWithAuthorization,
  executeMarketBootstrapPolicyCurrent,
} from './market-bootstrap-policy-current-client.ts';
export type { MarketBootstrapPolicyCurrentClientOptions } from './market-bootstrap-policy-current-client.ts';
export {
  executeMarketBootstrapResolutionWithAuthorization,
  executeMarketBootstrapResolution,
} from './market-bootstrap-resolution-client.ts';
export type { MarketBootstrapResolutionClientOptions } from './market-bootstrap-resolution-client.ts';
export {
  executeMarketSubjectRestrictionsCurrentWithAuthorization,
  executeMarketSubjectRestrictionsCurrent,
} from './market-subject-restrictions-current-client.ts';
export type { MarketSubjectRestrictionsCurrentClientOptions } from './market-subject-restrictions-current-client.ts';
export {
  executeMarketAffectedUseAssessmentWithAuthorization,
  executeMarketAffectedUseAssessment,
} from './market-affected-use-assessment-client.ts';
export type { MarketAffectedUseAssessmentClientOptions } from './market-affected-use-assessment-client.ts';
export {
  executePaymentTermsResolutionWithAuthorization,
  executePaymentTermsResolution,
} from './payment-terms-resolution-client.ts';
export type { PaymentTermsResolutionClientOptions } from './payment-terms-resolution-client.ts';
export {
  executePurchaseCurrencyResolutionWithAuthorization,
  executePurchaseCurrencyResolution,
} from './purchase-currency-resolution-client.ts';
export type { PurchaseCurrencyResolutionClientOptions } from './purchase-currency-resolution-client.ts';
export {
  executeRetailPurchasingSubjectCurrentV1WithAuthorization,
  executeRetailPurchasingSubjectCurrentV1,
} from './retail-purchasing-subject-current-v1-client.ts';
export type { RetailPurchasingSubjectCurrentV1ClientOptions } from './retail-purchasing-subject-current-v1-client.ts';
export {
  executeVerifyEffectiveCustomerGroupMembershipSetV1WithAuthorization,
  executeVerifyEffectiveCustomerGroupMembershipSetV1,
} from './verify-effective-customer-group-membership-set-v1-client.ts';
export type { VerifyEffectiveCustomerGroupMembershipSetV1ClientOptions } from './verify-effective-customer-group-membership-set-v1-client.ts';
export {
  executeVerifyRetailPurchasingSubjectCurrentV1WithAuthorization,
  executeVerifyRetailPurchasingSubjectCurrentV1,
} from './verify-retail-purchasing-subject-current-v1-client.ts';
export type { VerifyRetailPurchasingSubjectCurrentV1ClientOptions } from './verify-retail-purchasing-subject-current-v1-client.ts';
export {
  executePaymentTermAffectedUseAssessmentWithAuthorization,
  executePaymentTermAffectedUseAssessment,
} from './payment-term-affected-use-assessment-client.ts';
export type { PaymentTermAffectedUseAssessmentClientOptions } from './payment-term-affected-use-assessment-client.ts';
export {
  executePrivacyMeasureExecutionWithAuthorization,
  executePrivacyMeasureExecution,
} from './privacy-measure-execution-client.ts';
export type { PrivacyMeasureExecutionClientOptions } from './privacy-measure-execution-client.ts';
export {
  PaymentTermAffectedUseAssessmentRequestSchema,
  PaymentTermAffectedUseAssessmentResponseSchema,
} from '../../shared/api.ts';
export type {
  PaymentTermAffectedUseAssessmentRequest,
  PaymentTermAffectedUseAssessmentResponse,
} from '../../shared/api.ts';

type CommerceCustomerContextApiGroups =
  typeof commerceCustomerContextApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

export type CommerceCustomerContextClient = HttpApiClient.Client<
  Extract<CommerceCustomerContextApiGroups, HttpApiGroup.Constraint>
>;

export type CommerceCustomerContextClientError = HttpClientError.HttpClientError | Schema.SchemaError;

export type CommerceCustomerContextClientEffect<Success> = Effect.Effect<Success, CommerceCustomerContextClientError>;

export interface CommerceCustomerContextClientOptions {
  baseUrl?: string | URL;
  locale?: string;
  operationContext?: OperationContext;
  // eslint-disable-next-line effect-native/no-threaded-correlation-parameter -- This is the standard W3C request transport field accepted by the owner BFF, not ambient application correlation state. expires: 2027-03-31.
  traceparent?: string;
}

export const createCommerceCustomerContextClient = (
  options: CommerceCustomerContextClientOptions = {},
): CommerceCustomerContextClientEffect<CommerceCustomerContextClient> => {
  /* oxlint-disable anti-slop/no-known-value-widening, effect-native/no-threaded-correlation-parameter -- This mutable request fragment intentionally preserves optional public wire metadata, including the caller-supplied W3C trace header. */
  const requestContext: {
    locale?: string;
    operationContext?: OperationContext;
    traceparent?: string;
  } = {};
  /* oxlint-enable anti-slop/no-known-value-widening, effect-native/no-threaded-correlation-parameter */
  if (options.locale !== undefined) {
    Object.assign(requestContext, { locale: options.locale });
  }
  if (options.operationContext !== undefined) {
    Object.assign(requestContext, { operationContext: options.operationContext });
  }
  if (options.traceparent !== undefined) {
    Object.assign(requestContext, { traceparent: options.traceparent });
  }
  // eslint-disable-next-line effect-native/no-per-operation-http-api-client -- The generated aggregate accepts per-call base URLs and request metadata; keeping these options on the short-lived Effect prevents cross-request state in this public factory. expires: 2027-03-31.
  return makeEffectHttpApiClient(commerceCustomerContextApi, {
    baseUrl: options.baseUrl ?? commerceCustomerContextApiContract.apiPrefix,
    requestContext,
  });
};

export const getCommerceCustomerContextReadiness = (
  options: CommerceCustomerContextClientOptions = {},
): CommerceCustomerContextClientEffect<CommerceCustomerContextReadiness> =>
  // oxlint-disable-next-line effect-native/no-per-operation-http-api-client -- This generated public wrapper delegates caller-specific base URL and request metadata without introducing shared cross-request state.
  createCommerceCustomerContextClient({
    ...options,
    operationContext: options.operationContext ?? commerceCustomerContextOperationContexts.readiness,
  }).pipe(Effect.flatMap((client) => client.foundation.readiness({})));
