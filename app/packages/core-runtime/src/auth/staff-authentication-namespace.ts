import { Effect, Result, Schema } from 'effect';

import {
  AuthenticationNamespaceIdSchema,
  AuthenticationNamespaceRegistrationSchema,
} from './external-identity-contracts.ts';
import { authenticationNamespaceRegistryLayer } from './external-identity/verifier.ts';

/** The namespace the Shell's staff provider (Better Auth) binds users and API keys in. */
export const STAFF_AUTHENTICATION_NAMESPACE_ID = Result.getOrThrow(
  Schema.decodeResult(AuthenticationNamespaceIdSchema)('ontos.staff.better-auth.v1'),
);

/**
 * The staff namespace registration for the given receiving audiences. Every Shell-issued gateway
 * assertion for a staff session or API key names this namespace, and Core revalidates it against
 * the receiving runtime's registry before any authorization runs, so each runtime that serves
 * those assertions registers it for exactly the audiences it serves.
 */
export const staffAuthenticationNamespaceRegistration = (allowedAudiences: readonly string[]) =>
  Schema.decodeEffect(AuthenticationNamespaceRegistrationSchema)({
    allowedAudiences,
    authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
    provider: 'better-auth',
    requiresOperationAdmission: false,
    reservationPrincipalKind: 'human',
    subjectTypes: ['user', 'api_key'],
    trustedAttesterPrincipalIds: [],
  });

/** A registry holding only the staff namespace, registered for the given receiving audiences. */
export const staffAuthenticationNamespaceRegistryLayer = (allowedAudiences: readonly string[]) =>
  authenticationNamespaceRegistryLayer(
    staffAuthenticationNamespaceRegistration(allowedAudiences).pipe(Effect.map((registration) => [registration])),
  );
