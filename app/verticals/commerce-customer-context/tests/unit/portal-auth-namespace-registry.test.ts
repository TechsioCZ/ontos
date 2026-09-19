import { AuthenticationNamespaceRegistry } from '@app/core-runtime/auth/external-identity-admission';
import { AuthenticationNamespaceIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CommercePortalAuthenticationNamespaceRegistryLive } from '../../api/portal-auth/authentication-namespace-registry.ts';
import { commerceCustomerContextApiContract } from '../../shared/api.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';

/**
 * Core answers `operation_context_unavailable` when no registry is reachable and
 * `operation_authentication_required` when the registry has no registration for the namespace a
 * presented binding names, so a registration that does not build or does not match is the
 * difference between a served governed route and a blanket 503.
 */

const namespaceId = (value: string) => Schema.decodeSync(AuthenticationNamespaceIdSchema)(value);

const registryFor = Effect.fnUntraced(function* registryFor() {
  const context = yield* Layer.build(CommercePortalAuthenticationNamespaceRegistryLive);
  return Context.get(context, AuthenticationNamespaceRegistry);
});

it.effect('registers the Commerce portal namespace for this vertical’s own audience', () =>
  Effect.scoped(
    Effect.gen(function* registeredNamespace() {
      const registry = yield* registryFor();
      const found = yield* registry.lookup(namespaceId(COMMERCE_AUTHENTICATION_NAMESPACE_ID));
      expect(Option.isSome(found)).toBe(true);
      if (Option.isNone(found)) {
        return;
      }
      expect(found.value.allowedAudiences).toStrictEqual([commerceCustomerContextApiContract.ownerId]);
      expect(found.value.subjectTypes).toStrictEqual(['user']);
      // This runtime installs no external operation authentication port, so a registration that
      // demanded admission would fail every portal session closed.
      expect(found.value.requiresOperationAdmission).toBe(false);
    }),
  ),
);

it.effect('registers no other namespace', () =>
  Effect.scoped(
    Effect.gen(function* unregisteredNamespace() {
      const registry = yield* registryFor();
      expect(Option.isNone(yield* registry.lookup(namespaceId('ontos.staff.better-auth.v1')))).toBe(true);
    }),
  ),
);
