import { OperationContextUnavailable } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Effect } from 'effect';

import { ProfileReactivationEligibilityEvaluatorFactory } from './integrations/profile-reactivation-eligibility.ts';
import {
  profilePersistenceServicesForTransaction,
  profileReconciliationOwnerVerifierForTransaction,
} from './persistence/profile-persistence.ts';
import { addressBookReconciliationOwnerVerifierForTransaction } from './persistence/address-persistence.ts';
import { paymentTermsReconciliationOwnerEvidenceVerifierForTransaction } from './persistence/payment-term-persistence.ts';
import type {
  ProfilePersistenceServices,
  ProfilePersistenceScope,
  ProfileScopedRoutineInvoker,
} from './persistence/profile-persistence.ts';
import { ProfileCounterpartyRoleEligibilityResolverFactory } from './profile-counterparty-role-eligibility.ts';
import type { ProfileReconciliationOwnerVerifierService } from './profile-reconciliation-owner-verifier.ts';
import { ProfileRetailPermissionReaderFactory } from './integrations/retail-permission-reader.ts';
import { PartyRegistryGuestResolverFactory } from './integrations/party-registry-guest-resolver.ts';
import { PartyRegistryRetailPartyResolverFactory } from './integrations/party-registry-retail-party-resolver.ts';

export const profileServicesForVerifiedScope = (
  transaction: ProfileScopedRoutineInvoker,
  scope: OperationalScope,
): Effect.Effect<
  ProfilePersistenceServices,
  OperationContextUnavailable,
  | ProfileCounterpartyRoleEligibilityResolverFactory
  | ProfileReactivationEligibilityEvaluatorFactory
  | ProfileRetailPermissionReaderFactory
  | PartyRegistryGuestResolverFactory
  | PartyRegistryRetailPartyResolverFactory
> => {
  if (scope.legalEntityId === undefined) {
    return Effect.fail(
      new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Customer Profile persistence requires a trusted Legal Entity scope',
      }),
    );
  }
  const baseScope = {
    legalEntityId: scope.legalEntityId,
    principalId: scope.principalId,
    tenantId: scope.tenantId,
  };
  let verifiedScope: ProfilePersistenceScope = baseScope;
  if (scope.authBindingId !== undefined) {
    verifiedScope = { ...baseScope, authBindingId: scope.authBindingId };
  }
  return Effect.gen(function* profileServices() {
    const roleResolverFactory = yield* ProfileCounterpartyRoleEligibilityResolverFactory;
    const reactivationEvaluatorFactory = yield* ProfileReactivationEligibilityEvaluatorFactory;
    const retailPermissionReaderFactory = yield* ProfileRetailPermissionReaderFactory;
    const guestResolverFactory = yield* PartyRegistryGuestResolverFactory;
    const retailPartyResolverFactory = yield* PartyRegistryRetailPartyResolverFactory;
    const resolveCounterpartyRole = roleResolverFactory.make({
      legalEntityId: verifiedScope.legalEntityId,
      requestCorrelation: scope.correlationId,
      tenantId: verifiedScope.tenantId,
    });
    const evaluateReactivation = reactivationEvaluatorFactory.make({
      resolveCounterpartyRole,
      scope: verifiedScope,
      transaction,
    });
    const readRetailPermissions = retailPermissionReaderFactory.make({
      legalEntityId: verifiedScope.legalEntityId,
      principalId: verifiedScope.principalId,
      tenantId: verifiedScope.tenantId,
    });
    const resolveGuestParty = guestResolverFactory.make({
      legalEntityId: verifiedScope.legalEntityId,
      requestCorrelation: scope.correlationId,
      tenantId: verifiedScope.tenantId,
    });
    const resolveRetailParty = retailPartyResolverFactory.make({
      requestCorrelation: scope.correlationId,
      tenantId: verifiedScope.tenantId,
    });
    const profileOwnerVerifier = profileReconciliationOwnerVerifierForTransaction(transaction, verifiedScope);
    const paymentTermsOwnerVerifier = paymentTermsReconciliationOwnerEvidenceVerifierForTransaction(transaction);
    const addressBookOwnerVerifier = addressBookReconciliationOwnerVerifierForTransaction(transaction, scope);
    const reconciliationOwnerVerifier: ProfileReconciliationOwnerVerifierService = {
      verify: (request, context) => {
        if (request.desiredOutcome.owner === 'PAYMENT_TERMS') {
          return paymentTermsOwnerVerifier.verify(request, context);
        }
        if (request.desiredOutcome.owner === 'ADDRESS_BOOK') {
          return addressBookOwnerVerifier.verify(request, context);
        }
        return profileOwnerVerifier.verify(request, context);
      },
    };
    return profilePersistenceServicesForTransaction(transaction, verifiedScope, {
      evaluateReactivation,
      readRetailPermissions,
      reconciliationOwnerVerifier,
      resolveCounterpartyRole,
      resolveGuestParty,
      resolveRetailParty,
    });
  });
};
