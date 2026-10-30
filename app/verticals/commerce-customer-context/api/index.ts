import { customerOwnConsentReadApiLive, customerOwnConsentUpdateApiLive } from './portal-auth/consent/http.ts';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import type { HttpServerRequest } from 'effect/http';
import {
  CommercePortalAuthVerificationLive,
  CommercePortalAuthVerificationService,
} from './portal-auth/provider/verification.ts';
import type { CommercePortalAuthVerificationAuthorization } from './portal-auth/provider/verification.ts';
import { CommercePortalAuthVerificationCaller } from './portal-auth/provider/verification-caller-service.ts';
import { CommercePortalAuthVerificationCallerRejected } from './portal-auth/provider/verification-caller-rejected.ts';
import { CommercePortalAuthVerificationCallerUnavailable } from './portal-auth/provider/verification-caller-unavailable.ts';
import { VerifyExternalAuthenticationRequestSchema } from '../shared/portal-auth-contracts.ts';
import type { CommercePortalAuthVerificationRequest } from '../shared/portal-auth-verification.ts';
import {
  CommercePortalAuthVerificationHttpExecutor,
  commercePortalAuthVerificationCommerceApiLive,
} from './portal-auth/verification-http/server.ts';
import {
  CommercePortalAuthVerificationWorkloadAuthorization,
  commercePortalAuthVerificationWorkloadAuthorizationLive,
} from './portal-auth/verification-http/workload-authorization.ts';
import {
  commercePortalAuthVerificationForbiddenProblem,
  commercePortalAuthVerificationInvalidProblem,
  commercePortalAuthVerificationUnauthorizedProblem,
  commercePortalAuthVerificationUnavailableProblem,
} from './portal-auth/verification-http/problems.ts';
import { PgClient } from '@effect/sql-pg';
import { Reactivity } from 'effect/reactivity';
import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
} from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { EmailDeliveryService } from '@app/email-delivery/server';
import {
  defineDatabaseIdentityEnrollment,
  makeDatabaseIdentityEnrollmentLive,
  ActionRuntime,
  ActionAuthorizationPreflight,
  makeActionRuntimeLive,
  ActionAuthorizationPreflightDatabaseLive,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import type {
  ActionRuntimeService,
  ContextAccess,
  DatabaseConfig,
  GatewayAssertionRedemptionService,
  ReadRuntime,
} from '@app/core-runtime';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder, HttpRouter, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import { Context, Layer as GovernedReadLayer, Logger, Option, Redacted, References, Schema, Tracer } from 'effect';
import {
  PartyRegistryRetailPartyResolverFactory,
  preparedRetailPartyResolution,
} from '../src/integrations/party-registry-retail-party-resolver.ts';
import {
  RetailEnrollmentBindingAuthority,
  RetailEnrollmentBindingCapability,
  prepareRetailEnrollmentBinding,
} from '../src/integrations/retail-enrollment-binding.ts';
import { retailEnrollmentBindingAuthorityLive } from '../src/integrations/retail-enrollment-binding-live.ts';
import { CommercePortalAuthDatabaseLive } from '../src/portal-auth/persistence/portal-auth-database.ts';
import { CommercePortalAuthAuditLive } from '../src/portal-auth/audit/audit.ts';
import { CommercePortalAuthAccountLookupLive } from '../src/portal-auth/persistence/portal-auth-account-lookup.ts';
import { CommercePortalAuthAccountCreationReconciliationLive } from '../src/portal-auth/persistence/portal-auth-account-creation-reconciliation.ts';
import {
  CommerceEnrollmentContinuationLive,
  commerceEnrollmentContinuationUnavailableLive,
} from '../src/enrollment/continuation/enrollment-continuation.ts';
import { CommerceEnrollmentOwnerTransactionRunnerLive } from '../src/enrollment/orchestration/owner-transaction-runner.ts';
import { CommerceEnrollmentOwnerEffectRegistryLive } from '../src/enrollment/orchestration/owner-effect-registry.ts';
import { commerceEnrollmentOwnerTransitionPreparationLive } from '../src/enrollment/orchestration/owner-transition-composition.ts';
import { CommerceEnrollmentPreparationSubjectResolverLive } from '../src/enrollment/orchestration/preparation-subject.ts';
import { CommercePortalAuthAccountCreationUnavailable } from './portal-auth/provider/account-creation-unavailable.ts';
import { CommercePortalAuthAccountLookupService } from './portal-auth/provider/account-lookup-service.ts';
import { CommercePortalAuthLive } from './portal-auth/provider/auth.ts';
import {
  CommercePortalAuthConfigLive,
  optionalCommercePortalAuthConfig,
  portalAuthRealmConfigured,
} from './portal-auth/provider/config.ts';
import { commercePortalAuthRealmUnavailableLive } from './portal-auth/realm-unavailable.ts';
import type { CommercePortalAuthHandlerServices } from './portal-auth/realm-unavailable.ts';
import { CommercePortalAuthEmailDeliveryLive } from './portal-auth/provider/recovery/email-delivery.ts';
import { CommercePortalAuthPlatformEmailDeliveryLive } from './portal-auth/provider/platform-email-delivery.ts';
import type { CommercePortalAuthPlatformEmailSubmit } from './portal-auth/provider/platform-email-delivery.ts';
import { CommercePortalAuthRecoveryStoreLive } from '../src/portal-auth/persistence/portal-auth-recovery-store.ts';
import { CommercePortalAuthTransactionalEmailLive } from './portal-auth/provider/transactional-email.ts';
import { portalAuthMfaApiLive } from './portal-auth/provider/mfa/http.ts';
import { CommercePortalAuthMfaProviderLive } from './portal-auth/provider/mfa/better-auth-provider.ts';
import { CommercePortalAuthMfaServiceLive } from './portal-auth/provider/mfa/service.ts';
import { CommercePortalAuthMfaStepUpCodeVerifierLive } from './portal-auth/provider/mfa/step-up-verifier.ts';
import { enrollmentCommandRecoveryLive } from './enrollment-command-recovery.ts';
import { portalAuthEnrollmentApiLive } from './portal-auth/enrollment/http.ts';
import { customerOwnProfileReadApiLive, customerOwnProfileUpdateApiLive } from './portal-auth/profile/http.ts';
import {
  CommercePortalAuthAccountCreationGatewayLive,
  CommercePortalAuthAccountCreationProviderLive,
  CommercePortalAuthAccountCreationServiceLive,
} from './portal-auth/provider/account-create.ts';
import { CommerceEnrollmentProofServiceLive } from '../src/enrollment/attempts/enrollment-proof-service.ts';
import {
  CommerceEnrollmentCommitResolutionServiceLive,
  commerceEnrollmentCommitResolutionUnavailableLive,
} from '../src/enrollment/commit-resolution/commit-resolution-service.ts';
import { CommerceAuthenticationNamespaceRegistryLive } from './portal-auth/authentication-namespace-registry.ts';
import { CommerceCoreIdentityClientLive } from './portal-auth/provider/core-identity-client.ts';
import {
  CommerceCoreIdentityClientConfigLive,
  coreIdentityTransportConfigured,
  optionalCommerceCoreIdentityClientConfig,
} from './portal-auth/provider/core-identity-client-config.ts';
import { CommercePortalAuthRecoveryReconciliationServiceLive } from './portal-auth/provider/recovery/reconciliation.ts';
import { portalAuthRecoveryApiLive } from './portal-auth/provider/recovery/http.ts';
import {
  CommercePortalAuthRecoveryProviderLive,
  CommercePortalAuthRecoveryRateLimitLive,
} from './portal-auth/provider/recovery/provider-service.ts';
import { CommercePortalAuthRecoveryServiceLive } from './portal-auth/provider/recovery/service.ts';
import { CommercePortalAuthVerificationWorkloadGrantConfigurationLive } from './portal-auth/verification-http/workload-grants.ts';
import { CommercePortalAuthSessionReaderLive } from '../src/portal-auth/persistence/portal-auth-session-reader.ts';
import { portalAuthStepUpApiLive } from './portal-auth/provider/step-up/http.ts';
import { CommercePortalAuthStepUpHttpProviderUnavailableLive } from './portal-auth/provider/step-up/http-provider-unavailable.ts';
import { CommercePortalAuthStepUpLive } from './portal-auth/provider/step-up/step-up.ts';
import { CommercePortalAuthStepUpChallengeStoreLive } from '../src/portal-auth/persistence/portal-auth-step-up-store.ts';
import { CommercePortalAuthSessionLifecycleLive } from './portal-auth/session/lifecycle.ts';
import { CommercePortalAuthSessionProviderLive } from './portal-auth/session/provider.ts';
import { CommercePortalAuthSessionStoreLive } from '../src/portal-auth/persistence/portal-auth-session-store.ts';
import { CommercePortalAuthServiceLive, portalAuthSessionApiLive } from './portal-auth/session/http.ts';
import {
  commerceCustomerAuthorityLive,
  commerceCustomerAuthorityUnavailableLive,
} from './portal-auth/session/customer-authority.ts';
import { commercePortalAuthPlatformCryptoLive } from './portal-auth/deployment.ts';
import { FetchHttpClient } from 'effect/http';
import {
  CommerceEnrollmentOwnerTransitionPreparation,
  CommerceEnrollmentPreparedOwnerCapability,
  CommerceEnrollmentPreparedOwnerExecutionService,
  commerceEnrollmentPreparedOwnerExecutionLive,
  composeActionAuthorizationPreflights,
} from '../src/enrollment/orchestration/prepared-owner-authority.ts';
import {
  GatewayAssertionRedemptionDatabaseLive as GovernedGatewayAssertionRedemptionDatabaseLive,
  gatewayAssertionRedemptionPgClient,
} from '../src/auth/gateway-assertion-redemption-runtime.ts';
// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import { GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive } from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>
import {
  commerceCustomerContextOwnerRuntimeServicesLive,
  commerceCustomerContextProductionExternalPortsLive,
} from './commerce-customer-context-production-layers.ts';
import { commerceCustomerContextOwnerAuthorizationOverlayLive } from '../src/persistence/owner-authorization-overlay.ts';
import { commerceCustomerContextInvitationClaimActionAuthorizationPreflightLive } from '../src/persistence/invitation-claim-action-preflight.ts';
import { profileReconfirmationPolicyUnavailableLive } from '../src/integrations/profile-reactivation-eligibility.ts';
import { profileCounterpartyRoleEligibilityResolverFactoryLive } from '../src/profile-counterparty-role-eligibility.ts';
import { profileRetailPermissionReaderFactoryLive } from '../src/integrations/retail-permission-reader.ts';
import { purchaseLimitPersistenceLayer } from '../src/persistence/purchase-limit-persistence.ts';
import { purchaseProposalBasisCurrentnessLive as purchaseLimitEvaluationCurrentnessLive } from '../src/services/purchase-proposal-basis.service.ts';
import { purchaseApprovalCurrentnessFactoryLive } from '../src/persistence/purchase-approval-currentness-persistence.ts';
import { PurchaseApprovalFinalBindingAuthorityLive } from '../src/persistence/purchase-approval-final-binding-authority.ts';
import { ProfileReconciliationOwnerVerifierUnavailableLive } from '../src/actions/resolve-profile-reconciliation.action.ts';
import {
  commerceCustomerContextCorsAllowedHeaders,
  commerceCustomerContextCorsAllowedMethods,
  commerceCustomerContextCorsAllowedOrigins,
  resolveCommerceCustomerContextShellOrigin,
} from './runtime-support.ts';

// <generated-governed-http-handler-imports>
import { addSavedAddressActionApiLive } from './add-saved-address-action-server.ts';
import { archiveCustomerGroupActionApiLive } from './archive-customer-group-action-server.ts';
import { archiveCustomerProfileActionApiLive } from './archive-customer-profile-action-server.ts';
import { assignCounterpartyPriceGroupActionApiLive } from './assign-counterparty-price-group-action-server.ts';
import { assignCustomerGroupActionApiLive } from './assign-customer-group-action-server.ts';
import { assignCustomerPriceGroupActionApiLive } from './assign-customer-price-group-action-server.ts';
import { attributeGuestRetailCustomerActionApiLive } from './attribute-guest-retail-customer-action-server.ts';
import { bindRetailPortalProfileActionApiLive } from './bind-retail-portal-profile-action-server.ts';
import { bootstrapCounterpartyAccessAdministratorActionApiLive } from './bootstrap-counterparty-access-administrator-action-server.ts';
import { changeCounterpartyPurchaseLimitActionApiLive } from './change-counterparty-purchase-limit-action-server.ts';
import { changeCustomerPaymentTermsActionApiLive } from './change-customer-payment-terms-action-server.ts';
import { changePrincipalPurchaseLimitOverrideActionApiLive } from './change-principal-purchase-limit-override-action-server.ts';
import { changeRetailPaymentTermPreferenceActionApiLive } from './change-retail-payment-term-preference-action-server.ts';
import { claimCounterpartyAccessInvitationActionApiLive } from './claim-counterparty-access-invitation-action-server.ts';
import { claimPortalEnrollmentTransitionActionApiLive } from './claim-portal-enrollment-transition-action-server.ts';
import { clearDefaultBillingAddressActionApiLive } from './clear-default-billing-address-action-server.ts';
import { clearDefaultDeliveryDestinationActionApiLive } from './clear-default-delivery-destination-action-server.ts';
import { commerceQuantityPolicyCurrentReadApiLive } from './commerce-quantity-policy-current-read-server.ts';
import { commerceQuantityResolutionReadApiLive } from './commerce-quantity-resolution-read-server.ts';
import { completePurchaseProposalBasisActionApiLive } from './complete-purchase-proposal-basis-action-server.ts';
import { consumeOrderPurchaseApprovalActionApiLive } from './consume-order-purchase-approval-action-server.ts';
import { consumePurchaseApprovalActionApiLive } from './consume-purchase-approval-action-server.ts';
import { counterpartyAccessInvitationReadReadApiLive } from './counterparty-access-invitation-read-read-server.ts';
import { counterpartyAllCustomerArchiveReadApiLive } from './counterparty-all-customer-archive-read-server.ts';
import { counterpartyAllOrderHistoryDetailReadApiLive } from './counterparty-all-order-history-detail-read-server.ts';
import { counterpartyAllOrderHistoryReadApiLive } from './counterparty-all-order-history-read-server.ts';
import { counterpartyCommerceAccessCheckReadApiLive } from './counterparty-commerce-access-check-read-server.ts';
import { counterpartyCommerceAccessDetailReadApiLive } from './counterparty-commerce-access-detail-read-server.ts';
import { counterpartyCommerceAccessListReadApiLive } from './counterparty-commerce-access-list-read-server.ts';
import { counterpartyCustomerGroupMembershipsReadApiLive } from './counterparty-customer-group-memberships-read-server.ts';
import { counterpartyOrderHistoryDetailReadApiLive } from './counterparty-order-history-detail-read-server.ts';
import { counterpartyOrderHistoryReadApiLive } from './counterparty-order-history-read-server.ts';
import { createApprovalHierarchyActionApiLive } from './create-approval-hierarchy-action-server.ts';
import { createCounterpartyAccessInvitationActionApiLive } from './create-counterparty-access-invitation-action-server.ts';
import { createCounterpartyPurchasingProfileActionApiLive } from './create-counterparty-purchasing-profile-action-server.ts';
import { createCustomerGroupActionApiLive } from './create-customer-group-action-server.ts';
import { createPurchaseProposalRevisionActionApiLive } from './create-purchase-proposal-revision-action-server.ts';
import { customerArchiveReadApiLive } from './customer-archive-read-server.ts';
import { customerGroupDetailReadApiLive } from './customer-group-detail-read-server.ts';
import { customerGroupHistoryReadApiLive } from './customer-group-history-read-server.ts';
import { customerGroupMembersReadApiLive } from './customer-group-members-read-server.ts';
import { customerPaymentTermEntitlementReadReadApiLive } from './customer-payment-term-entitlement-read-read-server.ts';
import { customerPriceGroupAssignmentReadReadApiLive } from './customer-price-group-assignment-read-read-server.ts';
import { customerPriceGroupResolutionReadApiLive } from './customer-price-group-resolution-read-server.ts';
import { customerProfileReadReadApiLive } from './customer-profile-read-read-server.ts';
import { customerProfileTradingGateReadApiLive } from './customer-profile-trading-gate-read-server.ts';
import { customerRecordVisibilityReadApiLive } from './customer-record-visibility-read-server.ts';
import { decidePurchaseApprovalRequestActionApiLive } from './decide-purchase-approval-request-action-server.ts';
import { deliveryDestinationResolutionReadApiLive } from './delivery-destination-resolution-read-server.ts';
import { effectiveCustomerGroupMembershipSetV1ReadApiLive } from './effective-customer-group-membership-set-v1-read-server.ts';
import { effectiveCustomerGroupMembershipsReadApiLive } from './effective-customer-group-memberships-read-server.ts';
import { ensureRetailCustomerProfileActionApiLive } from './ensure-retail-customer-profile-action-server.ts';
import { executePrivacyMeasureActionApiLive } from './execute-privacy-measure-action-server.ts';
import { grantCounterpartyCommerceAccessActionApiLive } from './grant-counterparty-commerce-access-action-server.ts';
import { guestAttributionStatusReadApiLive } from './guest-attribution-status-read-server.ts';
import { guestPaymentTermsResolutionReadApiLive } from './guest-payment-terms-resolution-read-server.ts';
import { invoiceRecipientResolutionReadApiLive } from './invoice-recipient-resolution-read-server.ts';
import { marketAffectedUseAssessmentReadApiLive } from './market-affected-use-assessment-read-server.ts';
import { marketBootstrapPolicyCurrentReadApiLive } from './market-bootstrap-policy-current-read-server.ts';
import { marketBootstrapResolutionReadApiLive } from './market-bootstrap-resolution-read-server.ts';
import { marketSubjectRestrictionsCurrentReadApiLive } from './market-subject-restrictions-current-read-server.ts';
import { migrateCounterpartyPriceGroupActionApiLive } from './migrate-counterparty-price-group-action-server.ts';
import { migrateCustomerPriceGroupActionApiLive } from './migrate-customer-price-group-action-server.ts';
import { openProfileReconciliationActionApiLive } from './open-profile-reconciliation-action-server.ts';
import { orderCommitmentApprovalEvidenceReadApiLive } from './order-commitment-approval-evidence-read-server.ts';
import { orderServiceApprovalEvidenceReadApiLive } from './order-service-approval-evidence-read-server.ts';
import { paymentTermAffectedUseAssessmentReadApiLive } from './payment-term-affected-use-assessment-read-server.ts';
import { paymentTermPolicyCurrentReadApiLive } from './payment-term-policy-current-read-server.ts';
import { paymentTermsResolutionReadApiLive } from './payment-terms-resolution-read-server.ts';
import { preparePurchaseProposalBasisActionApiLive } from './prepare-purchase-proposal-basis-action-server.ts';
import { pricingPurchaseContextVerificationReadApiLive } from './pricing-purchase-context-verification-read-server.ts';
import { privacyMeasureExecutionReadApiLive } from './privacy-measure-execution-read-server.ts';
import { profileReconciliationReadReadApiLive } from './profile-reconciliation-read-read-server.ts';
import { purchaseCurrencyPolicyCurrentReadApiLive } from './purchase-currency-policy-current-read-server.ts';
import { purchaseCurrencyResolutionReadApiLive } from './purchase-currency-resolution-read-server.ts';
import { purchaseLimitEvaluationReadApiLive } from './purchase-limit-evaluation-read-server.ts';
import { purchaseLimitPolicyReadReadApiLive } from './purchase-limit-policy-read-read-server.ts';
import { purchaseProposalBasisReadApiLive } from './purchase-proposal-basis-read-server.ts';
import { reactivateCustomerGroupActionApiLive } from './reactivate-customer-group-action-server.ts';
import { reactivateCustomerProfileActionApiLive } from './reactivate-customer-profile-action-server.ts';
import { recordPortalEnrollmentOutcomeActionApiLive } from './record-portal-enrollment-outcome-action-server.ts';
import { recoverRetailPortalProfileBindingActionApiLive } from './recover-retail-portal-profile-binding-action-server.ts';
import { removeCounterpartyPriceGroupActionApiLive } from './remove-counterparty-price-group-action-server.ts';
import { removeCustomerGroupActionApiLive } from './remove-customer-group-action-server.ts';
import { removeCustomerPaymentTermActionApiLive } from './remove-customer-payment-term-action-server.ts';
import { removeCustomerPriceGroupActionApiLive } from './remove-customer-price-group-action-server.ts';
import { removeSavedAddressActionApiLive } from './remove-saved-address-action-server.ts';
import { repeatCounterpartyOrderActionApiLive } from './repeat-counterparty-order-action-server.ts';
import { repeatOrderPreparationReadApiLive } from './repeat-order-preparation-read-server.ts';
import { repeatRetailOrderActionApiLive } from './repeat-retail-order-action-server.ts';
import { reroutePurchaseApprovalRequestActionApiLive } from './reroute-purchase-approval-request-action-server.ts';
import { resendCounterpartyAccessInvitationActionApiLive } from './resend-counterparty-access-invitation-action-server.ts';
import { reserveMarketRetirementActionApiLive } from './reserve-market-retirement-action-server.ts';
import { reservePaymentTermRetirementActionApiLive } from './reserve-payment-term-retirement-action-server.ts';
import { resolveProfileReconciliationActionApiLive } from './resolve-profile-reconciliation-action-server.ts';
import { retailAccessDecisionReadApiLive } from './retail-access-decision-read-server.ts';
import { retailOrderHistoryDetailReadApiLive } from './retail-order-history-detail-read-server.ts';
import { retailOrderHistoryReadApiLive } from './retail-order-history-read-server.ts';
import { retailPortalProfileBindingReadReadApiLive } from './retail-portal-profile-binding-read-read-server.ts';
import { retailPrincipalResolutionReadApiLive } from './retail-principal-resolution-read-server.ts';
import { retailPurchasingSubjectCurrentV1ReadApiLive } from './retail-purchasing-subject-current-v1-read-server.ts';
import { revalidateOrderPurchaseApprovalActionApiLive } from './revalidate-order-purchase-approval-action-server.ts';
import { revalidatePurchaseApprovalActionApiLive } from './revalidate-purchase-approval-action-server.ts';
import { revokeCounterpartyAccessInvitationActionApiLive } from './revoke-counterparty-access-invitation-action-server.ts';
import { revokeCounterpartyCommerceAccessActionApiLive } from './revoke-counterparty-commerce-access-action-server.ts';
import { revokeRetailPortalProfileBindingActionApiLive } from './revoke-retail-portal-profile-binding-action-server.ts';
import { savedAddressDefaultsReadApiLive } from './saved-address-defaults-read-server.ts';
import { savedAddressDetailReadApiLive } from './saved-address-detail-read-server.ts';
import { savedAddressListReadApiLive } from './saved-address-list-read-server.ts';
import { setDefaultBillingAddressActionApiLive } from './set-default-billing-address-action-server.ts';
import { setDefaultDeliveryDestinationActionApiLive } from './set-default-delivery-destination-action-server.ts';
import { startPortalEnrollmentActionApiLive } from './start-portal-enrollment-action-server.ts';
import { submitPurchaseApprovalRequestActionApiLive } from './submit-purchase-approval-request-action-server.ts';
import { suspendCustomerProfileActionApiLive } from './suspend-customer-profile-action-server.ts';
import { terminatePortalEnrollmentActionApiLive } from './terminate-portal-enrollment-action-server.ts';
import { triggerPurchaseApprovalActionApiLive } from './trigger-purchase-approval-action-server.ts';
import { updateCustomerGroupActionApiLive } from './update-customer-group-action-server.ts';
import { updateSavedAddressActionApiLive } from './update-saved-address-action-server.ts';
import { verifyEffectiveCustomerGroupMembershipSetV1ReadApiLive } from './verify-effective-customer-group-membership-set-v1-read-server.ts';
import { verifyRetailPurchasingSubjectCurrentV1ReadApiLive } from './verify-retail-purchasing-subject-current-v1-read-server.ts';
// </generated-governed-http-handler-imports>

import { microVerticalOperationAttributes } from '@app/shared-contracts';
import { commerceCustomerContextApi, commerceCustomerContextOperationContexts } from '../shared/api.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../shared/ultramodern-build.ts';

const databaseIdentitiesLive = makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]));

