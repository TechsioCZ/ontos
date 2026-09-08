import { makeInstalledCatalogFixture as catalog } from '../support/installed-catalog.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';
import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off -- Existing compatibility boundary; expires: 2026-12-31.
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { changeTenantModuleStateAction } from '../../src/modules/actions/change-tenant-module-state.action.ts';
import type { OntosModuleDeploymentContract } from '../../src/index.ts';
import {
  TenantModuleStateConcurrentChangeError,
  TenantModuleStatePersistenceUnavailableError,
  TenantModuleStateReadUnavailableError,
  TenantModuleStateTenantMissingError,
  TenantModuleStateUnchangedError,
  TenantModuleStateUnknownModuleError,
  TenantModuleStateUnsupportedChangeSourceError,
  TenantModuleStateUnsupportedStateError,
  TenantModuleStateValidationUnavailableError,
} from '../../src/modules/tenant-module-state-errors.ts';
import {
  TENANT_MODULE_STATES,
  TenantModuleStateSchema,
  rejectUnchangedTenantModuleState,
  resolveTenantModuleStateChangeSource,
  validateTenantModuleStateTransition,
} from '../../src/modules/tenant-module-state-service.ts';

const contract = (
  moduleId: string,
  supportedStates: OntosModuleDeploymentContract['manifest']['activation']['supportedStates'],
): OntosModuleDeploymentContract =>
  makeModuleContractFixture({
    appId: 'unit-module',
    buildMarker: 'unit-build',
    description: 'Unit module',
    displayName: 'Unit module',
    moduleId,
    supportedStates,
  });

void test('uses one canonical tenant module state schema', async () => {
  const decodedStates = await Promise.all(
    TENANT_MODULE_STATES.map(
      async (state) =>
        await runEffectTestPromise(Schema.decodeUnknownEffect(TenantModuleStateSchema)(state)),
    ),
  );
  assert.deepEqual(decodedStates, TENANT_MODULE_STATES);

  const failure = await runEffectTestPromise(
    Effect.flip(Schema.decodeUnknownEffect(TenantModuleStateSchema)('enabled')),
  );
  assert.equal(failure._tag, 'SchemaError');
});

void test('maps only trusted supported authentication methods to history sources', async () => {
  assert.equal(await runEffectTestPromise(resolveTenantModuleStateChangeSource('session')), 'user');
  assert.equal(
    await runEffectTestPromise(resolveTenantModuleStateChangeSource('support_impersonation')),
    'support',
  );
  assert.equal(
    await runEffectTestPromise(resolveTenantModuleStateChangeSource('system')),
    'system',
  );

  const unsupported = await runEffectTestPromise(
    Effect.flip(resolveTenantModuleStateChangeSource('api_key')),
  );
  assert.equal(unsupported._tag, 'TenantModuleStateUnsupportedChangeSourceError');
  assert.equal(unsupported.code, 'tenant_module_state_change_source_unsupported');
});

void test('rejects a no-op transition without changing first-state semantics', async () => {
  await runEffectTestPromise(rejectUnchangedTenantModuleState(null, 'active'));
  await runEffectTestPromise(rejectUnchangedTenantModuleState('inactive', 'active'));

  const unchanged = await runEffectTestPromise(
    Effect.flip(rejectUnchangedTenantModuleState('active', 'active')),
  );
  assert.equal(unchanged._tag, 'TenantModuleStateUnchangedError');
  assert.equal(unchanged.code, 'tenant_module_state_unchanged');
});

void test('keeps Core module-state errors stable and sanitized', () => {
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
    new TenantModuleStateUnknownModuleError({
      code: 'tenant_module_state_module_unknown',
      reason: 'The requested OntOS module is not installed',
    }),
    new TenantModuleStateUnsupportedStateError({
      code: 'tenant_module_state_unsupported',
      reason: 'The requested state is not supported by the installed module',
    }),
    new TenantModuleStateValidationUnavailableError({
      code: 'tenant_module_state_validation_unavailable',
      reason: 'Tenant module transition validation is temporarily unavailable',
    }),
  ];

  for (const error of errors) {
    const serialized = JSON.stringify(error);
    assert.doesNotMatch(serialized, /postgres|select |insert |tenant-[0-9]|principal-[0-9]/iu);
  }
});

void test('validates only installed membership and the target module supported states', async () => {
  const other = contract('documents.center', ['inactive', 'active']);
  const target = contract('property.registry', ['inactive', 'active', 'read_only']);
  const installed = catalog(other, target);

  const unknown = await runEffectTestPromise(
    Effect.flip(validateTenantModuleStateTransition(installed, 'unknown.module', 'active')),
  );
  assert.equal(unknown._tag, 'TenantModuleStateUnknownModuleError');
  const unsupported = await runEffectTestPromise(
    Effect.flip(validateTenantModuleStateTransition(installed, 'property.registry', 'archived')),
  );
  assert.equal(unsupported._tag, 'TenantModuleStateUnsupportedStateError');
  await runEffectTestPromise(
    validateTenantModuleStateTransition(installed, 'property.registry', 'active'),
  );
  await runEffectTestPromise(
    validateTenantModuleStateTransition(installed, 'stale.module', 'inactive'),
  );
});

void test('declares the generated Core Action contract and bounded business payload', async () => {
  const { descriptor } = changeTenantModuleStateAction;
  assert.equal(descriptor.actionKey, 'core.modules.change-tenant-module-state');
  assert.equal(descriptor.owningModuleKey, 'core.modules');
  assert.equal(descriptor.auditProfile, 'sensitive');
  assert.equal(descriptor.idempotency, 'required');
  assert.deepEqual(descriptor.policies, []);
  assert.equal(Object.isFrozen(descriptor), true);
  assert.doesNotMatch(JSON.stringify(descriptor.domainErrorSchema.ast), /dependency/iu);

  assert.deepEqual(
    await runEffectTestPromise(
      Schema.decodeUnknownEffect(descriptor.payloadSchema)({
        expectedState: 'inactive',
        moduleKey: 'testing.module',
        newState: 'active',
        reason: 'Tenant administrator enabled the module',
      }),
    ),
    {
      expectedState: 'inactive',
      moduleKey: 'testing.module',
      newState: 'active',
      reason: 'Tenant administrator enabled the module',
    },
  );
  await assert.rejects(
    runEffectTestPromise(
      Schema.decodeUnknownEffect(descriptor.payloadSchema)({
        moduleKey: 'testing.module',
        newState: 'active',
        reason: 'x'.repeat(501),
      }),
    ),
  );
  await assert.rejects(
    runEffectTestPromise(
      Schema.decodeUnknownEffect(descriptor.payloadSchema)({
        moduleKey: 'testing.module',
        newState: 'enabled',
        tenantId: 'browser-supplied',
      }),
    ),
  );
});
