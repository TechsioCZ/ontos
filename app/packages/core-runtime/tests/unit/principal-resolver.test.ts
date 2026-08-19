/* eslint-disable no-await-in-loop -- Sequential mode assertions retain the failing principal kind. */
import assert from 'node:assert/strict';
// @effect-diagnostics anyUnknownInErrorContext:off asyncFunction:off globalDate:off
import test from 'node:test';
import { Effect } from 'effect';
import {
  classifyAvailableTenants,
  classifyApiKeyPrincipal,
  classifyDefaultPrincipal,
  classifySelectedPrincipal,
  listAvailableTenantsFromRepository,
} from '../../src/auth/principal-resolver.ts';
import type { PrincipalResolutionRecord } from '../../src/auth/principal-resolver.ts';
import type { PrincipalResolutionError } from '../../src/auth/principal-resolver-errors.ts';

const activeRecord: PrincipalResolutionRecord = {
  authBindingId: 'binding-1',
  bindingCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
  bindingRevokedAt: null,
  bindingStatus: 'active',
  displayName: 'Ada Lovelace',
  principalId: 'principal-1',
  principalKind: 'human',
  principalStatus: 'active',
  tenantId: 'tenant-1',
  tenantName: 'Zeta tenant',
  tenantStatus: 'active',
};

const failureTag = async (
  effect: Effect.Effect<unknown, PrincipalResolutionError>,
): Promise<string> => {
  const error = await Effect.runPromise(Effect.flip(effect));
  return error._tag;
};

test('lists safe eligible tenants by name and tenant ID', async () => {
  const records = [
    activeRecord,
    {
      ...activeRecord,
      bindingCreatedAt: new Date('2026-02-01T00:00:00.000Z'),
      displayName: 'Grace Hopper',
      principalId: 'principal-2',
      tenantId: 'tenant-2',
      tenantName: 'Alpha tenant',
    },
    {
      ...activeRecord,
      principalId: 'principal-3',
      tenantId: 'tenant-3',
      tenantName: 'Alpha tenant',
    },
    {
      ...activeRecord,
      bindingStatus: 'disabled',
      principalId: 'principal-disabled',
      tenantId: 'tenant-disabled',
      tenantName: 'Hidden binding',
    },
    {
      ...activeRecord,
      principalId: 'principal-inactive',
      principalStatus: 'disabled',
      tenantId: 'tenant-principal-inactive',
      tenantName: 'Hidden principal',
    },
    {
      ...activeRecord,
      principalId: 'principal-suspended',
      tenantId: 'tenant-suspended',
      tenantName: 'Hidden tenant',
      tenantStatus: 'suspended',
    },
  ];

  assert.deepEqual(await Effect.runPromise(classifyAvailableTenants(records)), [
    { name: 'Alpha tenant', tenantId: 'tenant-2' },
    { name: 'Alpha tenant', tenantId: 'tenant-3' },
    { name: 'Zeta tenant', tenantId: 'tenant-1' },
  ]);
});

test('lists and resolves one active tenant binding', async () => {
  assert.deepEqual(await Effect.runPromise(classifyAvailableTenants([activeRecord])), [
    { name: 'Zeta tenant', tenantId: 'tenant-1' },
  ]);
  assert.deepEqual(await Effect.runPromise(classifyDefaultPrincipal([activeRecord])), {
    authBindingId: 'binding-1',
    displayName: 'Ada Lovelace',
    principalId: 'principal-1',
    principalKind: 'human',
    tenantId: 'tenant-1',
  });
  assert.deepEqual(await Effect.runPromise(classifySelectedPrincipal([activeRecord], 'tenant-1')), {
    authBindingId: 'binding-1',
    displayName: 'Ada Lovelace',
    principalId: 'principal-1',
    principalKind: 'human',
    tenantId: 'tenant-1',
  });
});

