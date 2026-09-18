import { AuthenticationNamespaceRegistry } from '@app/core-runtime/auth/external-identity-admission';
import { AuthenticationNamespaceIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '../../api/auth/authentication-namespace.ts';
import { StaffAuthenticationNamespaceRegistryLive } from '../../api/auth/authentication-namespace-registry.ts';
import { installedVerticalIds } from '../../api/verticals/installed-verticals.ts';

it.effect('constructs production staff trust without granting customer namespace authority', () =>
  Effect.gen(function* verifyProductionStaffRegistry() {
    const registry = yield* AuthenticationNamespaceRegistry;
    const registration = yield* registry
      .lookup(STAFF_AUTHENTICATION_NAMESPACE_ID)
      .pipe(Effect.flatMap(Effect.fromOption));
    const installedAudiences = yield* installedVerticalIds;
    expect(registration.allowedAudiences).toEqual(['shell-super-app', ...installedAudiences]);
    expect(registration.subjectTypes).toEqual(['user', 'api_key']);
    expect(registration.requiresOperationAdmission).toBe(false);
    expect(registration.trustedAttesterPrincipalIds).toEqual([]);
    const unregisteredNamespace = yield* Schema.decodeEffect(AuthenticationNamespaceIdSchema)(
      'unregistered.customer.provider.v1',
    );
    expect(Option.isNone(yield* registry.lookup(unregisteredNamespace))).toBe(true);
  }).pipe(Effect.provide(StaffAuthenticationNamespaceRegistryLive)),
);
