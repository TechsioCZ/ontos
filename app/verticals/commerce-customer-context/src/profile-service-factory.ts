import { readVerifiedGatewayActor, requireModuleOperation, OperationContextUnavailable } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { accessPortalWritesForTransaction } from '@app/core-runtime/access/portal';
import type { AccessPortalTransaction, AccessPortalWrites } from '@app/core-runtime/access/portal';
import { Crypto, Effect } from 'effect';

import { ProfileReactivationEligibilityEvaluatorFactory } from './integrations/profile-reactivation-eligibility.ts';
import {
  ProfilePersistenceDependencyFailure,
  profilePersistenceServicesForTransaction,
  profileReconciliationOwnerVerifierForTransaction,
} from './persistence/profile-persistence.ts';
import { addressBookReconciliationOwnerVerifierForTransaction } from './persistence/address-persistence.ts';
import { paymentTermsReconciliationOwnerEvidenceVerifierForTransaction } from './persistence/payment-term-persistence.ts';
import type {
  ProfilePersistenceServices,
  ProfilePersistenceDependencies,
  ProfilePersistenceScope,
  ProfileScopedRoutineInvoker,
} from './persistence/profile-persistence.ts';
import { ProfileCounterpartyRoleEligibilityResolverFactory } from './profile-counterparty-role-eligibility.ts';
import type { ProfileReconciliationOwnerVerifierService } from './profile-reconciliation-owner-verifier.ts';
import { PartyRegistryGuestResolverFactory } from './integrations/party-registry-guest-resolver.ts';
import { PartyRegistryRetailPartyResolverFactory } from './integrations/party-registry-retail-party-resolver.ts';

/** The calling module of this module's own enrollment continuation (`retail-owner-gateway-credential.ts`). */
const ENROLLMENT_CONTINUATION_APP_ID = 'commerce-customer-context';

const profileServicesFor = (
  transaction: ProfileScopedRoutineInvoker,
  scope: OperationalScope,
  portalAccess?: AccessPortalWrites,
  resolveEnrollmentTargetBinding?: ProfilePersistenceDependencies['resolveEnrollmentTargetBinding'],
): Effect.Effect<
  ProfilePersistenceServices,
  OperationContextUnavailable,
  | Crypto.Crypto
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
    verifiedScope = { ...verifiedScope, authBindingId: scope.authBindingId };
  }
  if (readVerifiedGatewayActor(scope)?.appId === ENROLLMENT_CONTINUATION_APP_ID) {
    verifiedScope = { ...verifiedScope, enrollmentContinuation: true };
  }
  return Effect.gen(function* profileServices() {
    const roleResolverFactory = yield* ProfileCounterpartyRoleEligibilityResolverFactory;
    const reactivationEvaluatorFactory = yield* ProfileReactivationEligibilityEvaluatorFactory;
    const guestResolverFactory = yield* PartyRegistryGuestResolverFactory;
    const crypto = yield* Crypto.Crypto;
    const retailPartyResolverFactory = yield* PartyRegistryRetailPartyResolverFactory;
    const resolveCounterpartyRole = roleResolverFactory.make({
      legalEntityId: verifiedScope.legalEntityId,
      operationalScope: scope,
      requestCorrelation: scope.correlationId,
      tenantId: verifiedScope.tenantId,
    });
    const evaluateReactivation = reactivationEvaluatorFactory.make({
      resolveCounterpartyRole,
      scope: verifiedScope,
      transaction,
    });
    const guestParty = guestResolverFactory.make({ crypto, scope });
    const retailParty = retailPartyResolverFactory.make({
      legalEntityId: verifiedScope.legalEntityId,
      principalId: verifiedScope.principalId,
      requestCorrelation: scope.correlationId,
      tenantId: verifiedScope.tenantId,
    });
    const resolveGuestParty: typeof guestParty = (input) =>
      requireModuleOperation('commerce.customer-context.requirement.attribute-guest-retail-customer-party').pipe(
        Effect.mapError((cause) =>
          Object.defineProperty(
            new ProfilePersistenceDependencyFailure({ reason: 'Required Party guest resolution is unavailable' }),
            'cause',
            { configurable: true, value: cause },
          ),
        ),
        Effect.flatMap(() => guestParty(input)),
      );
    const resolveRetailParty: typeof retailParty = (input) =>
      requireModuleOperation('commerce.customer-context.requirement.ensure-retail-customer-profile-party').pipe(
        Effect.mapError((cause) =>
          Object.defineProperty(
            new ProfilePersistenceDependencyFailure({ reason: 'Required Party identity resolution is unavailable' }),
            'cause',
            { configurable: true, value: cause },
          ),
        ),
        Effect.flatMap(() => retailParty(input)),
      );
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
    const targetBinding =
      readVerifiedGatewayActor(scope)?.appId === ENROLLMENT_CONTINUATION_APP_ID
        ? resolveEnrollmentTargetBinding
        : undefined;
    let dependencies: ProfilePersistenceDependencies = {
      evaluateReactivation,
      reconciliationOwnerVerifier,
      resolveCounterpartyRole,
      resolveGuestParty,
      resolveRetailParty,
    };
    if (targetBinding !== undefined) {
      dependencies = { ...dependencies, resolveEnrollmentTargetBinding: targetBinding };
    }
    return profilePersistenceServicesForTransaction(
      transaction,
      verifiedScope,
      portalAccess === undefined ? dependencies : { ...dependencies, portalAccess },
    );
  });
};

export const profileServicesForVerifiedScope = (transaction: ProfileScopedRoutineInvoker, scope: OperationalScope) =>
  profileServicesFor(transaction, scope);

/**
 * The profile services of a Retail Portal binding Action: a binding and the bound person's portal access
 * commit in the Action's one transaction, so the binding services carry Core's portal writes over it.
 */
export const retailPortalBindingServicesForVerifiedScope = (
  transaction: ProfileScopedRoutineInvoker & AccessPortalTransaction,
  scope: OperationalScope,
  resolveEnrollmentTargetBinding?: ProfilePersistenceDependencies['resolveEnrollmentTargetBinding'],
) =>
  profileServicesFor(
    transaction,
    scope,
    accessPortalWritesForTransaction(transaction, scope),
    resolveEnrollmentTargetBinding,
  );
