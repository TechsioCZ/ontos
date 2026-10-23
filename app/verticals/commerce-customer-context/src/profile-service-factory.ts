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
import {
  ProfileRetailPermissionReaderFactory,
  prefetchRetailPermissions,
  unreadRetailPermissions,
} from './integrations/retail-permission-reader.ts';
import type { RetailPermissionReader } from './integrations/retail-permission-reader.ts';
import { PartyRegistryGuestResolverFactory } from './integrations/party-registry-guest-resolver.ts';
import { PartyRegistryRetailPartyResolverFactory } from './integrations/party-registry-retail-party-resolver.ts';

type ProfileServicesForRetailPermissions = (
  readRetailPermissions: RetailPermissionReader,
) => ProfilePersistenceServices;

/**
 * Profile services whose Retail Portal permission reader the caller supplies. A Read passes the snapshot
 * it read in its `prepare` step, so the profile services it uses inside the transaction never call SpiceDB.
 */
export const profileServicesWithRetailPermissionsForVerifiedScope = (
  transaction: ProfileScopedRoutineInvoker,
  scope: OperationalScope,
): Effect.Effect<
  ProfileServicesForRetailPermissions,
  OperationContextUnavailable,
  | ProfileCounterpartyRoleEligibilityResolverFactory
  | ProfileReactivationEligibilityEvaluatorFactory
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
    const resolveGuestParty = guestResolverFactory.make({
      legalEntityId: verifiedScope.legalEntityId,
      requestCorrelation: scope.correlationId,
      tenantId: verifiedScope.tenantId,
    });
    const resolveRetailParty = retailPartyResolverFactory.make({
      legalEntityId: verifiedScope.legalEntityId,
      principalId: verifiedScope.principalId,
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
    return (readRetailPermissions: RetailPermissionReader) =>
      profilePersistenceServicesForTransaction(transaction, verifiedScope, {
        evaluateReactivation,
        readRetailPermissions,
        reconciliationOwnerVerifier,
        resolveCounterpartyRole,
        resolveGuestParty,
        resolveRetailParty,
      });
  });
};

/** Profile services with the live Retail Portal permission reader (Actions and Reads that never use it). */
export const profileServicesForVerifiedScope = Effect.fn('ProfileServiceFactory.profileServicesForVerifiedScope')(
  function* profileServicesWithLiveRetailPermissions(
    transaction: ProfileScopedRoutineInvoker,
    scope: OperationalScope,
  ) {
    const withRetailPermissions = yield* profileServicesWithRetailPermissionsForVerifiedScope(transaction, scope);
    const retailPermissionReaderFactory = yield* ProfileRetailPermissionReaderFactory;
    return withRetailPermissions(
      scope.legalEntityId === undefined
        ? unreadRetailPermissions
        : retailPermissionReaderFactory.make({
            legalEntityId: scope.legalEntityId,
            principalId: scope.principalId,
            tenantId: scope.tenantId,
          }),
    );
  },
);

/**
 * A Read's `prepare` step: the caller's Retail Portal permission snapshot for one profile, read before the
 * transaction. Without a trusted Legal Entity there is nothing to read; the Read fails closed inside.
 */
export const prepareRetailPermissions = Effect.fn('ProfileServiceFactory.prepareRetailPermissions')(
  function* prepareRetailPermissionSnapshot(scope: OperationalScope, profileId: string) {
    if (scope.legalEntityId === undefined) {
      return unreadRetailPermissions;
    }
    const readerFactory = yield* ProfileRetailPermissionReaderFactory;
    const readerScope = {
      legalEntityId: scope.legalEntityId,
      principalId: scope.principalId,
      tenantId: scope.tenantId,
    };
    return yield* prefetchRetailPermissions(readerFactory.make(readerScope), readerScope, [profileId]);
  },
);
