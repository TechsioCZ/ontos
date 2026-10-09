import { OperationAuthenticationRequired } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeOperationalScopeResolver } from '@app/core-runtime/operations/context';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { Effect, Layer, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { expect, it } from 'effect-rstest';

import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';

/**
 * Every Shell-issued assertion for a staff session names the staff authentication namespace, and
 * Core revalidates it against the receiving runtime's registry before any authorization runs. This
 * runtime once installed no registry, so every governed read the Shell forwarded answered
 * `503 operation_context_unavailable` after authentication had already succeeded.
 */

const principalId = '40000000-0000-4000-8000-000000000001';
const tenantId = '50000000-0000-4000-8000-000000000001';

const staffPrincipal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '30000000-0000-4000-8000-000000000001',
  authContextRef: 'gateway-session-ref',
  authMethod: 'session',
  authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
  principalId,
  tenantId,
});

const resolver = makeOperationalScopeResolver(
  {
    load: () =>
      Effect.succeed({
        bindingAuthenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        bindingPrincipalId: principalId,
        bindingRevision: 1,
        bindingRevokedAt: null,
        bindingStatus: 'active' as const,
        bindingSubjectType: 'user' as const,
        bindingTenantId: tenantId,
        impersonatorStatus: null,
        impersonatorTenantId: null,
        legalEntityStatus: null,
        legalEntityTenantId: null,
        principalStatus: 'active' as const,
        principalTenantId: tenantId,
        tenantStatus: 'active' as const,
      }),
  },
  { legalEntities: () => Effect.succeed([]) },
);

const resolveFor = (audience: string) =>
  resolver.resolve({
    audience,
    correlationId: 'party-registry-staff-namespace',
    legalEntityScope: 'forbidden',
    principal: staffPrincipal,
  });

it.layer(
  ActionPrincipalVerifierLive.pipe(
    Layer.provide(ActiveApplicationCompositionSourceLive),
    Layer.provide(FetchHttpClient.layer),
  ),
)('party-registry action boundary', (suite) => {
  suite.effect('revalidates a Shell-issued staff principal for this audience', () =>
    Effect.gen(function* staffPrincipalResolves() {
      const scope = yield* resolveFor('party-registry');
      expect(scope.authenticationNamespaceId).toBe(STAFF_AUTHENTICATION_NAMESPACE_ID);
      expect(scope.principalId).toBe(principalId);
    }),
  );

  suite.effect('refuses a staff principal presented for another audience', () =>
    Effect.gen(function* otherAudienceRefused() {
      const failure = yield* Effect.flip(resolveFor('price-group-catalog'));
      expect(failure).toBeInstanceOf(OperationAuthenticationRequired);
    }),
  );
});
