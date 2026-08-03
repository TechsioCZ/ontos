import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { changeTenantModuleStateAction } from '../../src/modules/actions/change-tenant-module-state.action.ts';
import {
  TenantModuleStateConcurrentChangeError,
  TenantModuleStatePersistenceUnavailableError,
  TenantModuleStateReadUnavailableError,
  TenantModuleStateTenantMissingError,
  TenantModuleStateUnchangedError,
  TenantModuleStateUnsupportedChangeSourceError,
} from '../../src/modules/tenant-module-state-errors.ts';
import {
  TENANT_MODULE_STATES,
  TenantModuleStateSchema,
  rejectUnchangedTenantModuleState,
  resolveTenantModuleStateChangeSource,
} from '../../src/modules/tenant-module-state-service.ts';

test('uses one canonical tenant module state schema', async () => {
  const decodedStates = await Promise.all(
    TENANT_MODULE_STATES.map((state) =>
      Effect.runPromise(Schema.decodeUnknownEffect(TenantModuleStateSchema)(state)),
    ),
  );
  assert.deepEqual(decodedStates, TENANT_MODULE_STATES);

  const failure = await Effect.runPromise(
    Effect.flip(Schema.decodeUnknownEffect(TenantModuleStateSchema)('enabled')),
  );
  assert.equal(failure._tag, 'SchemaError');
});

test('maps only trusted supported authentication methods to history sources', async () => {
  assert.equal(await Effect.runPromise(resolveTenantModuleStateChangeSource('session')), 'user');
  assert.equal(
    await Effect.runPromise(resolveTenantModuleStateChangeSource('support_impersonation')),
    'support',
  );
  assert.equal(await Effect.runPromise(resolveTenantModuleStateChangeSource('system')), 'system');

  const unsupported = await Effect.runPromise(
    Effect.flip(resolveTenantModuleStateChangeSource('api_key')),
  );
  assert.equal(unsupported._tag, 'TenantModuleStateUnsupportedChangeSourceError');
  assert.equal(unsupported.code, 'tenant_module_state_change_source_unsupported');
});

test('rejects a no-op transition without changing first-state semantics', async () => {
  await Effect.runPromise(rejectUnchangedTenantModuleState(null, 'active'));
  await Effect.runPromise(rejectUnchangedTenantModuleState('inactive', 'active'));

  const unchanged = await Effect.runPromise(
    Effect.flip(rejectUnchangedTenantModuleState('active', 'active')),
  );
  assert.equal(unchanged._tag, 'TenantModuleStateUnchangedError');
  assert.equal(unchanged.code, 'tenant_module_state_unchanged');
});

test('keeps Core module-state errors stable and sanitized', () => {
  const errors = [
    new TenantModuleStateConcurrentChangeError({
      code: 'tenant_module_state_changed_concurrently',
      reason: 'The tenant module state changed after it was read',
    }),
    new TenantModuleStateReadUnavailableError({
      code: 'tenant_module_state_read_unavailable',
      reason: 'Tenant module state is temporarily unavailable',
    }),
    new TenantModuleStatePersistenceUnavailableError({
      code: 'tenant_module_state_persistence_unavailable',
      reason: 'Tenant module state could not be persisted',
    }),
    new TenantModuleStateTenantMissingError({
      code: 'tenant_module_state_tenant_missing',
      reason: 'The tenant required for this state change does not exist',
    }),
    new TenantModuleStateUnchangedError({
      code: 'tenant_module_state_unchanged',
      reason: 'The tenant module already has the requested state',
    }),
    new TenantModuleStateUnsupportedChangeSourceError({
      code: 'tenant_module_state_change_source_unsupported',
      reason: 'This authentication method cannot change tenant module state',
    }),
  ];

  for (const error of errors) {
    const serialized = JSON.stringify(error);
    assert.doesNotMatch(serialized, /postgres|select |insert |tenant-[0-9]|principal-[0-9]/iu);
  }
});

test('declares the generated Core Action contract and bounded business payload', async () => {
  const { descriptor } = changeTenantModuleStateAction;
  assert.equal(descriptor.actionKey, 'core.modules.change-tenant-module-state');
  assert.equal(descriptor.owningModuleKey, 'core.modules');
  assert.equal(descriptor.auditProfile, 'sensitive');
  assert.equal(descriptor.idempotency, 'required');
  assert.deepEqual(descriptor.policies, []);
  assert.equal(Object.isFrozen(descriptor), true);

  assert.deepEqual(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(descriptor.payloadSchema)({
        expectedState: 'inactive',
        moduleKey: 'testing1',
        newState: 'active',
        reason: 'Tenant administrator enabled the module',
      }),
    ),
    {
      expectedState: 'inactive',
      moduleKey: 'testing1',
      newState: 'active',
      reason: 'Tenant administrator enabled the module',
    },
  );
  await assert.rejects(
    Effect.runPromise(
      Schema.decodeUnknownEffect(descriptor.payloadSchema)({
        moduleKey: 'testing1',
        newState: 'active',
        reason: 'x'.repeat(501),
      }),
    ),
  );
  await assert.rejects(
    Effect.runPromise(
      Schema.decodeUnknownEffect(descriptor.payloadSchema)({
        moduleKey: 'testing1',
        newState: 'enabled',
        tenantId: 'browser-supplied',
      }),
    ),
  );
});
