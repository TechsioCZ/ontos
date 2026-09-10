import {
  ActionRuntimeLive,
  ActionAuthorizationPreflightDatabaseLive,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import type {
  ActionRuntime,
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
import { assembleEffectBffRuntime } from '@app/shared-contracts/server/effect-bff-runtime';
import { Effect, HttpApiBuilder, HttpRouter, Layer } from '@modern-js/plugin-bff/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/plugin-bff/effect-edge';
import { Layer as GovernedReadLayer, Logger, References, Schema, Tracer } from 'effect';
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
import {
  purchaseLimitEvaluationCurrentnessLive,
  purchaseLimitPersistenceLayer,
} from '../src/persistence/purchase-limit-persistence.ts';
import { purchaseApprovalCurrentnessFactoryLive } from '../src/persistence/purchase-approval-currentness-persistence.ts';
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
import { clearDefaultBillingAddressActionApiLive } from './clear-default-billing-address-action-server.ts';
import { clearDefaultDeliveryDestinationActionApiLive } from './clear-default-delivery-destination-action-server.ts';
import { consumePurchaseApprovalActionApiLive } from './consume-purchase-approval-action-server.ts';
import { counterpartyAccessInvitationReadReadApiLive } from './counterparty-access-invitation-read-read-server.ts';
import { counterpartyAllCustomerArchiveReadApiLive } from './counterparty-all-customer-archive-read-server.ts';
import { counterpartyAllOrderHistoryDetailReadApiLive } from './counterparty-all-order-history-detail-read-server.ts';
import { counterpartyAllOrderHistoryReadApiLive } from './counterparty-all-order-history-read-server.ts';
import { counterpartyCommerceAccessCheckReadApiLive } from './counterparty-commerce-access-check-read-server.ts';
import { counterpartyCommerceAccessDetailReadApiLive } from './counterparty-commerce-access-detail-read-server.ts';
import { counterpartyCommerceAccessListReadApiLive } from './counterparty-commerce-access-list-read-server.ts';
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
import { effectiveCustomerGroupMembershipsReadApiLive } from './effective-customer-group-memberships-read-server.ts';
import { ensureRetailCustomerProfileActionApiLive } from './ensure-retail-customer-profile-action-server.ts';
import { grantCounterpartyCommerceAccessActionApiLive } from './grant-counterparty-commerce-access-action-server.ts';
import { guestAttributionStatusReadApiLive } from './guest-attribution-status-read-server.ts';
import { guestPaymentTermsResolutionReadApiLive } from './guest-payment-terms-resolution-read-server.ts';
import { invoiceRecipientResolutionReadApiLive } from './invoice-recipient-resolution-read-server.ts';
import { migrateCounterpartyPriceGroupActionApiLive } from './migrate-counterparty-price-group-action-server.ts';
import { migrateCustomerPriceGroupActionApiLive } from './migrate-customer-price-group-action-server.ts';
import { openProfileReconciliationActionApiLive } from './open-profile-reconciliation-action-server.ts';
import { paymentTermAffectedUseAssessmentReadApiLive } from './payment-term-affected-use-assessment-read-server.ts';
import { paymentTermsResolutionReadApiLive } from './payment-terms-resolution-read-server.ts';
import { profileReconciliationReadReadApiLive } from './profile-reconciliation-read-read-server.ts';
import { purchaseCurrencyResolutionReadApiLive } from './purchase-currency-resolution-read-server.ts';
import { purchaseLimitEvaluationReadApiLive } from './purchase-limit-evaluation-read-server.ts';
import { purchaseLimitPolicyReadReadApiLive } from './purchase-limit-policy-read-read-server.ts';
import { reactivateCustomerGroupActionApiLive } from './reactivate-customer-group-action-server.ts';
import { reactivateCustomerProfileActionApiLive } from './reactivate-customer-profile-action-server.ts';
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
import { reservePaymentTermRetirementActionApiLive } from './reserve-payment-term-retirement-action-server.ts';
import { resolveProfileReconciliationActionApiLive } from './resolve-profile-reconciliation-action-server.ts';
import { retailAccessDecisionReadApiLive } from './retail-access-decision-read-server.ts';
import { retailOrderHistoryDetailReadApiLive } from './retail-order-history-detail-read-server.ts';
import { retailOrderHistoryReadApiLive } from './retail-order-history-read-server.ts';
import { retailPortalProfileBindingReadReadApiLive } from './retail-portal-profile-binding-read-read-server.ts';
import { retailPrincipalResolutionReadApiLive } from './retail-principal-resolution-read-server.ts';
import { revalidatePurchaseApprovalActionApiLive } from './revalidate-purchase-approval-action-server.ts';
import { revokeCounterpartyAccessInvitationActionApiLive } from './revoke-counterparty-access-invitation-action-server.ts';
import { revokeCounterpartyCommerceAccessActionApiLive } from './revoke-counterparty-commerce-access-action-server.ts';
import { revokeRetailPortalProfileBindingActionApiLive } from './revoke-retail-portal-profile-binding-action-server.ts';
import { savedAddressDefaultsReadApiLive } from './saved-address-defaults-read-server.ts';
import { savedAddressDetailReadApiLive } from './saved-address-detail-read-server.ts';
import { savedAddressListReadApiLive } from './saved-address-list-read-server.ts';
import { setDefaultBillingAddressActionApiLive } from './set-default-billing-address-action-server.ts';
import { setDefaultDeliveryDestinationActionApiLive } from './set-default-delivery-destination-action-server.ts';
import { submitPurchaseApprovalRequestActionApiLive } from './submit-purchase-approval-request-action-server.ts';
import { suspendCustomerProfileActionApiLive } from './suspend-customer-profile-action-server.ts';
import { triggerPurchaseApprovalActionApiLive } from './trigger-purchase-approval-action-server.ts';
import { updateCustomerGroupActionApiLive } from './update-customer-group-action-server.ts';
import { updateSavedAddressActionApiLive } from './update-saved-address-action-server.ts';
// </generated-governed-http-handler-imports>

import { microVerticalOperationAttributes } from '@app/shared-contracts';
import {
  commerceCustomerContextApi,
  commerceCustomerContextOperationContexts,
} from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

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
          attributes: microVerticalOperationAttributes(
            commerceCustomerContextOperationContexts.readiness,
          ),
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
  Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
);
const tenantModuleStateServiceLive = TenantModuleStateServiceLive.pipe(
  Layer.provide(CorePersistenceLive),
);
const moduleStateGateLive = ModuleStateGateLive.pipe(Layer.provide(tenantModuleStateServiceLive));
const operationalScopeResolverLive = OperationalScopeResolverLive.pipe(
  Layer.provide(Layer.mergeAll(CorePersistenceLive, ContextAccessLive)),
);
const moduleEntrypointGatewayLive = ModuleEntrypointGatewayLive.pipe(
  Layer.provide(moduleStateGateLive),
);
const productionOwnerRuntimeServicesLive = commerceCustomerContextOwnerRuntimeServicesLive.pipe(
  Layer.provide(Layer.mergeAll(CorePersistenceLive, ContextAccessLive)),
  Layer.provide(profileReconfirmationPolicyUnavailableLive),
);
const productionOwnerAuthorizationOverlayLive =
  commerceCustomerContextOwnerAuthorizationOverlayLive.pipe(
    Layer.provide(productionOwnerRuntimeServicesLive),
  );
const productionPurchaseLimitPersistenceLive = purchaseLimitPersistenceLayer.pipe(
  Layer.provide(purchaseLimitEvaluationCurrentnessLive),
  Layer.provide(profileCounterpartyRoleEligibilityResolverFactoryLive),
);
// Keep the authoritative Currentness port visible to approval Actions as well as to the
// Purchase-Limit source factory. The unavailable leaf is intentionally never part of production
// composition.
const productionPurchaseLimitCurrentnessLive = Layer.mergeAll(
  productionPurchaseLimitPersistenceLive,
  purchaseLimitEvaluationCurrentnessLive,
);
const readRuntimeCoreLive = ReadRuntimeLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      CorePersistenceLive,
      ContextAccessLive,
      moduleEntrypointGatewayLive,
      operationalScopeResolverLive,
    ),
  ),
);
const actionAuthorizationPreflightDatabaseWithCoreLive =
  ActionAuthorizationPreflightDatabaseLive.pipe(Layer.provideMerge(CorePersistenceLive));