const commercePortalAuthPlatformEmailDeliveryLive = CommercePortalAuthPlatformEmailDeliveryLive(
  Effect.fn('CommercePortalAuth.submitPlatformEmail')(function* submitPortalEmail(
    transport: Parameters<CommercePortalAuthPlatformEmailSubmit>[0],
    from: Parameters<CommercePortalAuthPlatformEmailSubmit>[1],
    message: Parameters<CommercePortalAuthPlatformEmailSubmit>[2],
  ) {
    const delivery = yield* Layer.build(transport.deliveryLayer(from, message.to));
    const service = Context.get(delivery, EmailDeliveryService);
    return yield* service.send(message);
  }, Effect.scoped),
).pipe(Layer.provide(commercePortalAuthPlatformCryptoLive));

const workloadRejectedProblem = () => Effect.fail(commercePortalAuthVerificationForbiddenProblem);
const workloadUnavailableProblem = () => Effect.fail(commercePortalAuthVerificationUnavailableProblem);
const providerInvalidProblem = () => Effect.fail(commercePortalAuthVerificationInvalidProblem);
const providerRejectedProblem = () => Effect.fail(commercePortalAuthVerificationForbiddenProblem);
const providerUnavailableProblem = () => Effect.fail(commercePortalAuthVerificationUnavailableProblem);

