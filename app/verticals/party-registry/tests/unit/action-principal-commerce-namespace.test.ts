import { partyRegistryBackendRegistration } from '../../vertical.runtime-declaration.ts';
import {
  ActionPermissionDenied,
  OperationAuthenticationRequired,
  OperationContextDenied,
  OperationContextUnavailable,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { AuthenticationNamespaceRegistry } from '@app/core-runtime/auth/external-identity-admission';
import { AuthenticationNamespaceIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeOperationalScopeResolver } from '@app/core-runtime/operations/context';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { requestSearchRebuildAction } from '../../src/actions/request-search-rebuild.action.ts';
import { PartyRegistryAuthenticationNamespaceRegistryLive } from '../../api/auth/action-principal.ts';

// Explicit own receiving deployment audience; the approved owner root keeps its constant private.
const ACTION_GATEWAY_AUDIENCE = 'party-registry' as const;
// Canonical CCC-owned protocol namespace, explicitly configured here as approved trusted deployment data.
// No Party->CCC runtime/package dependency is introduced merely to repeat this deployment value.
const COMMERCE_NAMESPACE = 'ontos.commerce.portal.better-auth.v1';
const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '10000000-0000-4000-8000-000000000003',
  authContextRef: 'receiver-unit-commerce-session',
  authenticationNamespaceId: COMMERCE_NAMESPACE,
  authMethod: 'session',
  legalEntityId: '10000000-0000-4000-8000-000000000004',
  principalId: '10000000-0000-4000-8000-000000000002',
  tenantId: '10000000-0000-4000-8000-000000000001',
});
// Explicit unit persisted-context controls; these do not prove real provider/session admission.
const active = {
  bindingAuthenticationNamespaceId: COMMERCE_NAMESPACE,
  bindingPrincipalId: principal.principalId,
  bindingRevokedAt: null,
  bindingStatus: 'active',
  bindingSubjectType: 'user',
  bindingTenantId: principal.tenantId,
  legalEntityStatus: 'active',
  legalEntityTenantId: principal.tenantId,
  principalStatus: 'active',
  principalTenantId: principal.tenantId,
  tenantStatus: 'active',
};
const legalEntityAccess = {
  legalEntities: ({ legalEntityIds }: { readonly legalEntityIds: readonly string[] }) =>
    Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
};
const request = {
  audience: ACTION_GATEWAY_AUDIENCE,
  correlationId: 'receiver-unit',
  legalEntityScope: 'required' as const,
  principal,
};