const actionRuntimeCoreLive = ActionRuntimeLive.pipe(
  Layer.provideMerge(commerceCustomerContextInvitationClaimActionAuthorizationPreflightLive),
  Layer.provide(
    Layer.mergeAll(
      actionAuthorizationPreflightDatabaseWithCoreLive,
      ActionRepositoryLive,
      ActionPermissionLive,
      ContextAccessLive,
      moduleStateGateLive,
      moduleEntrypointGatewayLive,
      operationalScopeResolverLive,
    ),
  ),
);
/** Deployment composition seam. External owner ports remain visible requirements here. */
const commerceCustomerContextActionRuntime = actionRuntimeCoreLive.pipe(
  Layer.provideMerge(productionOwnerRuntimeServicesLive),
  Layer.provideMerge(productionOwnerAuthorizationOverlayLive),
  Layer.provideMerge(productionPurchaseLimitCurrentnessLive),
  Layer.provideMerge(purchaseApprovalCurrentnessFactoryLive),
  Layer.provide(DatabaseConfigLive),
);
/** Deployment composition seam. External owner ports remain visible requirements here. */
const commerceCustomerContextReadRuntime = readRuntimeCoreLive.pipe(
  Layer.provideMerge(productionOwnerRuntimeServicesLive),
  Layer.provideMerge(productionOwnerAuthorizationOverlayLive),
  Layer.provideMerge(productionPurchaseLimitCurrentnessLive),
  Layer.provide(DatabaseConfigLive),
);
const productionActionRuntimeLive = commerceCustomerContextActionRuntime.pipe(
  Layer.provideMerge(commerceCustomerContextProductionExternalPortsLive),
  Layer.provideMerge(ProfileReconciliationOwnerVerifierUnavailableLive),
);
const productionReadRuntimeLive = commerceCustomerContextReadRuntime.pipe(
  Layer.provideMerge(commerceCustomerContextProductionExternalPortsLive),
);

type CommerceCustomerContextApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<ReadRuntime, Layer.Error<typeof productionReadRuntimeLive>>,
  actionRuntime: Layer.Layer<ActionRuntime, Layer.Error<typeof productionActionRuntimeLive>>,
  gatewayAssertionRedemption: Layer.Layer<GatewayAssertionRedemptionService>,
];

export type CommerceCustomerContextApiRuntime = EffectBffDefinition<
  typeof commerceCustomerContextApi
> &
  EffectBffRuntime<typeof commerceCustomerContextApi>;

export const makeCommerceCustomerContextApiRuntime = (
  ...args: CommerceCustomerContextApiRuntimeArguments
): CommerceCustomerContextApiRuntime => {
  const [governedReadRuntimeLive, governedActionRuntimeLive, gatewayAssertionRedemption] = args;
  const actionPrincipalVerifierLive = GovernedActionPrincipalVerifierLive.pipe(
    Layer.provide(governedActionRuntimeLive),
  );
  const apiHandlersLive = Layer.mergeAll(
    commerceCustomerContextReadinessLayer,
    // <generated-governed-http-handler-layers>
    addSavedAddressActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    archiveCustomerGroupActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    archiveCustomerProfileActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    assignCounterpartyPriceGroupActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    assignCustomerGroupActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    assignCustomerPriceGroupActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    attributeGuestRetailCustomerActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    bindRetailPortalProfileActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    bootstrapCounterpartyAccessAdministratorActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    changeCounterpartyPurchaseLimitActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    changeCustomerPaymentTermsActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    changePrincipalPurchaseLimitOverrideActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    changeRetailPaymentTermPreferenceActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    claimCounterpartyAccessInvitationActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    clearDefaultBillingAddressActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    clearDefaultDeliveryDestinationActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    consumePurchaseApprovalActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    counterpartyAccessInvitationReadReadApiLive.pipe(
      GovernedReadLayer.provide(governedReadRuntimeLive),
    ),
    counterpartyAllCustomerArchiveReadApiLive.pipe(
      GovernedReadLayer.provide(governedReadRuntimeLive),
    ),
    counterpartyAllOrderHistoryDetailReadApiLive.pipe(
      GovernedReadLayer.provide(governedReadRuntimeLive),
    ),
    counterpartyAllOrderHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    counterpartyCommerceAccessCheckReadApiLive.pipe(
      GovernedReadLayer.provide(governedReadRuntimeLive),
    ),
    counterpartyCommerceAccessDetailReadApiLive.pipe(
      GovernedReadLayer.provide(governedReadRuntimeLive),
    ),
    counterpartyCommerceAccessListReadApiLive.pipe(
      GovernedReadLayer.provide(governedReadRuntimeLive),
    ),
    counterpartyOrderHistoryDetailReadApiLive.pipe(
      GovernedReadLayer.provide(governedReadRuntimeLive),
    ),
    counterpartyOrderHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    createApprovalHierarchyActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createCounterpartyAccessInvitationActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    createCounterpartyPurchasingProfileActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    createCustomerGroupActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createPurchaseProposalRevisionActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    customerArchiveReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    customerGroupDetailReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    customerGroupHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    customerGroupMembersReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    customerPaymentTermEntitlementReadReadApiLive.pipe(
      GovernedReadLayer.provide(governedReadRuntimeLive),
    ),
    customerPriceGroupAssignmentReadReadApiLive.pipe(
      GovernedReadLayer.provide(governedReadRuntimeLive),
    ),
    customerPriceGroupResolutionReadApiLive.pipe(
      GovernedReadLayer.provide(governedReadRuntimeLive),
    ),
    customerProfileReadReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    customerProfileTradingGateReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    customerRecordVisibilityReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    decidePurchaseApprovalRequestActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    deliveryDestinationResolutionReadApiLive.pipe(
      GovernedReadLayer.provide(governedReadRuntimeLive),
    ),
    effectiveCustomerGroupMembershipsReadApiLive.pipe(
      GovernedReadLayer.provide(governedReadRuntimeLive),
    ),
    ensureRetailCustomerProfileActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    grantCounterpartyCommerceAccessActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    guestAttributionStatusReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    guestPaymentTermsResolutionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    invoiceRecipientResolutionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    migrateCounterpartyPriceGroupActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    migrateCustomerPriceGroupActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    openProfileReconciliationActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    paymentTermAffectedUseAssessmentReadApiLive.pipe(
      GovernedReadLayer.provide(governedReadRuntimeLive),
    ),
    paymentTermsResolutionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    profileReconciliationReadReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    purchaseCurrencyResolutionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    purchaseLimitEvaluationReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    purchaseLimitPolicyReadReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    reactivateCustomerGroupActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    reactivateCustomerProfileActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    recoverRetailPortalProfileBindingActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    removeCounterpartyPriceGroupActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    removeCustomerGroupActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    removeCustomerPaymentTermActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    removeCustomerPriceGroupActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    removeSavedAddressActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    repeatCounterpartyOrderActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    repeatOrderPreparationReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    repeatRetailOrderActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    reroutePurchaseApprovalRequestActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    resendCounterpartyAccessInvitationActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    reservePaymentTermRetirementActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    resolveProfileReconciliationActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    retailAccessDecisionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retailOrderHistoryDetailReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retailOrderHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retailPortalProfileBindingReadReadApiLive.pipe(
      GovernedReadLayer.provide(governedReadRuntimeLive),
    ),
    retailPrincipalResolutionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    revalidatePurchaseApprovalActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    revokeCounterpartyAccessInvitationActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    revokeCounterpartyCommerceAccessActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    revokeRetailPortalProfileBindingActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    savedAddressDefaultsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    savedAddressDetailReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    savedAddressListReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    setDefaultBillingAddressActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    setDefaultDeliveryDestinationActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    submitPurchaseApprovalRequestActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    suspendCustomerProfileActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    triggerPurchaseApprovalActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    updateCustomerGroupActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    updateSavedAddressActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    // </generated-governed-http-handler-layers>
  ).pipe(Layer.provide(Layer.mergeAll(actionPrincipalVerifierLive, gatewayAssertionRedemption)));
  const resolvedApiHandlersLive = apiHandlersLive.pipe(
    Layer.provide(runtimeObservabilityLive),
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
  GovernedGatewayAssertionRedemptionLive,
);

export default apiRuntime;

export { commerceCustomerContextActionRuntime, commerceCustomerContextReadRuntime };