const providerRequest = (request: CommercePortalAuthVerificationRequest) => {
  const base = {
    authenticationNamespaceId: request.authenticationNamespaceId,
    authenticationOperation: request.authenticationOperation,
    nonce: request.nonce,
    providerSubjectId: request.providerSubjectId,
    sessionRef: request.sessionRef,
    subjectType: request.subjectType,
    tenantId: request.tenantId,
  };
  return request.enrollmentAttemptId === undefined
    ? base
    : { ...base, enrollmentAttemptId: request.enrollmentAttemptId };
};

class AuthorizedVerificationRequest extends Context.Service<
  AuthorizedVerificationRequest,
  { readonly principal: TrustedPrincipalContext; readonly request: CommercePortalAuthVerificationRequest }
>()('@app/commerce-customer-context/api/AuthorizedVerificationRequest') {}

const sameProviderRequest = Schema.toEquivalence(VerifyExternalAuthenticationRequestSchema);
const verificationCallerLive = Layer.succeed(CommercePortalAuthVerificationCaller, {
  authorize: Effect.fn('CommercePortalAuthVerificationCaller.authorize')(function* authorize(
    input: CommercePortalAuthVerificationAuthorization,
  ) {
    const authorized = yield* Effect.serviceOption(AuthorizedVerificationRequest);
    if (Option.isNone(authorized)) {
      return yield* new CommercePortalAuthVerificationCallerUnavailable({
        reason: 'No authorized verification request is active',
      });
    }
    if (
      input.operation !== authorized.value.request.operation ||
      !sameProviderRequest(input, providerRequest(authorized.value.request))
    ) {
      return yield* new CommercePortalAuthVerificationCallerRejected({
        reason: 'The provider request differs from the authorized workload request',
      });
    }
    return yield* Effect.void;
  }),
});

