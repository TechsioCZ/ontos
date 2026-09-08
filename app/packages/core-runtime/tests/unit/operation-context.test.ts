import { expect, it } from 'effect-rstest';
import { DateTime, Effect, Exit, Option, Schema } from 'effect';
import { supportRecoveryPrincipalContextResolverFromRepository } from '../../src/auth/support-recovery-principal-context.ts';
import {
  decodeTrustedPrincipalContext,
  isTrustedSupportRecoveryPrincipalContext,
} from '../../src/auth/system-principal-context-provenance.ts';
import {
  registerSystemWorkload,
  systemPrincipalContextResolverFromRepository,
} from '../../src/auth/system-principal-context.ts';
import { recordSupportImpersonationAction } from '../../src/modules/actions/record-support-impersonation.action.ts';
import { makeOperationalScopeResolver } from '../../src/operations/context.ts';
import {
  OperationAuthenticationRequired,
  OperationContextDenied,
  OperationContextInvalid,
  OperationContextUnavailable,
} from '../../src/operations/errors.ts';

const principal = {
  authBindingId: '00000000-0000-4000-8000-000000000004',
  authContextRef: 'better-auth-session:test-session',
  authMethod: 'session' as const,
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
};
const active = {
  bindingPrincipalId: principal.principalId,
  bindingRevokedAt: null,
  bindingStatus: 'active',
  bindingTenantId: principal.tenantId,
  legalEntityStatus: 'active',
  legalEntityTenantId: principal.tenantId,
  principalStatus: 'active',
  principalTenantId: principal.tenantId,
  tenantStatus: 'active',
};
const access = (decision: 'allowed' | 'denied' | 'unavailable') => ({
  legalEntities: ({ legalEntityIds }: { readonly legalEntityIds: readonly string[] }) =>
    Effect.succeed(legalEntityIds.map((key) => ({ decision, key }))),
  modules: () => Effect.succeed([]),
  resources: () => Effect.succeed([]),
});
const InactiveContextError = Schema.Union([
  OperationAuthenticationRequired,
  OperationContextDenied,
]);

it.effect(
  'classifies required, optional, forbidden, denied, unavailable, and valid scope before handlers',
  () =>
    Effect.gen(function* scopeClassification() {
      const repository = { load: () => Effect.succeed(active) };
      const allowed = makeOperationalScopeResolver(repository, access('allowed'));
      const valid = yield* allowed.resolve({
        correlationId: 'c-1',
        legalEntityScope: 'required',
        principal,
      });
      const { legalEntityId: _legalEntityId, ...principalWithoutLegalEntity } = principal;
      const missing = yield* Effect.flip(
        allowed.resolve({
          correlationId: 'c-1',
          legalEntityScope: 'required',
          principal: principalWithoutLegalEntity,
        }),
      );
      const forbidden = yield* Effect.flip(
        allowed.resolve({ correlationId: 'c-1', legalEntityScope: 'forbidden', principal }),
      );
      const denied = yield* Effect.flip(
        makeOperationalScopeResolver(repository, access('denied')).resolve({
          correlationId: 'c-1',
          legalEntityScope: 'optional',
          principal,
        }),
      );
      const unavailable = yield* Effect.flip(
        makeOperationalScopeResolver(repository, access('unavailable')).resolve({
          correlationId: 'c-1',
          legalEntityScope: 'optional',
          principal,
        }),
      );

      expect(Object.isFrozen(valid)).toBe(true);
      expect(Schema.is(OperationContextDenied)(missing)).toBe(true);
      expect(Schema.is(OperationContextInvalid)(forbidden)).toBe(true);
      expect(Schema.is(OperationContextDenied)(denied)).toBe(true);
      expect(Schema.is(OperationContextUnavailable)(unavailable)).toBe(true);
    }),
);

