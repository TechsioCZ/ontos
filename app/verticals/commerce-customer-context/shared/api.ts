import { identity } from 'effect';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@app/shared-contracts';
import type {
  MicroVerticalBuildMarker,
  MicroVerticalOperationContext,
  MicroVerticalReadiness,
} from '@app/shared-contracts';
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  Schema,
} from '@modern-js/plugin-bff/effect-client';

export type CommerceCustomerContextMarker = MicroVerticalBuildMarker;

export type CommerceCustomerContextReadiness = MicroVerticalReadiness;

export const commerceCustomerContextMarkerSchema: Schema.Codec<CommerceCustomerContextMarker> =
  MicroVerticalBuildMarkerSchema;

export const commerceCustomerContextReadinessSchema: Schema.Codec<CommerceCustomerContextReadiness> =
  MicroVerticalReadinessSchema;

export type OperationContext = MicroVerticalOperationContext;

export const commerceCustomerContextFoundationApi = HttpApi.make(
  'CommerceCustomerContextApiFoundation',
).add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/commerce-customer-context/readiness', {
      success: commerceCustomerContextReadinessSchema,
    }),
  ),
);

// <generated-governed-http-api-imports>
import { AddSavedAddressActionApi } from './apis/add-saved-address-action.ts';
import { ArchiveCustomerGroupActionApi } from './apis/archive-customer-group-action.ts';
import { ArchiveCustomerProfileActionApi } from './apis/archive-customer-profile-action.ts';
import { AssignCounterpartyPriceGroupActionApi } from './apis/assign-counterparty-price-group-action.ts';
import { AssignCustomerGroupActionApi } from './apis/assign-customer-group-action.ts';
import { AssignCustomerPriceGroupActionApi } from './apis/assign-customer-price-group-action.ts';
import { AttributeGuestRetailCustomerActionApi } from './apis/attribute-guest-retail-customer-action.ts';
import { BindRetailPortalProfileActionApi } from './apis/bind-retail-portal-profile-action.ts';
import { BootstrapCounterpartyAccessAdministratorActionApi } from './apis/bootstrap-counterparty-access-administrator-action.ts';
import { ChangeCounterpartyPurchaseLimitActionApi } from './apis/change-counterparty-purchase-limit-action.ts';
import { ChangeCustomerPaymentTermsActionApi } from './apis/change-customer-payment-terms-action.ts';
import { ChangePrincipalPurchaseLimitOverrideActionApi } from './apis/change-principal-purchase-limit-override-action.ts';
import { ChangeRetailPaymentTermPreferenceActionApi } from './apis/change-retail-payment-term-preference-action.ts';
import { ClaimCounterpartyAccessInvitationActionApi } from './apis/claim-counterparty-access-invitation-action.ts';
import { ClearDefaultBillingAddressActionApi } from './apis/clear-default-billing-address-action.ts';
import { ClearDefaultDeliveryDestinationActionApi } from './apis/clear-default-delivery-destination-action.ts';
import { ConsumePurchaseApprovalActionApi } from './apis/consume-purchase-approval-action.ts';
import { CounterpartyAccessInvitationReadApi } from './apis/counterparty-access-invitation-read.ts';
import { CounterpartyAllCustomerArchiveApi } from './apis/counterparty-all-customer-archive.ts';
import { CounterpartyAllOrderHistoryApi } from './apis/counterparty-all-order-history.ts';
import { CounterpartyAllOrderHistoryDetailApi } from './apis/counterparty-all-order-history-detail.ts';
import { CounterpartyCommerceAccessCheckApi } from './apis/counterparty-commerce-access-check.ts';
import { CounterpartyCommerceAccessDetailApi } from './apis/counterparty-commerce-access-detail.ts';
import { CounterpartyCommerceAccessListApi } from './apis/counterparty-commerce-access-list.ts';
import { CounterpartyOrderHistoryApi } from './apis/counterparty-order-history.ts';
import { CounterpartyOrderHistoryDetailApi } from './apis/counterparty-order-history-detail.ts';
import { CreateApprovalHierarchyActionApi } from './apis/create-approval-hierarchy-action.ts';
import { CreateCounterpartyAccessInvitationActionApi } from './apis/create-counterparty-access-invitation-action.ts';
import { CreateCounterpartyPurchasingProfileActionApi } from './apis/create-counterparty-purchasing-profile-action.ts';
import { CreateCustomerGroupActionApi } from './apis/create-customer-group-action.ts';
import { CreatePurchaseProposalRevisionActionApi } from './apis/create-purchase-proposal-revision-action.ts';
import { CustomerArchiveApi } from './apis/customer-archive.ts';
import { CustomerGroupDetailApi } from './apis/customer-group-detail.ts';
import { CustomerGroupHistoryApi } from './apis/customer-group-history.ts';
import { CustomerGroupMembersApi } from './apis/customer-group-members.ts';
import { CustomerPaymentTermEntitlementReadApi } from './apis/customer-payment-term-entitlement-read.ts';
import { CustomerPriceGroupAssignmentReadApi } from './apis/customer-price-group-assignment-read.ts';
import { CustomerPriceGroupResolutionApi } from './apis/customer-price-group-resolution.ts';
import { CustomerProfileReadApi } from './apis/customer-profile-read.ts';
import { CustomerProfileTradingGateApi } from './apis/customer-profile-trading-gate.ts';
import { CustomerRecordVisibilityApi } from './apis/customer-record-visibility.ts';
import { DecidePurchaseApprovalRequestActionApi } from './apis/decide-purchase-approval-request-action.ts';
import { DeliveryDestinationResolutionApi } from './apis/delivery-destination-resolution.ts';
import { EffectiveCustomerGroupMembershipsApi } from './apis/effective-customer-group-memberships.ts';
import { EnsureRetailCustomerProfileActionApi } from './apis/ensure-retail-customer-profile-action.ts';
import { GrantCounterpartyCommerceAccessActionApi } from './apis/grant-counterparty-commerce-access-action.ts';
import { GuestAttributionStatusApi } from './apis/guest-attribution-status.ts';
import { GuestPaymentTermsResolutionApi } from './apis/guest-payment-terms-resolution.ts';
import { InvoiceRecipientResolutionApi } from './apis/invoice-recipient-resolution.ts';
import { MigrateCounterpartyPriceGroupActionApi } from './apis/migrate-counterparty-price-group-action.ts';
import { MigrateCustomerPriceGroupActionApi } from './apis/migrate-customer-price-group-action.ts';
import { OpenProfileReconciliationActionApi } from './apis/open-profile-reconciliation-action.ts';
import { PaymentTermAffectedUseAssessmentApi } from './apis/payment-term-affected-use-assessment.ts';
import { PaymentTermsResolutionApi } from './apis/payment-terms-resolution.ts';
import { ProfileReconciliationReadApi } from './apis/profile-reconciliation-read.ts';
import { PurchaseCurrencyResolutionApi } from './apis/purchase-currency-resolution.ts';
import { PurchaseLimitEvaluationApi } from './apis/purchase-limit-evaluation.ts';
import { PurchaseLimitPolicyReadApi } from './apis/purchase-limit-policy-read.ts';
import { ReactivateCustomerGroupActionApi } from './apis/reactivate-customer-group-action.ts';
import { ReactivateCustomerProfileActionApi } from './apis/reactivate-customer-profile-action.ts';
import { RecoverRetailPortalProfileBindingActionApi } from './apis/recover-retail-portal-profile-binding-action.ts';
import { RemoveCounterpartyPriceGroupActionApi } from './apis/remove-counterparty-price-group-action.ts';
import { RemoveCustomerGroupActionApi } from './apis/remove-customer-group-action.ts';
import { RemoveCustomerPaymentTermActionApi } from './apis/remove-customer-payment-term-action.ts';
import { RemoveCustomerPriceGroupActionApi } from './apis/remove-customer-price-group-action.ts';
import { RemoveSavedAddressActionApi } from './apis/remove-saved-address-action.ts';
import { RepeatCounterpartyOrderActionApi } from './apis/repeat-counterparty-order-action.ts';
import { RepeatOrderPreparationApi } from './apis/repeat-order-preparation.ts';
import { RepeatRetailOrderActionApi } from './apis/repeat-retail-order-action.ts';
import { ReroutePurchaseApprovalRequestActionApi } from './apis/reroute-purchase-approval-request-action.ts';
import { ResendCounterpartyAccessInvitationActionApi } from './apis/resend-counterparty-access-invitation-action.ts';
import { ReservePaymentTermRetirementActionApi } from './apis/reserve-payment-term-retirement-action.ts';
import { ResolveProfileReconciliationActionApi } from './apis/resolve-profile-reconciliation-action.ts';
import { RetailAccessDecisionApi } from './apis/retail-access-decision.ts';
import { RetailOrderHistoryApi } from './apis/retail-order-history.ts';
import { RetailOrderHistoryDetailApi } from './apis/retail-order-history-detail.ts';
import { RetailPortalProfileBindingReadApi } from './apis/retail-portal-profile-binding-read.ts';
import { RetailPrincipalResolutionApi } from './apis/retail-principal-resolution.ts';
import { RevalidatePurchaseApprovalActionApi } from './apis/revalidate-purchase-approval-action.ts';
import { RevokeCounterpartyAccessInvitationActionApi } from './apis/revoke-counterparty-access-invitation-action.ts';
import { RevokeCounterpartyCommerceAccessActionApi } from './apis/revoke-counterparty-commerce-access-action.ts';
import { RevokeRetailPortalProfileBindingActionApi } from './apis/revoke-retail-portal-profile-binding-action.ts';
import { SavedAddressDefaultsApi } from './apis/saved-address-defaults.ts';
import { SavedAddressDetailApi } from './apis/saved-address-detail.ts';
import { SavedAddressListApi } from './apis/saved-address-list.ts';
import { SetDefaultBillingAddressActionApi } from './apis/set-default-billing-address-action.ts';
import { SetDefaultDeliveryDestinationActionApi } from './apis/set-default-delivery-destination-action.ts';
import { SubmitPurchaseApprovalRequestActionApi } from './apis/submit-purchase-approval-request-action.ts';
import { SuspendCustomerProfileActionApi } from './apis/suspend-customer-profile-action.ts';
import { TriggerPurchaseApprovalActionApi } from './apis/trigger-purchase-approval-action.ts';
import { UpdateCustomerGroupActionApi } from './apis/update-customer-group-action.ts';
import { UpdateSavedAddressActionApi } from './apis/update-saved-address-action.ts';
// </generated-governed-http-api-imports>