/** Provider graph the configured portal realm installs; caller authority is request-scoped by the executor. */
export const commercePortalAuthVerificationProviderLive = CommercePortalAuthVerificationLive.pipe(
  Layer.provide(verificationCallerLive),
);

const executeCommerceVerification = Effect.fn('CommercePortalAuthVerificationHttp.execute')(
  function* executeCommerceVerification(
    payload: CommercePortalAuthVerificationRequest,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    if (request.headers['authorization'] === undefined) {
      return yield* Effect.fail(commercePortalAuthVerificationUnauthorizedProblem);
    }
    const authority = yield* CommercePortalAuthVerificationWorkloadAuthorization;
    const principal = yield* authority
      .authorize({
        authorization: Redacted.make(request.headers['authorization']),
        request: payload,
        requestCorrelation: request.headers['x-correlation-id'],
      })
      .pipe(
        Effect.catchTags({
          CommercePortalAuthVerificationWorkloadRejected: workloadRejectedProblem,
          CommercePortalAuthVerificationWorkloadUnavailable: workloadUnavailableProblem,
        }),
      );

    const verification = yield* CommercePortalAuthVerificationService;
    return yield* verification.verifyExternalAuthentication(providerRequest(payload)).pipe(
      Effect.provideService(AuthorizedVerificationRequest, {
        principal: Object.freeze({ ...principal }),
        request: Object.freeze({ ...payload }),
      }),
      Effect.catchTags({
        CommercePortalAuthVerificationCallerRejected: providerRejectedProblem,
        CommercePortalAuthVerificationCallerUnavailable: providerUnavailableProblem,
        CommercePortalAuthVerificationInvalidRequest: providerInvalidProblem,
      }),
    );
  },
);

/** Full gate retained on every invocation, including direct internal execution. */
export const commercePortalAuthVerificationHttpExecutorLive = Layer.succeed(
  CommercePortalAuthVerificationHttpExecutor,
  { execute: executeCommerceVerification },
);

const commercePortalAuthRecoveryStoreLive = CommercePortalAuthRecoveryStoreLive.pipe(
  Layer.provideMerge(CommercePortalAuthDatabaseLive),
);
const commercePortalAuthEmailDeliveryLive = CommercePortalAuthEmailDeliveryLive.pipe(
  Layer.provide(CommercePortalAuthTransactionalEmailLive),
  Layer.provideMerge(commercePortalAuthRecoveryStoreLive),
);

/** Installed only by portal-enabled composition; delivery and platform crypto remain explicit inputs. */
export const commercePortalAuthProviderLive = CommercePortalAuthLive.pipe(
  Layer.provideMerge(commercePortalAuthEmailDeliveryLive),
);

/**
 * Everything the four portal-auth HttpApi groups read, composed once. `api/index.ts` is the
 * sanctioned composition root for this vertical: every provider layer is imported from the module
 * that declares it, and `portal-auth/deployment.ts` contributes only the host platform crypto. The
 * tiers below are ordered bottom-up so every layer sees the services the tier beneath it published
 * — `Layer.mergeAll` builds its operands in parallel and would not satisfy a dependency declared
 * beside it.
 */
const commercePortalAuthProviderRealmLive = commercePortalAuthProviderLive.pipe(
  Layer.provideMerge(commercePortalAuthPlatformCryptoLive),
);
const commercePortalAuthRealmPortsLive = Layer.mergeAll(
  CommercePortalAuthAuditLive,
  CommercePortalAuthServiceLive,
  CommercePortalAuthSessionProviderLive,
  CommercePortalAuthSessionStoreLive,
  CommercePortalAuthSessionReaderLive,
  CommercePortalAuthStepUpChallengeStoreLive,
  CommercePortalAuthMfaProviderLive,
  CommercePortalAuthMfaStepUpCodeVerifierLive,
  CommercePortalAuthRecoveryProviderLive,
  CommercePortalAuthRecoveryRateLimitLive,
  // The recovery service reads this authority, so it is published one tier beneath it, beside the
  // owner store it is built from rather than alongside its own consumer.
  CommercePortalAuthRecoveryReconciliationServiceLive,
  CommercePortalAuthStepUpHttpProviderUnavailableLive,
).pipe(Layer.provideMerge(commercePortalAuthProviderRealmLive));
const commercePortalAuthLifecycleLive = CommercePortalAuthSessionLifecycleLive.pipe(
  Layer.provideMerge(commercePortalAuthRealmPortsLive),
);
const commercePortalAuthRealmServicesLive = Layer.mergeAll(
  CommercePortalAuthMfaServiceLive,
  CommercePortalAuthRecoveryServiceLive,
  CommercePortalAuthStepUpLive,
).pipe(Layer.provideMerge(commercePortalAuthLifecycleLive));

const actionAuthorizationPreflightDatabaseWithCoreLive = ActionAuthorizationPreflightDatabaseLive.pipe(
  Layer.provideMerge(CorePersistenceLive),
);
/**
 * The vertical's own governed transaction seam. The Enrollment Attempt journal is Commerce business
 * state, never provider state, so it is never opened on the portal-auth provider pool.
 */
const commerceEnrollmentOwnerTransactionRunnerProductionLive = CommerceEnrollmentOwnerTransactionRunnerLive.pipe(
  Layer.provide(actionAuthorizationPreflightDatabaseWithCoreLive),
);
const commercePortalAuthAccountLookupRealmLive = CommercePortalAuthAccountLookupLive.pipe(
  Layer.provide(CommercePortalAuthDatabaseLive),
);
const commercePortalAuthAccountCreationReconciliationRealmLive =
  CommercePortalAuthAccountCreationReconciliationLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        CommercePortalAuthDatabaseLive,
        CommercePortalAuthAccountCreationProviderLive.pipe(Layer.provide(commercePortalAuthProviderRealmLive)),
      ),
    ),
    Layer.provide(Layer.mergeAll(CommercePortalAuthConfigLive, commercePortalAuthPlatformEmailDeliveryLive)),
  );
/**
 * The private provider account-creation capability the enrollment start route dispatches through.
 * It is a two-party operation and both parties are separate visible requirements here: the owner
 * half is the Attempt-scoped enrollment proof, which authorizes the exact `provider.account.create`
 * invocation the Attempt already claimed, and the provider half is the realm's own Better Auth
 * instance and account directory. A composition that installs one without the other cannot build.
 */
const commercePortalAuthAccountCreationLive = CommercePortalAuthAccountCreationServiceLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      CommercePortalAuthAccountCreationGatewayLive.pipe(
        Layer.provide(
          Layer.mergeAll(CommercePortalAuthAccountCreationProviderLive, commercePortalAuthAccountLookupRealmLive),
        ),
      ),
      CommerceEnrollmentProofServiceLive.pipe(
        Layer.provide(commerceEnrollmentOwnerTransactionRunnerProductionLive),
        Layer.provide(DatabaseConfigLive),
      ),
    ),
  ),
);

/**
 * The installed realm, with the two operator configurations it is built from left as visible
 * requirements: the Better Auth realm values and the transactional email transport credentials. A
 * host that opted in supplies both; the fail-closed realm in `portal-auth/realm-unavailable.ts` is
 * what a host that opted out gets instead.
 *
 * Account creation is composed on top of the session-facing services rather than merged beside
 * them because it is built from the very Better Auth instance those services publish.
 */
export const commercePortalAuthRealmLive = Layer.mergeAll(
  commercePortalAuthAccountCreationLive,
  commercePortalAuthVerificationProviderLive.pipe(
    Layer.provide(
      CommerceEnrollmentProofServiceLive.pipe(
        Layer.provide(commerceEnrollmentOwnerTransactionRunnerProductionLive),
        Layer.provide(DatabaseConfigLive),
      ),
    ),
  ),
).pipe(Layer.provideMerge(commercePortalAuthRealmServicesLive));

const commerceCustomerContextReadinessLayer = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'foundation',
  (handlers) =>
    handlers.handle('readiness', () =>
      Effect.succeed({
        checks: {
          api: 'ready' as const,
          moduleFederation: 'ready' as const,
          ssr: 'ready' as const,
          translations: 'ready' as const,
        },
        marker: ultramodernApiMarker,
        status: 'ready' as const,
        versionSkew: 'none' as const,
      }).pipe(
        Effect.withSpan('ultramodern.api.commerceCustomerContext.readiness', {
          attributes: microVerticalOperationAttributes(commerceCustomerContextOperationContexts.readiness),
          kind: 'server',
        }),
      ),
    ),
);

declare const ULTRAMODERN_SHELL_ORIGIN: unknown;

