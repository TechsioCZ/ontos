// @effect-diagnostics asyncFunction:off globalDate:off
/* eslint-disable no-await-in-loop -- Ordered cases make fail-closed classification diagnostics readable. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import {
  makeSystemPrincipalContextResolver,
  registerSystemWorkload,
} from '../../src/auth/system-principal-context.ts';
import { makeSupportRecoveryPrincipalContextResolver } from '../../src/auth/support-recovery-principal-context.ts';
import {
  decodeTrustedPrincipalContext,
  isTrustedSupportRecoveryPrincipalContext,
} from '../../src/auth/system-principal-context-provenance.ts';
import { makeOperationalScopeResolver } from '../../src/operations/context.ts';
import { recordSupportImpersonationAction } from '../../src/modules/actions/record-support-impersonation.action.ts';

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

test('classifies required, optional, forbidden, denied, unavailable, and valid scope before handlers', async () => {
  const repository = { load: () => Effect.succeed(active) };
  const allowed = makeOperationalScopeResolver(repository, access('allowed'));
  const valid = await Effect.runPromise(
    allowed.resolve({ correlationId: 'c-1', legalEntityScope: 'required', principal }),
  );
  const { legalEntityId: _legalEntityId, ...principalWithoutLegalEntity } = principal;
  const missing = await Effect.runPromise(
    Effect.flip(
      allowed.resolve({
        correlationId: 'c-1',
        legalEntityScope: 'required',
        principal: principalWithoutLegalEntity,
      }),
    ),
  );
  const forbidden = await Effect.runPromise(
    Effect.flip(
      allowed.resolve({ correlationId: 'c-1', legalEntityScope: 'forbidden', principal }),
    ),
  );
  const denied = await Effect.runPromise(
    Effect.flip(
      makeOperationalScopeResolver(repository, access('denied')).resolve({
        correlationId: 'c-1',
        legalEntityScope: 'optional',
        principal,
      }),
    ),
  );
  const unavailable = await Effect.runPromise(
    Effect.flip(
      makeOperationalScopeResolver(repository, access('unavailable')).resolve({
        correlationId: 'c-1',
        legalEntityScope: 'optional',
        principal,
      }),
    ),
  );

  assert.equal(Object.isFrozen(valid), true);
  assert.equal(missing._tag, 'OperationContextDenied');
  assert.equal(forbidden._tag, 'OperationContextInvalid');
  assert.equal(denied._tag, 'OperationContextDenied');
  assert.equal(unavailable._tag, 'OperationContextUnavailable');
});

test('rejects stale tenant, principal, revoked auth binding, and cross-tenant entity records', async () => {
  for (const record of [
    { ...active, tenantStatus: 'suspended' },
    { ...active, principalStatus: 'disabled' },
    { ...active, bindingRevokedAt: new Date('2026-01-01T00:00:00.000Z') },
    { ...active, bindingTenantId: '00000000-0000-4000-8000-000000000099' },
    { ...active, legalEntityTenantId: '00000000-0000-4000-8000-000000000099' },
  ]) {
    const resolver = makeOperationalScopeResolver(
      { load: () => Effect.succeed(record) },
      access('allowed'),
    );
    const error = await Effect.runPromise(
      Effect.flip(
        resolver.resolve({ correlationId: 'c-1', legalEntityScope: 'required', principal }),
      ),
    );
    assert.match(error._tag, /^Operation(?:AuthenticationRequired|ContextDenied)$/u);
  }
});

test('preserves resolver-issued system provenance across operational scope construction', async () => {
  const systemContext = await Effect.runPromise(
    makeSystemPrincipalContextResolver({
      executor: {
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: () =>
                  Promise.resolve([
                    { kind: 'system', principalStatus: 'active', tenantStatus: 'active' },
                  ]),
              }),
            }),
          }),
        }),
      } as never,
    }).resolve({
      principalId: principal.principalId,
      registration: registerSystemWorkload({ jobKey: 'operation-scope-test' }),
      runReference: 'run-1',
      tenantId: principal.tenantId,
    }),
  );
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

  const scope = await Effect.runPromise(
    resolver.resolve({
      correlationId: 'system-correlation',
      legalEntityScope: 'forbidden',
      principal: systemContext,
    }),
  );

  assert.equal(scope.authMethod, 'system');
  assert.equal(scope.correlationId, 'system-correlation');
  const decoded = await Effect.runPromise(decodeTrustedPrincipalContext(scope));
  assert.equal(decoded.authMethod, 'system');
  assert.equal(decoded.principalId, scope.principalId);
  await assert.rejects(Effect.runPromise(decodeTrustedPrincipalContext({ ...scope })));
});

test('permits only a resolver-branded support-stop recovery through inactive historical scope', async () => {
  const recoveryPrincipal = await Effect.runPromise(
    makeSupportRecoveryPrincipalContextResolver({
      executor: {
        select: () => ({
          from: () => {
            const query = {
              innerJoin: () => query,
              where: () => ({
                limit: () =>
                  Promise.resolve([
                    {
                      bindingPrincipalId: principal.principalId,
                      bindingTenantId: principal.tenantId,
                      principalKind: 'human',
                      principalTenantId: principal.tenantId,
                      tenantId: principal.tenantId,
                    },
                  ]),
              }),
            };
            return query;
          },
        }),
      } as never,
    }).resolveStoppedImpersonation({
      originalAuthBindingId: principal.authBindingId,
      originalPrincipalId: principal.principalId,
      originalSessionId: 'expired-original-session',
      tenantId: principal.tenantId,
    }),
  );
  const resolver = makeOperationalScopeResolver(
    {
      load: () =>
        Effect.succeed({
          ...active,
          bindingRevokedAt: new Date('2026-08-09T00:00:00.000Z'),
          bindingStatus: 'revoked',
          principalStatus: 'disabled',
          tenantStatus: 'suspended',
        }),
    },
    access('allowed'),
  );

  const scope = await Effect.runPromise(
    resolver.resolve({
      correlationId: 'support-recovery',
      legalEntityScope: 'optional',
      principal: recoveryPrincipal,
    }),
  );

  assert.equal(
    isTrustedSupportRecoveryPrincipalContext(scope, recordSupportImpersonationAction),
    true,
  );
  assert.equal(isTrustedSupportRecoveryPrincipalContext(scope, {}), false);
  assert.equal(isTrustedSupportRecoveryPrincipalContext({ ...scope }), false);
});
