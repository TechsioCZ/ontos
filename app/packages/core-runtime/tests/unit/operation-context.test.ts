/* eslint-disable no-await-in-loop -- Ordered cases make fail-closed classification diagnostics readable. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import { makeOperationalScopeResolver } from '../../src/operations/context.ts';

const principal = {
  authBindingId: '00000000-0000-4000-8000-000000000004',
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
