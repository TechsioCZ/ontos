import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistryEffect,
} from '@app/core-runtime/auth/external-identity-admission';
import { AuthenticationNamespaceRegistrationSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { Effect, Layer, Schema } from 'effect';

import { installedVerticalIds } from '../verticals/installed-verticals.ts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from './authentication-namespace.ts';

/** Staff provider trust is owned by this Shell deployment and its installed topology. */
export const StaffAuthenticationNamespaceRegistryLive = Layer.effect(
  AuthenticationNamespaceRegistry,
  Effect.gen(function* staffAuthenticationNamespaceRegistry() {
    const audiences = yield* installedVerticalIds;
    const registration = yield* Schema.decodeEffect(AuthenticationNamespaceRegistrationSchema)({
      allowedAudiences: ['shell-super-app', ...audiences],
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      provider: 'better-auth',
      requiresOperationAdmission: false,
      reservationPrincipalKind: 'human',
      subjectTypes: ['user', 'api_key'],
      trustedAttesterPrincipalIds: [],
    });
    return yield* makeAuthenticationNamespaceRegistryEffect([registration]);
  }),
);