const readShellOrigin = () => {
  try {
    return resolveCommerceCustomerContextShellOrigin(
      Schema.is(Schema.String)(ULTRAMODERN_SHELL_ORIGIN) ? ULTRAMODERN_SHELL_ORIGIN : undefined,
    );
  } catch {
    return resolveCommerceCustomerContextShellOrigin();
  }
};

const runtimeObservabilityLive = Layer.mergeAll(
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  Layer.effect(Tracer.Tracer, Tracer.Tracer),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
);
const tenantModuleStateServiceLive = TenantModuleStateServiceLive.pipe(Layer.provide(CorePersistenceLive));
const moduleStateGateLive = ModuleStateGateLive.pipe(Layer.provide(tenantModuleStateServiceLive));
const operationalScopeResolverLive = OperationalScopeResolverLive.pipe(
  Layer.provide(Layer.mergeAll(CorePersistenceLive, ContextAccessLive)),
);
const moduleEntrypointGatewayLive = ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleStateGateLive));
const compositionHttpClientLive = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
);
const compositionSourceLive = ActiveApplicationCompositionSourceLive.pipe(Layer.provide(compositionHttpClientLive));
const activeApplicationCompositionLive = ActiveApplicationCompositionConfigLive.pipe(
  Layer.provide(compositionSourceLive),
);

const productionOwnerRuntimeServicesLive = commerceCustomerContextOwnerRuntimeServicesLive.pipe(
  Layer.provide(Layer.mergeAll(CorePersistenceLive, ContextAccessLive)),
  Layer.provide(profileReconfirmationPolicyUnavailableLive),
);
const productionOwnerAuthorizationOverlayLive = commerceCustomerContextOwnerAuthorizationOverlayLive.pipe(
  Layer.provide(productionOwnerRuntimeServicesLive),
);
const productionPurchaseLimitPersistenceLive = purchaseLimitPersistenceLayer.pipe(
  Layer.provide(
    purchaseLimitEvaluationCurrentnessLive.pipe(
      Layer.provide(activeApplicationCompositionLive),
      Layer.provide(productionOwnerRuntimeServicesLive),
      Layer.provide(ContextAccessLive),
    ),
  ),
  Layer.provide(profileCounterpartyRoleEligibilityResolverFactoryLive),
);
// Keep the authoritative Currentness port visible to approval Actions as well as to the
// Purchase-Limit source factory. The unavailable leaf is intentionally never part of production
// composition.
const productionPurchaseLimitCurrentnessLive = Layer.mergeAll(
  productionPurchaseLimitPersistenceLive,
  purchaseLimitEvaluationCurrentnessLive.pipe(
    Layer.provide(activeApplicationCompositionLive),
    Layer.provide(productionOwnerRuntimeServicesLive),
    Layer.provide(ContextAccessLive),
  ),
);
const readRuntimeCoreLive = ReadRuntimeLive.pipe(
  Layer.provide(
    Layer.mergeAll(CorePersistenceLive, ContextAccessLive, moduleEntrypointGatewayLive, operationalScopeResolverLive),
  ),
);

/**
 * Publish the request's owner capability with its matching preflight/execution. The Action wrapper
 * still installs a fresh pair for each invocation, so concurrent Actions never share prepared evidence.
 */
const commerceEnrollmentPreparedOwnerCapabilityLive = Layer.effect(
  CommerceEnrollmentPreparedOwnerCapability,
  CommerceEnrollmentPreparedOwnerExecutionService.pipe(Effect.map((execution) => execution.capability)),
).pipe(Layer.provideMerge(commerceEnrollmentPreparedOwnerExecutionLive));

/** Each Action owns its prepared evidence and runtime factory; persistence stays deployment-scoped. */
const commerceEnrollmentActionRuntimeLive: Layer.Layer<
  ActionRuntime,
  never,
  | ActionRuntime
  | ActionAuthorizationPreflight
  | CommerceEnrollmentOwnerTransitionPreparation
  | ActiveApplicationCompositionService
  | Layer.Services<ReturnType<typeof makeActionRuntimeLive>>
> = Layer.effect(
  ActionRuntime,
  Effect.gen(function* commerceEnrollmentActionRuntime() {
    const bindingAuthority = yield* RetailEnrollmentBindingAuthority;
    const existingRuntime = yield* ActionRuntime;
    const existingPreflight = yield* ActionAuthorizationPreflight;
    const preparation = yield* CommerceEnrollmentOwnerTransitionPreparation;
    const compositions = yield* ActiveApplicationCompositionService;
    const dependencies = yield* Effect.context<Layer.Services<ReturnType<typeof makeActionRuntimeLive>>>();
    const runAction: ActionRuntimeService['runAction'] = (input) =>
      Effect.scoped(
        Effect.gen(function* runEnrollmentAwareAction() {
          const scope = yield* Effect.scope;
          const executionContext = yield* Layer.buildWithScope(
            Layer.fresh(commerceEnrollmentPreparedOwnerExecutionLive),
            scope,
          ).pipe(Effect.provideService(CommerceEnrollmentOwnerTransitionPreparation, preparation));
          const execution = Context.get(executionContext, CommerceEnrollmentPreparedOwnerExecutionService);
          const retailParty = yield* preparedRetailPartyResolution.pipe(
            Effect.provideService(ActiveApplicationCompositionService, compositions),
          );
          const binding = prepareRetailEnrollmentBinding(bindingAuthority);
          yield* Effect.addFinalizer(() => Effect.sync(binding.clear));
          const preflight = composeActionAuthorizationPreflights([
            execution.preflight,
            binding.preflight,
            retailParty.preflight,
            existingPreflight,
          ]);
          const runtimeContext = yield* Layer.buildWithScope(
            Layer.fresh(makeActionRuntimeLive(ultramodernDeliveryUnit)),
            scope,
          ).pipe(Effect.provideContext(Context.add(dependencies, ActionAuthorizationPreflight, preflight)));
          return yield* Context.get(runtimeContext, ActionRuntime)
            .runAction(input)
            .pipe(
              Effect.provideService(CommerceEnrollmentPreparedOwnerCapability, execution.capability),
              Effect.provideService(RetailEnrollmentBindingCapability, binding.capability),
              Effect.provideService(PartyRegistryRetailPartyResolverFactory, retailParty.factory),
            );
        }),
      );
    return { ...existingRuntime, runAction };
  }),
);

const actionRuntimeDependenciesLive = Layer.mergeAll(
  activeApplicationCompositionLive,
  actionAuthorizationPreflightDatabaseWithCoreLive,
  ActionRepositoryLive,
  ActionPermissionLive,
  ContextAccessLive,
  moduleStateGateLive,
  moduleEntrypointGatewayLive,
  operationalScopeResolverLive,
);
const actionRuntimeCoreLive = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
  Layer.provide(commerceCustomerContextInvitationClaimActionAuthorizationPreflightLive),
  Layer.provide(actionRuntimeDependenciesLive),
);
/** Real owner preflight, assembled independently so runtime requirements remain explicit. */
const invitationClaimPreflightWithOwnerServicesLive =
  commerceCustomerContextInvitationClaimActionAuthorizationPreflightLive.pipe(
    Layer.provide(actionRuntimeDependenciesLive),
    Layer.provide(productionOwnerRuntimeServicesLive),
    Layer.provide(Layer.mergeAll(DatabaseConfigLive, databaseIdentitiesLive, commercePortalAuthPlatformCryptoLive)),
  );
/**
 * Fail-closed until a Commerce owner preparation port is installed: no governed Action may proceed
 * on a claimed owner payload without owner evidence. Composing the wrapper here — rather than
 * leaving it exported and unused — is what puts `CommerceEnrollmentPreparedOwnerCapability` in the
 * context of the two mounted prepared-owner enrollment Actions.
 */
const commerceEnrollmentOwnerTransitionPreparationUnavailableLive = Layer.succeed(
  CommerceEnrollmentOwnerTransitionPreparation,
  { prepare: () => Effect.succeed({ outcome: 'unavailable' as const }) },
);
/** The realm a host that opted in gets, with both operator configurations supplied. */
const portalAuthConfiguredRuntimeLive = commercePortalAuthRealmLive.pipe(
  Layer.provideMerge(CommercePortalAuthConfigLive),
  // The deployment's installed mail transport; a test composition provides its own.
  Layer.provide(commercePortalAuthPlatformEmailDeliveryLive),
);

/**
 * The Commerce portal realm is opt-in. A deployment that supplied no `COMMERCE_PORTAL_AUTH_*`
 * value — the Node and workerd artifact proofs among them — gets the fail-closed realm instead of
 * the provider graph, so readiness and every business route still serve while the five portal
 * groups answer the owner's retryable 503. A deployment that opted in gets the real layers and any
 * error in them stays an error: opting in means configuring the realm completely.
 */
const selectPortalAuthRuntimeLive = (
  configured: boolean,
): Layer.Layer<CommercePortalAuthHandlerServices, Layer.Error<typeof portalAuthConfiguredRuntimeLive>> =>
  configured ? portalAuthConfiguredRuntimeLive : commercePortalAuthRealmUnavailableLive([readShellOrigin()]);