export * from './apis/payment-term-affected-use-assessment.ts';

export const commerceCustomerContextApi = HttpApi.make('CommerceCustomerContextApi')
  .addHttpApi(commerceCustomerContextFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(AddSavedAddressActionApi)
  .addHttpApi(ArchiveCustomerGroupActionApi)
  .addHttpApi(ArchiveCustomerProfileActionApi)
  .addHttpApi(AssignCounterpartyPriceGroupActionApi)
  .addHttpApi(AssignCustomerGroupActionApi)
  .addHttpApi(AssignCustomerPriceGroupActionApi)
  .addHttpApi(AttributeGuestRetailCustomerActionApi)
  .addHttpApi(BindRetailPortalProfileActionApi)
  .addHttpApi(BootstrapCounterpartyAccessAdministratorActionApi)
  .addHttpApi(ChangeCounterpartyPurchaseLimitActionApi)
  .addHttpApi(ChangeCustomerPaymentTermsActionApi)
  .addHttpApi(ChangePrincipalPurchaseLimitOverrideActionApi)
  .addHttpApi(ChangeRetailPaymentTermPreferenceActionApi)
  .addHttpApi(ClaimCounterpartyAccessInvitationActionApi)
  .addHttpApi(ClearDefaultBillingAddressActionApi)
  .addHttpApi(ClearDefaultDeliveryDestinationActionApi)
  .addHttpApi(ConsumePurchaseApprovalActionApi)
  .addHttpApi(CounterpartyAccessInvitationReadApi)
  .addHttpApi(CounterpartyAllCustomerArchiveApi)
  .addHttpApi(CounterpartyAllOrderHistoryApi)
  .addHttpApi(CounterpartyAllOrderHistoryDetailApi)
  .addHttpApi(CounterpartyCommerceAccessCheckApi)
  .addHttpApi(CounterpartyCommerceAccessDetailApi)
  .addHttpApi(CounterpartyCommerceAccessListApi)
  .addHttpApi(CounterpartyOrderHistoryApi)
  .addHttpApi(CounterpartyOrderHistoryDetailApi)
  .addHttpApi(CreateApprovalHierarchyActionApi)
  .addHttpApi(CreateCounterpartyAccessInvitationActionApi)
  .addHttpApi(CreateCounterpartyPurchasingProfileActionApi)
  .addHttpApi(CreateCustomerGroupActionApi)
  .addHttpApi(CreatePurchaseProposalRevisionActionApi)
  .addHttpApi(CustomerArchiveApi)
  .addHttpApi(CustomerGroupDetailApi)
  .addHttpApi(CustomerGroupHistoryApi)
  .addHttpApi(CustomerGroupMembersApi)
  .addHttpApi(CustomerPaymentTermEntitlementReadApi)
  .addHttpApi(CustomerPriceGroupAssignmentReadApi)
  .addHttpApi(CustomerPriceGroupResolutionApi)
  .addHttpApi(CustomerProfileReadApi)
  .addHttpApi(CustomerProfileTradingGateApi)
  .addHttpApi(CustomerRecordVisibilityApi)
  .addHttpApi(DecidePurchaseApprovalRequestActionApi)
  .addHttpApi(DeliveryDestinationResolutionApi)
  .addHttpApi(EffectiveCustomerGroupMembershipsApi)
  .addHttpApi(EnsureRetailCustomerProfileActionApi)
  .addHttpApi(GrantCounterpartyCommerceAccessActionApi)
  .addHttpApi(GuestAttributionStatusApi)
  .addHttpApi(GuestPaymentTermsResolutionApi)
  .addHttpApi(InvoiceRecipientResolutionApi)
  .addHttpApi(MigrateCounterpartyPriceGroupActionApi)
  .addHttpApi(MigrateCustomerPriceGroupActionApi)
  .addHttpApi(OpenProfileReconciliationActionApi)
  .addHttpApi(PaymentTermAffectedUseAssessmentApi)
  .addHttpApi(PaymentTermsResolutionApi)
  .addHttpApi(ProfileReconciliationReadApi)
  .addHttpApi(PurchaseCurrencyResolutionApi)
  .addHttpApi(PurchaseLimitEvaluationApi)
  .addHttpApi(PurchaseLimitPolicyReadApi)
  .addHttpApi(ReactivateCustomerGroupActionApi)
  .addHttpApi(ReactivateCustomerProfileActionApi)
  .addHttpApi(RecoverRetailPortalProfileBindingActionApi)
  .addHttpApi(RemoveCounterpartyPriceGroupActionApi)
  .addHttpApi(RemoveCustomerGroupActionApi)
  .addHttpApi(RemoveCustomerPaymentTermActionApi)
  .addHttpApi(RemoveCustomerPriceGroupActionApi)
  .addHttpApi(RemoveSavedAddressActionApi)
  .addHttpApi(RepeatCounterpartyOrderActionApi)
  .addHttpApi(RepeatOrderPreparationApi)
  .addHttpApi(RepeatRetailOrderActionApi)
  .addHttpApi(ReroutePurchaseApprovalRequestActionApi)
  .addHttpApi(ResendCounterpartyAccessInvitationActionApi)
  .addHttpApi(ReservePaymentTermRetirementActionApi)
  .addHttpApi(ResolveProfileReconciliationActionApi)
  .addHttpApi(RetailAccessDecisionApi)
  .addHttpApi(RetailOrderHistoryApi)
  .addHttpApi(RetailOrderHistoryDetailApi)
  .addHttpApi(RetailPortalProfileBindingReadApi)
  .addHttpApi(RetailPrincipalResolutionApi)
  .addHttpApi(RevalidatePurchaseApprovalActionApi)
  .addHttpApi(RevokeCounterpartyAccessInvitationActionApi)
  .addHttpApi(RevokeCounterpartyCommerceAccessActionApi)
  .addHttpApi(RevokeRetailPortalProfileBindingActionApi)
  .addHttpApi(SavedAddressDefaultsApi)
  .addHttpApi(SavedAddressDetailApi)
  .addHttpApi(SavedAddressListApi)
  .addHttpApi(SetDefaultBillingAddressActionApi)
  .addHttpApi(SetDefaultDeliveryDestinationActionApi)
  .addHttpApi(SubmitPurchaseApprovalRequestActionApi)
  .addHttpApi(SuspendCustomerProfileActionApi)
  .addHttpApi(TriggerPurchaseApprovalActionApi)
  .addHttpApi(UpdateCustomerGroupActionApi)
  .addHttpApi(UpdateSavedAddressActionApi)
  // </generated-governed-http-api-additions>
  .pipe(identity);
export const commerceCustomerContextOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'CommerceCustomerContextApi:commerceCustomerContext:readiness',
    routePath: '/commerce-customer-context/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const commerceCustomerContextApiContract = {
  apiPrefix: '/commerce-customer-context-api',
  basePath: '/commerce-customer-context-api/commerce-customer-context',
  ownerId: 'commerce-customer-context',
  readinessPath: '/commerce-customer-context-api/commerce-customer-context/readiness',
} as const;
