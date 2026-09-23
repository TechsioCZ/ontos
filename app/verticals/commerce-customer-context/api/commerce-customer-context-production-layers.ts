import { BusinessPermissionRelationshipMutationLive, PrincipalEligibilityLive } from '@app/core-runtime';
import { Layer } from 'effect';

import {
  CounterpartyInvitationProofDelivery,
  unavailableCounterpartyInvitationProofDelivery,
} from '../shared/domain/access-port.ts';
import {
  PurchaseCurrencyPurchasingContextPort,
  unavailablePurchaseCurrencyPurchasingContextPort,
} from '../shared/domain/purchase-currency-context-port.ts';
import { profileReactivationEligibilityEvaluatorFactoryLive } from '../src/integrations/profile-reactivation-eligibility.ts';
import { profileCounterpartyRoleEligibilityResolverFactoryLive } from '../src/profile-counterparty-role-eligibility.ts';
import { profileRetailPermissionReaderFactoryLive } from '../src/integrations/retail-permission-reader.ts';
import { partyRegistryGuestResolverFactoryLive } from '../src/integrations/party-registry-guest-resolver.ts';
import { partyRegistryRetailPartyResolverFactoryLive } from '../src/integrations/party-registry-retail-party-resolver.ts';
import { unavailableHistoryActionOwnerPorts, RepeatCartOwner } from '../shared/domain/history-action-ports.ts';
import { paymentTermCatalogGatewayCredentialLive } from './payment-term-catalog-gateway-credential.ts';
import { catalogQuantityGatewayCredentialLive } from './catalog-quantity-gateway-credential.ts';
import { purchaseCurrencyPricingGatewayCredentialLive } from './purchase-currency-pricing-gateway-credential.ts';
import { applicationCompositionMarketReferenceOwnerDeploymentStateAuthorityLive } from './application-composition-market-reference-owner-authority.ts';

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
const unavailableCounterpartyInvitationProofDeliveryLive = Layer.succeed(
  CounterpartyInvitationProofDelivery,
  unavailableCounterpartyInvitationProofDelivery(),
);

const unavailablePurchaseCurrencyPurchasingContextPortLive = Layer.succeed(
  PurchaseCurrencyPurchasingContextPort,
  unavailablePurchaseCurrencyPurchasingContextPort(),
);
const unavailableHistoryActionOwners = unavailableHistoryActionOwnerPorts();
const unavailableRepeatCartOwnerLive = Layer.succeed(RepeatCartOwner, unavailableHistoryActionOwners.carts);

/**
 * Production owner composition. External owner issuers are server-owned gateway credentials;
 * their configuration layers fail closed when a deployment has not supplied the corresponding
 * secret or gateway URL. They are intentionally composed next to the other external owner ports
 * so no request/session credential can be substituted by a caller.
 */
export const commerceCustomerContextProductionExternalPortsLive = Layer.mergeAll(
  unavailableCounterpartyInvitationProofDeliveryLive,
  unavailablePurchaseCurrencyPurchasingContextPortLive,
  purchaseCurrencyPricingGatewayCredentialLive,
  paymentTermCatalogGatewayCredentialLive,
  catalogQuantityGatewayCredentialLive,
  unavailableRepeatCartOwnerLive,
  applicationCompositionMarketReferenceOwnerDeploymentStateAuthorityLive,
);