const deploymentPortalAuthRuntimeLive = Layer.unwrap(
  optionalCommercePortalAuthConfig.pipe(
    Effect.map((configuration) => selectPortalAuthRuntimeLive(Option.isSome(configuration))),
  ),
);
/**
 * The Core identity transport and the configuration it is built from, published together: the
 * enrollment subject resolver reads the configuration to derive its own per-Attempt correlation,
 * and the client is the only thing that may present the service credential.
 */
const commerceCoreIdentityRealmLive = CommerceCoreIdentityClientLive.pipe(
  Layer.provideMerge(CommerceCoreIdentityClientConfigLive),
);
const deploymentCustomerAuthorityLive = Layer.unwrap(
  coreIdentityTransportConfigured.pipe(
    Effect.map((configured) =>
      configured
        ? commerceCustomerAuthorityLive.pipe(
            Layer.provide(Layer.mergeAll(commerceCoreIdentityRealmLive, commercePortalAuthPlatformCryptoLive)),
          )
        : commerceCustomerAuthorityUnavailableLive,
    ),
  ),
);
const deploymentRetailEnrollmentBindingAuthorityLive = Layer.unwrap(
  Effect.all({ core: coreIdentityTransportConfigured, realm: portalAuthRealmConfigured }, { concurrency: 2 }).pipe(
    Effect.map(({ core, realm }) =>
      core && realm
        ? retailEnrollmentBindingAuthorityLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                commerceCoreIdentityRealmLive,
                commerceEnrollmentOwnerTransactionRunnerProductionLive,
                commercePortalAuthAccountLookupRealmLive.pipe(Layer.provide(CommercePortalAuthConfigLive)),
              ),
            ),
          )
        : Layer.succeed(RetailEnrollmentBindingAuthority, null),
    ),
  ),
);
const commerceEnrollmentPreparationSubjectRealmLive = CommerceEnrollmentPreparationSubjectResolverLive.pipe(
  Layer.provide(Layer.mergeAll(commerceEnrollmentOwnerTransactionRunnerProductionLive, commerceCoreIdentityRealmLive)),
);
const commerceEnrollmentOwnerTransitionPreparationRealmLive = commerceEnrollmentOwnerTransitionPreparationLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      commerceEnrollmentOwnerTransactionRunnerProductionLive,
      commercePortalAuthAccountLookupRealmLive.pipe(Layer.provide(CommercePortalAuthConfigLive)),
      commercePortalAuthAccountCreationReconciliationRealmLive,
      commerceEnrollmentPreparationSubjectRealmLive,
    ),
  ),
);
/**
 * The enrollment owner authority needs both halves of the realm: the portal provider that owns the
 * account-creation transition, and the Core identity transport that establishes the Principal Auth
 * Binding every later Retail transition is bound to. A deployment missing either one keeps the
 * fail-closed leaf, so no governed Action can proceed on a claimed owner payload without owner
 * evidence — and a Retail transition can never be vouched for against a Principal this deployment
 * has no way to establish.
 */
const selectEnrollmentOwnerPreparationLive = (
  configured: boolean,
): Layer.Layer<
  CommerceEnrollmentOwnerTransitionPreparation,
  Layer.Error<typeof commerceEnrollmentOwnerTransitionPreparationRealmLive>,
  Layer.Services<typeof commerceEnrollmentOwnerTransitionPreparationRealmLive>
> =>
  configured
    ? commerceEnrollmentOwnerTransitionPreparationRealmLive
    : commerceEnrollmentOwnerTransitionPreparationUnavailableLive;
const deploymentEnrollmentOwnerPreparationLive = Layer.unwrap(
  Effect.all(
    {
      // Two independent deployment configuration reads; neither reaches a shared resource.
      coreIdentity: coreIdentityTransportConfigured,
      realm: portalAuthRealmConfigured,
    },
    { concurrency: 2 },
  ).pipe(Effect.map(({ coreIdentity, realm }) => selectEnrollmentOwnerPreparationLive(realm && coreIdentity))),
);
/**
 * Convergence for an uncertain Commerce enrollment write is an exact read of the original
 * invocation: the Action runtime answers whether it committed, and the Core identity transport
 * answers whether the retained Principal Auth Binding for that subject is the one this invocation
 * produced. The transport is optional in exactly the way the portal realm is — a deployment that
 * named neither `COMMERCE_CORE_IDENTITY_*` value never opted in and keeps the retryable refusal,
 * and one that named only a part of it is a misconfiguration that must not take the Action runtime
 * down, so it is read here the same way the realm is.
 */
const commerceEnrollmentCommitResolutionRealmLive = CommerceEnrollmentCommitResolutionServiceLive.pipe(
  Layer.provide(commerceCoreIdentityRealmLive),
);
const deploymentEnrollmentCommitResolutionLive = Layer.unwrap(
  optionalCommerceCoreIdentityClientConfig.pipe(
    Effect.map((configuration) =>
      Option.isSome(configuration)
        ? commerceEnrollmentCommitResolutionRealmLive
        : commerceEnrollmentCommitResolutionUnavailableLive,
    ),
    Effect.catchTag('CommerceCoreIdentityClientConfigError', (failure) =>
      Effect.annotateLogs(
        Effect.logWarning('Commerce Core identity transport is unreadable; enrollment convergence fails closed'),
        { reason: failure.reason },
      ).pipe(Effect.as(commerceEnrollmentCommitResolutionUnavailableLive)),
    ),
  ),
);
/**
 * The enrollment continuation and the owner-effect registry it dispatches through. A journey only
 * runs where both halves of the realm exist: the account directory the portal transition is
 * reconciled against, and the Core identity transport every later transition's Principal is bound
 * to. A deployment missing either one installs the fail-closed leaves, so the start route still
 * serves and the Attempt simply stops where that route left it.
 */
const commerceEnrollmentOwnerEffectRegistryRealmLive = CommerceEnrollmentOwnerEffectRegistryLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      ContextAccessLive,
      profileRetailPermissionReaderFactoryLive.pipe(Layer.provide(ContextAccessLive)),
      commercePortalAuthAccountLookupRealmLive.pipe(Layer.provide(CommercePortalAuthConfigLive)),
      commercePortalAuthAccountCreationReconciliationRealmLive,
      commerceCoreIdentityRealmLive,
      // The two Commerce-owned Retail transitions reconcile a lost Action response by reading the
      // Commerce owner itself, so the deployed registry is handed the same owner transaction runner
      // every other owner phase opens its transactions through.
      commerceEnrollmentOwnerTransactionRunnerProductionLive,
    ),
  ),
);
const commerceEnrollmentContinuationRealmLive = CommerceEnrollmentContinuationLive(ultramodernApiMarker).pipe(
  Layer.provide(activeApplicationCompositionLive),
  Layer.provide(
    Layer.mergeAll(
      commerceEnrollmentOwnerTransactionRunnerProductionLive,
      commerceEnrollmentOwnerEffectRegistryRealmLive,
      commerceEnrollmentPreparationSubjectRealmLive,
    ),
  ),
);
const deploymentEnrollmentContinuationLive = Layer.unwrap(
  Effect.all(
    {
      // Two independent deployment configuration reads; neither reaches a shared resource.
      coreIdentity: coreIdentityTransportConfigured,
      realm: portalAuthRealmConfigured,
    },
    { concurrency: 2 },
  ).pipe(
    Effect.map(({ coreIdentity, realm }) =>
      realm && coreIdentity ? commerceEnrollmentContinuationRealmLive : commerceEnrollmentContinuationUnavailableLive,
    ),
  ),
);
/**
 * The provider account directory the Existing-account journey's start is verified against. It is
 * the same narrow lookup the owner reconciler reads — one yes/no about one address — and a
 * deployment without the realm has no directory to answer from, so it refuses retryably.
 */
const commercePortalAuthAccountDirectoryUnavailable = () =>
  Effect.fail(
    new CommercePortalAuthAccountCreationUnavailable({
      reason: 'The Commerce portal account directory is not installed in this deployment',
    }),
  );