it.layer(Layer.mergeAll(NodeCrypto.layer, PartyRegistryAuthenticationNamespaceRegistryLive))(
  'owner Commerce receiver registration',
  (suite) => {
    suite.effect('registers canonical Commerce and unchanged staff for only this receiving audience', () =>
      Effect.gen(function* registrations() {
        const registry = yield* AuthenticationNamespaceRegistry;
        const commerce = yield* registry.lookup(AuthenticationNamespaceIdSchema.make(COMMERCE_NAMESPACE));
        expect(Option.isSome(commerce)).toBe(true);
        if (Option.isSome(commerce)) {
          expect(commerce.value).toEqual({
            allowedAudiences: [ACTION_GATEWAY_AUDIENCE],
            authenticationNamespaceId: COMMERCE_NAMESPACE,
            provider: 'commerce-portal-better-auth',
            requiresOperationAdmission: false,
            reservationPrincipalKind: 'human',
            subjectTypes: ['user'],
            trustedAttesterPrincipalIds: [],
          });
        }
        const staff = yield* registry.lookup(STAFF_AUTHENTICATION_NAMESPACE_ID);
        expect(Option.isSome(staff)).toBe(true);
        if (Option.isSome(staff)) {
          expect(staff.value).toEqual({
            allowedAudiences: [ACTION_GATEWAY_AUDIENCE],
            authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
            provider: 'better-auth',
            requiresOperationAdmission: false,
            reservationPrincipalKind: 'human',
            subjectTypes: ['user', 'api_key'],
            trustedAttesterPrincipalIds: [],
          });
        }
        expect(
          Option.isNone(yield* registry.lookup(AuthenticationNamespaceIdSchema.make('ontos.unit.unregistered.v1'))),
        ).toBe(true);
      }),
    );
    suite.effect('the real Core resolver preserves exact Commerce identity and both existing staff subject types', () =>
      Effect.gen(function* acceptedContexts() {
        const resolver = yield* makeOperationalScopeResolver({ load: () => Effect.succeed(active) }, legalEntityAccess);
        expect(yield* resolver.resolve(request)).toEqual({ ...principal, correlationId: request.correlationId });
        for (const authMethod of ['session', 'api_key'] as const) {
          const staffPrincipal = {
            ...principal,
            authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
            authMethod,
          };
          const staffResolver = yield* makeOperationalScopeResolver(
            {
              load: () =>
                Effect.succeed({
                  ...active,
                  bindingAuthenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
                  bindingSubjectType: authMethod === 'api_key' ? 'api_key' : 'user',
                }),
            },
            legalEntityAccess,
          );
          const resolved = yield* staffResolver.resolve({ ...request, principal: staffPrincipal });
          expect(resolved).toEqual({ ...staffPrincipal, correlationId: request.correlationId });
        }
      }),
    );
    suite.effect(
      'rejects foreign audience, unregistered namespace and Commerce API-key subjects before business work',
      () =>
        Effect.gen(function* rejectedMetadata() {
          const resolver = yield* makeOperationalScopeResolver(
            { load: () => Effect.succeed(active) },
            legalEntityAccess,
          );
          const { authBindingId: _authBindingId, ...withoutBinding } = principal;
          const { authContextRef: _authContextRef, ...withoutContext } = principal;
          for (const input of [
            { ...request, audience: 'foreign-receiver' },
            { ...request, principal: { ...principal, authenticationNamespaceId: 'ontos.unit.unregistered.v1' } },
            { ...request, principal: { ...principal, authMethod: 'api_key' as const } },
            { ...request, principal: withoutBinding },
            { ...request, principal: withoutContext },
          ]) {
            const rejected = yield* resolver.resolve(input).pipe(Effect.flip);
            expect(Schema.is(OperationAuthenticationRequired)(rejected)).toBe(true);
          }
        }),
    );
    suite.effect(
      'revalidates actual persisted binding, Principal, Tenant and Legal Entity instead of trusting namespace registration',
      () =>
        Effect.gen(function* rejectedPersistedContexts() {
          const records = [
            { ...active, bindingStatus: 'disabled' },
            { ...active, bindingRevokedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-20T00:00:00.000Z')) },
            { ...active, bindingAuthenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID },
            { ...active, bindingPrincipalId: '10000000-0000-4000-8000-000000000099' },
            { ...active, bindingTenantId: '10000000-0000-4000-8000-000000000099' },
            { ...active, bindingSubjectType: 'api_key' },
            { ...active, principalStatus: 'disabled' },
            { ...active, principalTenantId: '10000000-0000-4000-8000-000000000099' },
            { ...active, tenantStatus: 'disabled' },
            { ...active, legalEntityStatus: 'disabled' },
            { ...active, legalEntityTenantId: '10000000-0000-4000-8000-000000000099' },
          ];
          for (const record of records) {
            const resolver = yield* makeOperationalScopeResolver(
              { load: () => Effect.succeed(record) },
              legalEntityAccess,
            );
            const rejected = yield* resolver.resolve(request).pipe(Effect.flip);
            expect(Schema.is(Schema.Union([OperationAuthenticationRequired, OperationContextDenied]))(rejected)).toBe(
              true,
            );
          }
          const unavailable = yield* makeOperationalScopeResolver(
            {
              load: () =>
                Effect.fail(
                  new OperationContextUnavailable({
                    code: 'operation_context_unavailable',
                    reason: 'Unit persisted owner context unavailable',
                  }),
                ),
            },
            legalEntityAccess,
          );
          expect(Schema.is(OperationContextUnavailable)(yield* unavailable.resolve(request).pipe(Effect.flip))).toBe(
            true,
          );
        }),
    );
    suite.effect('Commerce registration leaves normal Action and Tenant permission gates in force', () =>
      Effect.gen(function* ordinaryActionPermissions() {
        const deniedHarness = yield* makeActionTestHarness({ ownerRegistration: partyRegistryBackendRegistration });
        const input = {
          audience: ACTION_GATEWAY_AUDIENCE,
          payload: {},
          principal,
          registration: requestSearchRebuildAction,
          transport: { correlationId: 'receiver-action', idempotencyKey: 'receiver-action' },
        };
        expect(Schema.is(ActionPermissionDenied)(yield* deniedHarness.runtime.runAction(input).pipe(Effect.flip))).toBe(
          true,
        );
        expect(deniedHarness.snapshot().committed.length).toBe(0);
        const tenantDeniedHarness = yield* makeActionTestHarness({
          ownerRegistration: partyRegistryBackendRegistration,
          actionPermission: 'allowed',
          tenantPermission: 'denied',
        });
        expect(
          Schema.is(ActionPermissionDenied)(yield* tenantDeniedHarness.runtime.runAction(input).pipe(Effect.flip)),
        ).toBe(true);
        expect(tenantDeniedHarness.snapshot().committed.length).toBe(0);
        expect(tenantDeniedHarness.snapshot().stages.includes('handler_executed')).toBe(false);
        const allowedHarness = yield* makeActionTestHarness({
          ownerRegistration: partyRegistryBackendRegistration,
          actionPermission: 'allowed',
          tenantPermission: 'allowed',
        });
        expect((yield* allowedHarness.runtime.runAction(input)).status).toBe('QUEUED');
        expect(allowedHarness.snapshot().committed.length).toBe(1);
      }),
    );
  },
);
it.layer(NodeCrypto.layer)('missing receiving registry', (suite) => {
  suite.effect('a genuine external namespace remains unavailable without any receiving registry', () =>
    Effect.gen(function* missingRegistry() {
      const resolver = yield* makeOperationalScopeResolver({ load: () => Effect.succeed(active) }, legalEntityAccess);
      expect(Schema.is(OperationContextUnavailable)(yield* resolver.resolve(request).pipe(Effect.flip))).toBe(true);
    }),
  );
});
