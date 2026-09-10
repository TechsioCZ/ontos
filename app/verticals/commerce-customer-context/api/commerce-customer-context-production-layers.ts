import {
  BusinessPermissionRelationshipMutationLive,
  PrincipalEligibilityLive,
} from '@app/core-runtime';
import { Layer } from 'effect';

import {
  CounterpartyInvitationProofDelivery,
  unavailableCounterpartyInvitationProofDelivery,
} from '../shared/domain/access-port.ts';
import {
  PurchaseCurrencyPurchasingContextPort,
  unavailablePurchaseCurrencyPurchasingContextPort,
} from '../shared/domain/purchase-currency-context-port.ts';
import {
  PurchaseCurrencyPolicyPort,
  unavailablePurchaseCurrencyPolicyPort,
} from '../shared/domain/purchase-currency-policy-port.ts';
import { profileReactivationEligibilityEvaluatorFactoryLive } from '../src/integrations/profile-reactivation-eligibility.ts';
import { profileCounterpartyRoleEligibilityResolverFactoryLive } from '../src/profile-counterparty-role-eligibility.ts';
import { profileRetailPermissionReaderFactoryLive } from '../src/integrations/retail-permission-reader.ts';
import { partyRegistryGuestResolverFactoryLive } from '../src/integrations/party-registry-guest-resolver.ts';
import { partyRegistryRetailPartyResolverFactoryLive } from '../src/integrations/party-registry-retail-party-resolver.ts';
import {
  PurchaseCurrencyPricingPort,
  unavailablePurchaseCurrencyPricingPort,
} from '../shared/domain/purchase-currency-pricing-port.ts';
import {
  PaymentTermCatalogGatewayCredentialService,
  unavailablePaymentTermCatalogGatewayCredentialIssuer,
} from '../shared/domain/payment-term-catalog-gateway-credential.ts';
import {
  unavailableHistoryActionOwnerPorts,
  RepeatCartOwner,
} from '../shared/domain/history-action-ports.ts';
import {
  CustomerHistoryPortsService,
  unavailableCustomerHistoryPorts,
} from '../shared/domain/history-ports.ts';
import { paymentTermCatalogGatewayCredentialLive } from './payment-term-catalog-gateway-credential.ts';

type CommerceCustomerContextOwnerRuntimeServices =
  | Layer.Success<typeof BusinessPermissionRelationshipMutationLive>
  | Layer.Success<typeof PrincipalEligibilityLive>
  | Layer.Success<typeof profileCounterpartyRoleEligibilityResolverFactoryLive>
  | Layer.Success<typeof profileRetailPermissionReaderFactoryLive>
  | Layer.Success<typeof profileReactivationEligibilityEvaluatorFactoryLive>
  | Layer.Success<typeof partyRegistryGuestResolverFactoryLive>
  | Layer.Success<typeof partyRegistryRetailPartyResolverFactoryLive>;

type CommerceCustomerContextOwnerRuntimeDependencies =
  | Layer.Services<typeof PrincipalEligibilityLive>
  | Layer.Services<typeof profileRetailPermissionReaderFactoryLive>
  | Layer.Services<typeof profileReactivationEligibilityEvaluatorFactoryLive>;

/** Owner services remain dependency-transparent; the API root supplies Core persistence. */
export const commerceCustomerContextOwnerRuntimeServicesLive: Layer.Layer<
  CommerceCustomerContextOwnerRuntimeServices,
  never,
  CommerceCustomerContextOwnerRuntimeDependencies
> = Layer.mergeAll(
  BusinessPermissionRelationshipMutationLive,
  PrincipalEligibilityLive,
  profileCounterpartyRoleEligibilityResolverFactoryLive,
  profileRetailPermissionReaderFactoryLive,
  profileReactivationEligibilityEvaluatorFactoryLive,
  partyRegistryGuestResolverFactoryLive,
  partyRegistryRetailPartyResolverFactoryLive,
);

/** Proof delivery is an explicit after-commit deployment integration; absence fails closed. */
export const unavailableCounterpartyInvitationProofDeliveryLive = Layer.succeed(
  CounterpartyInvitationProofDelivery,
  unavailableCounterpartyInvitationProofDelivery(),
);

export const unavailablePurchaseCurrencyPurchasingContextPortLive = Layer.succeed(
  PurchaseCurrencyPurchasingContextPort,
  unavailablePurchaseCurrencyPurchasingContextPort(),
);
export const unavailablePurchaseCurrencyPolicyPortLive = Layer.succeed(
  PurchaseCurrencyPolicyPort,
  unavailablePurchaseCurrencyPolicyPort(),
);
export const unavailablePurchaseCurrencyPricingPortLive = Layer.succeed(
  PurchaseCurrencyPricingPort,
  unavailablePurchaseCurrencyPricingPort(),
);
export const unavailablePaymentTermCatalogGatewayCredentialLive = Layer.succeed(
  PaymentTermCatalogGatewayCredentialService,
  unavailablePaymentTermCatalogGatewayCredentialIssuer,
);

/**
 * Explicit fail-closed history boundary until each canonical owner publishes its adapter.
 *
 * This Layer is exported for hosts that want a complete default dependency graph, but it is
 * intentionally not installed into the API runtimes below.  The History loaders resolve the
 * Context service optionally and use this same adapter when no deployment-owned service is
 * supplied.  That keeps the production seam injectable while Order/Cart/catalog owners remain
 * visibly fail-closed rather than being replaced by local stand-ins.
 */
export const unavailableCustomerHistoryPortsLive = Layer.succeed(
  CustomerHistoryPortsService,
  unavailableCustomerHistoryPorts(),
);
const unavailableHistoryActionOwners = unavailableHistoryActionOwnerPorts();
export const unavailableRepeatCartOwnerLive = Layer.succeed(
  RepeatCartOwner,
  unavailableHistoryActionOwners.carts,
);

/**
 * Production owner composition.  The Payment Term Catalog issuer is a server-owned gateway
 * credential; its configuration layer fails closed when a deployment has not supplied the
 * corresponding secret or gateway URL. It is intentionally composed next to the other external
 * owner ports so no request/session credential can be substituted by a caller.
 */
export const commerceCustomerContextProductionExternalPortsLive = Layer.mergeAll(
  unavailableCounterpartyInvitationProofDeliveryLive,
  unavailablePurchaseCurrencyPurchasingContextPortLive,
  unavailablePurchaseCurrencyPolicyPortLive,
  unavailablePurchaseCurrencyPricingPortLive,
  paymentTermCatalogGatewayCredentialLive,
  unavailableRepeatCartOwnerLive,
);

/** Backwards-compatible name for hosts that still import the complete fail-closed port graph. */
export const unavailableCommerceCustomerContextExternalPortsLive =
  commerceCustomerContextProductionExternalPortsLive;