const commercePortalAuthAccountLookupUnavailableLive = Layer.succeed(CommercePortalAuthAccountLookupService, {
  existsByEmail: commercePortalAuthAccountDirectoryUnavailable,
  existsByProviderSubject: commercePortalAuthAccountDirectoryUnavailable,
  subjectForOwnerInvocation: commercePortalAuthAccountDirectoryUnavailable,
  verifiedEmailForOwnerInvocation: commercePortalAuthAccountDirectoryUnavailable,
});
const deploymentEnrollmentAccountLookupLive = Layer.unwrap(
  portalAuthRealmConfigured.pipe(
    Effect.map((realm) =>
      realm
        ? commercePortalAuthAccountLookupRealmLive.pipe(Layer.provide(CommercePortalAuthConfigLive))
        : commercePortalAuthAccountLookupUnavailableLive,
    ),
  ),
);
/** The owner preflight remains an explicit input to the enrollment-aware runtime. */
const actionRuntimeAwaitingOwnerPreflight = commerceEnrollmentActionRuntimeLive.pipe(
  Layer.provide(deploymentRetailEnrollmentBindingAuthorityLive.pipe(Layer.provide(DatabaseConfigLive))),
  Layer.provideMerge(activeApplicationCompositionLive),
  Layer.provideMerge(ContextAccessLive),
  Layer.provideMerge(PurchaseApprovalFinalBindingAuthorityLive.pipe(Layer.provide(activeApplicationCompositionLive))),
  Layer.provide(Layer.mergeAll(actionRuntimeCoreLive, actionRuntimeDependenciesLive)),
  Layer.provideMerge(commerceEnrollmentPreparedOwnerCapabilityLive),
  Layer.provideMerge(productionOwnerRuntimeServicesLive),
  Layer.provideMerge(productionOwnerAuthorizationOverlayLive),
  Layer.provideMerge(productionPurchaseLimitCurrentnessLive),
  Layer.provideMerge(
    purchaseApprovalCurrentnessFactoryLive.pipe(Layer.provide(profileCounterpartyRoleEligibilityResolverFactoryLive)),
  ),
  // Scoped owner factories execute after receiving; their declared Crypto requirement must remain
  // visible in the runtime context, exactly as for the Read runtime.
  Layer.provideMerge(commercePortalAuthPlatformCryptoLive),
  Layer.provide(Layer.mergeAll(DatabaseConfigLive, databaseIdentitiesLive)),
);
const actionRuntimeAwaitingOwnerPreparation = actionRuntimeAwaitingOwnerPreflight.pipe(
  Layer.provide(invitationClaimPreflightWithOwnerServicesLive),
);
/** Deployment composition seam. External owner ports remain visible requirements here. */
const commerceCustomerContextActionRuntime = actionRuntimeAwaitingOwnerPreparation.pipe(
  Layer.provide(deploymentEnrollmentOwnerPreparationLive.pipe(Layer.provide(DatabaseConfigLive))),
);
/** Deployment composition seam. External owner ports remain visible requirements here. */
const commerceCustomerContextReadRuntime = readRuntimeCoreLive.pipe(
  Layer.provideMerge(activeApplicationCompositionLive),
  Layer.provideMerge(productionOwnerRuntimeServicesLive),
  Layer.provideMerge(productionOwnerAuthorizationOverlayLive),
  Layer.provideMerge(productionPurchaseLimitCurrentnessLive),
  Layer.provide(Layer.mergeAll(DatabaseConfigLive, databaseIdentitiesLive)),
  // Scoped owner factories execute after receiving; their declared ContextAccess/Crypto
  // requirements must remain visible alongside the Read runtime's captured gate services.
  Layer.provideMerge(Layer.mergeAll(ContextAccessLive, commercePortalAuthPlatformCryptoLive)),
);
const configuredProductionExternalPortsLive = commerceCustomerContextProductionExternalPortsLive.pipe(
  Layer.provide(activeApplicationCompositionLive),
);
export const commerceCustomerContextInvitationClaimPreflightLive = invitationClaimPreflightWithOwnerServicesLive.pipe(
  Layer.provide(configuredProductionExternalPortsLive),
);
const productionActionRuntimeLive = commerceCustomerContextActionRuntime.pipe(
  Layer.provideMerge(configuredProductionExternalPortsLive),
  Layer.provideMerge(ProfileReconciliationOwnerVerifierUnavailableLive),
);

/**
 * The very Action runtime a deployment mounts, with the enrollment owner preparation authority
 * still a visible requirement instead of the one the ambient environment selects.
 *
 * That authority is what lets a governed Action proceed on a claimed owner payload, and the
 * deployment picks it from `COMMERCE_PORTAL_AUTH_*` and `COMMERCE_CORE_IDENTITY_*`. Leaving it in
 * the requirements is the same choice the portal realm is given as a parameter of
 * `makeCommerceCustomerContextApiRuntime`: the deployment still decides which authority it
 * installs, and each side of the decision stays provable without a process-global environment.
 */
export const commerceCustomerContextActionRuntimeAwaitingOwnerPreflight: Layer.Layer<
  ActionRuntime,
  Layer.Error<typeof productionActionRuntimeLive>,
  CommerceEnrollmentOwnerTransitionPreparation | ActionAuthorizationPreflight
> = actionRuntimeAwaitingOwnerPreflight.pipe(
  Layer.provideMerge(configuredProductionExternalPortsLive),
  Layer.provideMerge(ProfileReconciliationOwnerVerifierUnavailableLive),
);
export const commerceCustomerContextActionRuntimeAwaitingOwnerPreparation =
  commerceCustomerContextActionRuntimeAwaitingOwnerPreflight.pipe(
    Layer.provide(commerceCustomerContextInvitationClaimPreflightLive),
  );
const productionReadRuntimeLive = commerceCustomerContextReadRuntime.pipe(
  Layer.provideMerge(configuredProductionExternalPortsLive),
);

const redemptionDatabaseLive = GovernedGatewayAssertionRedemptionDatabaseLive.pipe(
  Layer.provide(PgClient.layerFrom(gatewayAssertionRedemptionPgClient)),
  Layer.provide(Reactivity.layer),
  Layer.provide(DatabaseConfigLive),
);
export const configuredGatewayAssertionRedemptionLive = GovernedGatewayAssertionRedemptionLive.pipe(
  Layer.provide(redemptionDatabaseLive),
);

type CommerceCustomerContextApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<ReadRuntime, Layer.Error<typeof productionReadRuntimeLive>>,
  actionRuntime: Layer.Layer<ActionRuntime, Layer.Error<typeof productionActionRuntimeLive>>,
  gatewayAssertionRedemption: Layer.Layer<
    GatewayAssertionRedemptionService,
    Layer.Error<typeof configuredGatewayAssertionRedemptionLive>
  >,
  /**
   * The optional Commerce portal realm: the installed provider graph for a host that opted in, or
   * the fail-closed realm for one that did not. It is a parameter rather than a fixed import so the
   * choice stays a deployment decision and each side of it is provable without a process-global
   * environment.
   */
  portalAuthRuntime: Layer.Layer<
    CommercePortalAuthHandlerServices,
    Layer.Error<typeof deploymentPortalAuthRuntimeLive>
  >,
  /**
   * The verification material the audience-bound gateway principal verifier reads. It is the
   * deployment's own configuration rather than an ambient environment read, so a caller that
   * assembles this runtime supplies the issuer and keys the Bearer assertions it will accept are
   * verified against. An empty layer leaves the process configuration in place.
   */
  gatewayPrincipalVerification: Layer.Layer<never>,
  /** The native database configuration shared by the enrollment services this root assembles. */
  databaseConfiguration: Layer.Layer<DatabaseConfig, Layer.Error<typeof DatabaseConfigLive>>,
  /** The native context authorization used by the enrollment owner Actions. */
  contextAccess: Layer.Layer<ContextAccess>,
];

export type CommerceCustomerContextApiRuntime = EffectBffDefinition<typeof commerceCustomerContextApi> &
  EffectBffRuntime<typeof commerceCustomerContextApi>;