test('chooses the oldest eligible binding and breaks creation ties by tenant ID', async () => {
  const result = await Effect.runPromise(
    classifyDefaultPrincipal([
      activeRecord,
      {
        ...activeRecord,
        displayName: 'Tie winner',
        principalId: 'principal-0',
        tenantId: 'tenant-0',
      },
      {
        ...activeRecord,
        bindingCreatedAt: new Date('2026-02-01T00:00:00.000Z'),
        principalId: 'principal-2',
        tenantId: 'tenant-2',
      },
    ]),
  );

  assert.deepEqual(result, {
    authBindingId: 'binding-1',
    displayName: 'Tie winner',
    principalId: 'principal-0',
    principalKind: 'human',
    tenantId: 'tenant-0',
  });
});

test('resolves only the exact eligible selected tenant', async () => {
  const selected = {
    ...activeRecord,
    displayName: 'Grace Hopper',
    principalId: 'principal-2',
    tenantId: 'tenant-2',
  };
  assert.deepEqual(
    await Effect.runPromise(classifySelectedPrincipal([activeRecord, selected], 'tenant-2')),
    {
      authBindingId: 'binding-1',
      displayName: 'Grace Hopper',
      principalId: 'principal-2',
      principalKind: 'human',
      tenantId: 'tenant-2',
    },
  );
  assert.equal(
    await failureTag(classifySelectedPrincipal([activeRecord, selected], 'foreign-tenant')),
    'PrincipalBindingMissingError',
  );
});

test('rejects Better Auth user bindings to non-human principals', async () => {
  for (const principalKind of ['service', 'integration', 'agent', 'system'] as const) {
    const record = { ...activeRecord, principalKind };
    assert.equal(await failureTag(classifyDefaultPrincipal([record])), 'PrincipalInactiveError');
    assert.equal(
      await failureTag(classifySelectedPrincipal([record], record.tenantId)),
      'PrincipalInactiveError',
    );
    assert.equal(await failureTag(classifyAvailableTenants([record])), 'PrincipalInactiveError');
  }
});

test('resolves exactly one API-key subject for human, service, or integration principals', async () => {
  for (const principalKind of ['human', 'service', 'integration'] as const) {
    const resolved = await Effect.runPromise(
      classifyApiKeyPrincipal([{ ...activeRecord, principalKind }]),
    );
    assert.equal(resolved.principalKind, principalKind);
    assert.equal(resolved.authBindingId, activeRecord.authBindingId);
  }
  assert.equal(
    await failureTag(classifyApiKeyPrincipal([activeRecord, { ...activeRecord, tenantId: 't-2' }])),
    'PrincipalBindingAmbiguousError',
  );
});

test('fails closed for empty, inactive, and duplicate eligible resolver states', async () => {
  assert.equal(await failureTag(classifyAvailableTenants([])), 'PrincipalBindingMissingError');
  assert.equal(
    await failureTag(classifyAvailableTenants([{ ...activeRecord, bindingStatus: 'revoked' }])),
    'PrincipalBindingInactiveError',
  );
  assert.equal(
    await failureTag(
      classifyAvailableTenants([
        { ...activeRecord, bindingRevokedAt: new Date('2026-03-01T00:00:00.000Z') },
      ]),
    ),
    'PrincipalBindingInactiveError',
  );
  assert.equal(
    await failureTag(classifyAvailableTenants([{ ...activeRecord, principalStatus: 'disabled' }])),
    'PrincipalInactiveError',
  );
  assert.equal(
    await failureTag(classifyAvailableTenants([{ ...activeRecord, tenantStatus: 'suspended' }])),
    'TenantInactiveError',
  );
  assert.equal(
    await failureTag(
      classifyAvailableTenants([
        activeRecord,
        { ...activeRecord, principalId: 'duplicate-principal' },
      ]),
    ),
    'PrincipalBindingAmbiguousError',
  );
});

test('types database failures as resolver unavailability', async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      listAvailableTenantsFromRepository(
        {
          load: () => Promise.reject(new Error('secret database error')),
        },
        'subject',
      ),
    ),
  );
  assert.equal(error._tag, 'PrincipalResolverUnavailableError');
  assert.doesNotMatch(error.reason, /secret database error/u);
});
