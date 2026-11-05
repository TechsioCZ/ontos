import { PrincipalEligibilityLive } from '@app/core-runtime';
import type { Crypto } from 'effect';
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
import { partyRegistryGuestResolverFactoryLive } from '../src/integrations/party-registry-guest-resolver.ts';
import { partyRegistryRetailPartyResolverFactoryLive } from '../src/integrations/party-registry-retail-party-resolver.ts';
import { unavailableHistoryActionOwnerPorts, RepeatCartOwner } from '../shared/domain/history-action-ports.ts';
import { applicationCompositionMarketReferenceOwnerDeploymentStateAuthorityLive } from './application-composition-market-reference-owner-authority.ts';
import {
  pricingPurchaseContextOwnerAuthorityUnavailableLive,
  pricingPurchaseContextVerificationLive,
} from '../src/services/pricing-purchase-context-owner-authority.ts';

type CommerceCustomerContextOwnerRuntimeServices =
  | Layer.Success<typeof PrincipalEligibilityLive>
  | Layer.Success<typeof profileCounterpartyRoleEligibilityResolverFactoryLive>
  | Layer.Success<typeof profileReactivationEligibilityEvaluatorFactoryLive>
  | Layer.Success<typeof partyRegistryGuestResolverFactoryLive>
  | Layer.Success<typeof partyRegistryRetailPartyResolverFactoryLive>
  | Layer.Success<typeof pricingPurchaseContextVerificationLive>;

type CommerceCustomerContextOwnerRuntimeDependencies =
  | Crypto.Crypto
  | Layer.Services<typeof PrincipalEligibilityLive>
  | Layer.Services<typeof profileReactivationEligibilityEvaluatorFactoryLive>
  | Layer.Services<typeof pricingPurchaseContextVerificationLive>;

/** Owner services remain dependency-transparent; the API root supplies Core persistence. */
export const commerceCustomerContextOwnerRuntimeServicesLive: Layer.Layer<
  CommerceCustomerContextOwnerRuntimeServices,
  never,
  CommerceCustomerContextOwnerRuntimeDependencies
> = Layer.mergeAll(
  PrincipalEligibilityLive,
  profileCounterpartyRoleEligibilityResolverFactoryLive,
  profileReactivationEligibilityEvaluatorFactoryLive,
  partyRegistryGuestResolverFactoryLive,
  partyRegistryRetailPartyResolverFactoryLive,
  pricingPurchaseContextVerificationLive,
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
 * Production owner composition. External owner ports acquire their module-to-module context from the
 * shared delegated client, which fails closed when this deployment's module credential is not configured.
 */
export const commerceCustomerContextProductionExternalPortsLive = Layer.mergeAll(
  unavailableCounterpartyInvitationProofDeliveryLive,
  unavailablePurchaseCurrencyPurchasingContextPortLive,
  unavailableRepeatCartOwnerLive,
  applicationCompositionMarketReferenceOwnerDeploymentStateAuthorityLive,
  pricingPurchaseContextOwnerAuthorityUnavailableLive,
);
