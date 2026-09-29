import { authenticationNamespaceRegistryLayer } from '@app/core-runtime/auth/external-identity-admission';
import { AuthenticationNamespaceRegistrationSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { staffAuthenticationNamespaceRegistration } from '@app/core-runtime/auth/staff-authentication-namespace';
import { Effect, Schema } from 'effect';

import { commerceCustomerContextApiContract } from '../../shared/api.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';

/**
 * Core revalidates the authentication namespace a presented session binding names before any
 * authorization runs, and answers `operation_context_unavailable` when no registry is installed at
 * all. This vertical serves portal sessions from its own runtime and staff sessions and API keys
 * through Shell-issued gateway assertions, so the registrations for both namespaces are a required
 * deployment input of every governed route here — not only of Shell, which registers the same
 * namespaces for its own audiences.
 *
 * The only audience registered is this vertical's own action-boundary audience, so an assertion
 * minted for another receiver is refused here rather than accepted because the namespace matched.
 * Admission-time re-verification stays Shell's: this runtime installs no external operation
 * authentication port, and a registration that demanded one would fail every session closed.
 */
const audiences = [commerceCustomerContextApiContract.ownerId];

export const CommerceAuthenticationNamespaceRegistryLive = authenticationNamespaceRegistryLayer(
  Effect.all(
    [
      Schema.decodeEffect(AuthenticationNamespaceRegistrationSchema)({
        allowedAudiences: audiences,
        authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
        provider: 'commerce-portal-better-auth',
        requiresOperationAdmission: false,
        reservationPrincipalKind: 'human',
        subjectTypes: ['user'],
        trustedAttesterPrincipalIds: [],
      }),
      staffAuthenticationNamespaceRegistration(audiences),
    ],
    { concurrency: 2 },
  ),
);