it.effect(
  'rejects stale tenant, principal, revoked auth binding, and cross-tenant entity records',
  () =>
    Effect.gen(function* staleContextRecords() {
      const records = [
        { ...active, tenantStatus: 'suspended' },
        { ...active, principalStatus: 'disabled' },
        {
          ...active,
          bindingRevokedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T00:00:00.000Z')),
        },
        { ...active, bindingTenantId: '00000000-0000-4000-8000-000000000099' },
        { ...active, legalEntityTenantId: '00000000-0000-4000-8000-000000000099' },
      ];
      const errors = yield* Effect.forEach(
        records,
        (record) => {
          const resolver = makeOperationalScopeResolver(
            { load: () => Effect.succeed(record) },
            access('allowed'),
          );
          return Effect.flip(
            resolver.resolve({ correlationId: 'c-1', legalEntityScope: 'required', principal }),
          );
        },
        { concurrency: 1 },
      );
      for (const error of errors) {
        expect(Schema.is(InactiveContextError)(error)).toBe(true);
      }
    }),
);

it.effect('preserves resolver-issued system provenance across operational scope construction', () =>
  Effect.gen(function* systemProvenance() {
    const systemContext = yield* systemPrincipalContextResolverFromRepository({
      load: () =>
        Effect.succeed({
          kind: 'system' as const,
          principalStatus: 'active' as const,
          tenantStatus: 'active' as const,
        }).pipe(Effect.map(Option.some)),
    }).resolve({
      principalId: principal.principalId,
      registration: registerSystemWorkload({ jobKey: 'operation-scope-test' }),
      runReference: 'run-1',
      tenantId: principal.tenantId,
    });
    const resolver = makeOperationalScopeResolver(
      {
        load: () =>
          Effect.succeed({
            ...active,
            bindingPrincipalId: null,
            bindingStatus: null,
            bindingTenantId: null,
            legalEntityStatus: null,
            legalEntityTenantId: null,
          }),
      },
      access('allowed'),
    );

    const scope = yield* resolver.resolve({
      correlationId: 'system-correlation',
      legalEntityScope: 'forbidden',
      principal: systemContext,
    });

    expect(scope.authMethod).toBe('system');
    expect(scope.correlationId).toBe('system-correlation');
    const decoded = yield* decodeTrustedPrincipalContext(scope);
    expect(decoded.authMethod).toBe('system');
    expect(decoded.principalId).toBe(scope.principalId);
    const untrusted = yield* Effect.exit(decodeTrustedPrincipalContext({ ...scope }));
    expect(Exit.isFailure(untrusted)).toBe(true);
  }),
);

it.effect(
  'permits only a resolver-branded support-stop recovery through inactive historical scope',
  () =>
    Effect.gen(function* supportRecovery() {
      const recoveryPrincipal = yield* supportRecoveryPrincipalContextResolverFromRepository({
        load: () =>
          Effect.succeed({
            bindingPrincipalId: principal.principalId,
            bindingTenantId: principal.tenantId,
            principalKind: 'human' as const,
            principalTenantId: principal.tenantId,
            tenantId: principal.tenantId,
          }).pipe(Effect.map(Option.some)),
      }).resolveStoppedImpersonation({
        originalAuthBindingId: principal.authBindingId,
        originalPrincipalId: principal.principalId,
        originalSessionId: 'expired-original-session',
        tenantId: principal.tenantId,
      });
      const resolver = makeOperationalScopeResolver(
        {
          load: () =>
            Effect.succeed({
              ...active,
              bindingRevokedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-08-09T00:00:00.000Z')),
              bindingStatus: 'revoked',
              principalStatus: 'disabled',
              tenantStatus: 'suspended',
            }),
        },
        access('allowed'),
      );

      const scope = yield* resolver.resolve({
        correlationId: 'support-recovery',
        legalEntityScope: 'optional',
        principal: recoveryPrincipal,
      });

      expect(
        isTrustedSupportRecoveryPrincipalContext(scope, recordSupportImpersonationAction),
      ).toBe(true);
      expect(isTrustedSupportRecoveryPrincipalContext(scope, {})).toBe(false);
      expect(isTrustedSupportRecoveryPrincipalContext({ ...scope })).toBe(false);
    }),
);
