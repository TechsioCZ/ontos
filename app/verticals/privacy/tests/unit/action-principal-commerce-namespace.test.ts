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
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '@app/commerce-customer-context/portal-auth/contracts';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { acknowledgePrivacyNoticeAction } from '../../src/actions/acknowledge-privacy-notice.action.ts';
import { PrivacyNoticeAcknowledgementError } from '../../shared/resources/privacy-notice-acknowledgement.ts';
import { PrivacyNoticePresentationUnavailableLive } from '../../src/services/privacy-notice-presentation.service.ts';
import { CommerceCustomerContextNoticeSubjectAuthorityUnavailableLive } from '../../src/integrations/commerce-customer-context/commerce-customer-context-notice-subject-authority.service.ts';
import {
  ACTION_GATEWAY_AUDIENCE,
  PrivacyAuthenticationNamespaceRegistryLive,
} from '../../api/auth/action-principal.ts';

const COMMERCE_NAMESPACE = COMMERCE_AUTHENTICATION_NAMESPACE_ID;
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

it.layer(Layer.mergeAll(NodeCrypto.layer, PrivacyAuthenticationNamespaceRegistryLive))(
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
            subjectTypes: ['user', 'api_key', 'oauth_grant'],
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
    suite.effect('Commerce registration leaves the real acknowledgement executor gate closed', () =>
      Effect.gen(function* deniedAction() {
        let called = false;
        const harness = yield* makeActionTestHarness({
          services: [
            bindActionTestServices(acknowledgePrivacyNoticeAction, {
              acknowledge: () =>
                Effect.sync(() => {
                  called = true;
                }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new PrivacyNoticeAcknowledgementError({
                        code: 'privacy_notice_acknowledgement_invalid',
                        reason: 'Unit handler reached',
                      }),
                    ),
                  ),
                ),
            }),
          ],
        });
        const denied = yield* harness.runtime
          .runAction({
            audience: ACTION_GATEWAY_AUDIENCE,
            payload: { acknowledged: true, presentationReceipt: 'unit-encoded-receipt' },
            principal,
            registration: acknowledgePrivacyNoticeAction,
            transport: { correlationId: 'receiver-action-denied', idempotencyKey: 'receiver-action-denied' },
          })
          .pipe(
            Effect.provide(
              Layer.mergeAll(
                PrivacyNoticePresentationUnavailableLive,
                CommerceCustomerContextNoticeSubjectAuthorityUnavailableLive,
              ),
            ),
            Effect.flip,
          );
        expect(Schema.is(ActionPermissionDenied)(denied)).toBe(true);
        expect(called).toBe(false);
        expect(harness.snapshot().committed.length).toBe(0);
      }),
    );
  },
);
it.effect('a genuine external namespace remains unavailable without any receiving registry', () =>
  Effect.gen(function* missingRegistry() {
    const resolver = yield* makeOperationalScopeResolver({ load: () => Effect.succeed(active) }, legalEntityAccess);
    expect(Schema.is(OperationContextUnavailable)(yield* resolver.resolve(request).pipe(Effect.flip))).toBe(true);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);