export const makeCommerceCustomerContextApiRuntime = (
  ...args: CommerceCustomerContextApiRuntimeArguments
): CommerceCustomerContextApiRuntime => {
  const [
    governedReadRuntimeLive,
    governedActionRuntimeLive,
    gatewayAssertionRedemption,
    portalAuthRuntimeLive,
    gatewayVerification,
    databaseConfiguration,
    contextAccess,
  ] = args;
  const actionPrincipalVerifierLive = GovernedActionPrincipalVerifierLive.pipe(
    Layer.provide(governedActionRuntimeLive),
  );
  /**
   * Owner services the portal groups read beside the realm: enrollment convergence, continuation and
   * account lookup, the customer authority, and the owner transaction runner the invitation claim and
   * enrollment start dispatch their governed Actions through.
   */
  const ownerTransactionRunnerLive = commerceEnrollmentOwnerTransactionRunnerProductionLive.pipe(
    GovernedReadLayer.provide(databaseConfiguration),
  );
  const portalOwnerServicesLive = Layer.mergeAll(
    portalAuthRuntimeLive,
    // The enrollment convergence capability is installed beside the Action runtime it reads: an
    // uncertain enrollment write is converged from the original invocation, never re-dispatched.
    deploymentEnrollmentCommitResolutionLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    governedActionRuntimeLive,
    // The start route commits the Attempt and account, then advances the journey inside the request;
    // durable recovery of halted Attempts is supervised by the owner host, not this handler tree.
    deploymentEnrollmentContinuationLive.pipe(GovernedReadLayer.provide(databaseConfiguration)),
    // The Existing-account journey creates no account, so its start verifies the presented one
    // exists here instead of claiming a provider transition its journey never declares.
    deploymentEnrollmentAccountLookupLive,
    // Invitation claims digest the one-time secret and dispatch an owner Action in the same transaction.
    commercePortalAuthPlatformCryptoLive,
    deploymentCustomerAuthorityLive.pipe(Layer.provide(Layer.mergeAll(contextAccess, ownerTransactionRunnerLive))),
    contextAccess,
    moduleEntrypointGatewayLive.pipe(Layer.provide(databaseConfiguration)),
    ownerTransactionRunnerLive,
  ).pipe(Layer.provideMerge(activeApplicationCompositionLive));
  /** The trusted provider verification route: workload gate, exact request delegation, realm reader. */
  const verificationRouteServicesLive = Layer.mergeAll(
    commercePortalAuthVerificationHttpExecutorLive,
    commercePortalAuthVerificationWorkloadAuthorizationLive,
    CommercePortalAuthVerificationWorkloadGrantConfigurationLive,
    portalAuthRuntimeLive,
  );
  const apiHandlerGroupsLive = Layer.mergeAll(
    portalAuthSessionApiLive.pipe(GovernedReadLayer.provide(portalOwnerServicesLive)),
    portalAuthMfaApiLive.pipe(GovernedReadLayer.provide(portalAuthRuntimeLive)),
    portalAuthRecoveryApiLive.pipe(GovernedReadLayer.provide(portalAuthRuntimeLive)),
    portalAuthStepUpApiLive.pipe(GovernedReadLayer.provide(portalAuthRuntimeLive)),
    /**
     * Enrollment is the one portal group that is also a governed Action caller: it reads the realm
     * (trusted origins, the budget and the provider account-creation capability) and runs the
     * `start-portal-enrollment` and `claim-portal-enrollment-transition` Actions through the same
     * enrollment-aware Action runtime every other governed route uses. A deployment without the
     * realm gets the fail-closed realm here exactly as the other four groups do.
     */
    portalAuthEnrollmentApiLive.pipe(GovernedReadLayer.provide(portalOwnerServicesLive)),
    enrollmentCommandRecoveryLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    commercePortalAuthVerificationCommerceApiLive.pipe(GovernedReadLayer.provide(verificationRouteServicesLive)),
    customerOwnConsentReadApiLive.pipe(GovernedReadLayer.provide(portalOwnerServicesLive)),
    customerOwnConsentUpdateApiLive.pipe(GovernedReadLayer.provide(portalOwnerServicesLive)),
    customerOwnProfileReadApiLive.pipe(GovernedReadLayer.provide(portalOwnerServicesLive)),
    customerOwnProfileUpdateApiLive.pipe(GovernedReadLayer.provide(portalOwnerServicesLive)),
    // <generated-governed-http-handler-layers>
    addSavedAddressActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    archiveCustomerGroupActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    archiveCustomerProfileActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    assignCounterpartyPriceGroupActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    assignCustomerGroupActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    assignCustomerPriceGroupActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    attributeGuestRetailCustomerActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    bindRetailPortalProfileActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    bootstrapCounterpartyAccessAdministratorActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    changeCounterpartyPurchaseLimitActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    changeCustomerPaymentTermsActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    changePrincipalPurchaseLimitOverrideActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    changeRetailPaymentTermPreferenceActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    claimCounterpartyAccessInvitationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    claimPortalEnrollmentTransitionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    clearDefaultBillingAddressActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    clearDefaultDeliveryDestinationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    commerceQuantityPolicyCurrentReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    commerceQuantityResolutionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    completePurchaseProposalBasisActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    consumeOrderPurchaseApprovalActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    consumePurchaseApprovalActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    counterpartyAccessInvitationReadReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    counterpartyAllCustomerArchiveReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    counterpartyAllOrderHistoryDetailReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    counterpartyAllOrderHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    counterpartyCommerceAccessCheckReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    counterpartyCommerceAccessDetailReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    counterpartyCommerceAccessListReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    counterpartyCustomerGroupMembershipsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    counterpartyOrderHistoryDetailReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    counterpartyOrderHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    createApprovalHierarchyActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createCounterpartyAccessInvitationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createCounterpartyPurchasingProfileActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createCustomerGroupActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createPurchaseProposalRevisionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    customerArchiveReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    customerGroupDetailReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    customerGroupHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    customerGroupMembersReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    customerPaymentTermEntitlementReadReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    customerPriceGroupAssignmentReadReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    customerPriceGroupResolutionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    customerProfileReadReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    customerProfileTradingGateReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    customerRecordVisibilityReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    decidePurchaseApprovalRequestActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    deliveryDestinationResolutionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    effectiveCustomerGroupMembershipSetV1ReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    effectiveCustomerGroupMembershipsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    ensureRetailCustomerProfileActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    executePrivacyMeasureActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    grantCounterpartyCommerceAccessActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    guestAttributionStatusReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    guestPaymentTermsResolutionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    invoiceRecipientResolutionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    marketAffectedUseAssessmentReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    marketBootstrapPolicyCurrentReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    marketBootstrapResolutionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    marketSubjectRestrictionsCurrentReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    migrateCounterpartyPriceGroupActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    migrateCustomerPriceGroupActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    openProfileReconciliationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    orderCommitmentApprovalEvidenceReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    orderServiceApprovalEvidenceReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    paymentTermAffectedUseAssessmentReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    paymentTermPolicyCurrentReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    paymentTermsResolutionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    preparePurchaseProposalBasisActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    pricingPurchaseContextVerificationReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    privacyMeasureExecutionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    profileReconciliationReadReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    purchaseCurrencyPolicyCurrentReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    purchaseCurrencyResolutionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    purchaseLimitEvaluationReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    purchaseLimitPolicyReadReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    purchaseProposalBasisReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    reactivateCustomerGroupActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    reactivateCustomerProfileActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    recordPortalEnrollmentOutcomeActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    recoverRetailPortalProfileBindingActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    removeCounterpartyPriceGroupActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    removeCustomerGroupActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    removeCustomerPaymentTermActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    removeCustomerPriceGroupActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    removeSavedAddressActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    repeatCounterpartyOrderActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    repeatOrderPreparationReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    repeatRetailOrderActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    reroutePurchaseApprovalRequestActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    resendCounterpartyAccessInvitationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    reserveMarketRetirementActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    reservePaymentTermRetirementActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    resolveProfileReconciliationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    retailAccessDecisionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retailOrderHistoryDetailReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retailOrderHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retailPortalProfileBindingReadReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retailPrincipalResolutionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retailPurchasingSubjectCurrentV1ReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    revalidateOrderPurchaseApprovalActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    revalidatePurchaseApprovalActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    revokeCounterpartyAccessInvitationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    revokeCounterpartyCommerceAccessActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    revokeRetailPortalProfileBindingActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    savedAddressDefaultsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    savedAddressDetailReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    savedAddressListReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    setDefaultBillingAddressActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    setDefaultDeliveryDestinationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    startPortalEnrollmentActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    submitPurchaseApprovalRequestActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    suspendCustomerProfileActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    terminatePortalEnrollmentActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    triggerPurchaseApprovalActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    updateCustomerGroupActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    updateSavedAddressActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    verifyEffectiveCustomerGroupMembershipSetV1ReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    verifyRetailPurchasingSubjectCurrentV1ReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    // </generated-governed-http-handler-layers>
  );
  const apiHandlersLive = Layer.mergeAll(
    commerceCustomerContextReadinessLayer.pipe(Layer.provide(apiHandlerGroupsLive)),
    apiHandlerGroupsLive,
  ).pipe(
    // Core revalidates a presented session binding's authentication namespace before any
    // authorization runs and answers `operation_context_unavailable` when no registry is reachable,
    // so every namespace-carrying gateway assertion this vertical is handed needs the registration
    // here. A deployment that supplies its own registry alongside the redemption store overrides
    // this one, which is why the owned registration is merged first.
    Layer.provide(
      Layer.mergeAll(
        CommerceAuthenticationNamespaceRegistryLive,
        actionPrincipalVerifierLive,
        gatewayAssertionRedemption,
      ),
    ),
  );
  const resolvedApiHandlersLive = apiHandlersLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        runtimeObservabilityLive,
        RequestSchemaProblemLive,
        compositionSourceLive,
        compositionHttpClientLive,
        databaseIdentitiesLive,
      ),
    ),
    // The deployment configuration belongs to the whole assembly: source HTTP, admission and
    // gateway verification capture the same configuration and transport references.
    Layer.provide(gatewayVerification),
    Layer.orDie,
  );
  const transportLive = HttpRouter.cors({
    allowedHeaders: [...commerceCustomerContextCorsAllowedHeaders],
    allowedMethods: [...commerceCustomerContextCorsAllowedMethods],
    allowedOrigins: commerceCustomerContextCorsAllowedOrigins(readShellOrigin()),
    maxAge: 600,
  });

  return assembleEffectBffRuntime({
    api: commerceCustomerContextApi,
    handlers: resolvedApiHandlersLive,
    transport: transportLive,
  });
};

const apiRuntime = makeCommerceCustomerContextApiRuntime(
  productionReadRuntimeLive,
  productionActionRuntimeLive,
  configuredGatewayAssertionRedemptionLive,
  deploymentPortalAuthRuntimeLive,
  Layer.empty,
  DatabaseConfigLive,
  ContextAccessLive,
);

export default apiRuntime;

export {
  commerceCustomerContextActionRuntime,
  commerceCustomerContextReadRuntime,
  productionActionRuntimeLive,
  productionReadRuntimeLive,
};
