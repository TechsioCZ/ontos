import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { changeTenantModuleStateAction } from '../../src/modules/actions/change-tenant-module-state.action.ts';
import type { InstalledModuleCatalog, OntosModuleDeploymentContract } from '../../src/index.ts';
import {
  TenantModuleStateConcurrentChangeError,
  TenantModuleStateDependencyInactiveError,
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
  dependencies: OntosModuleDeploymentContract['manifest']['dependencies']['modules'] = [],
): OntosModuleDeploymentContract => ({
  deployment: { appId: 'unit-module', buildMarker: 'unit-build' },
  manifest: {
    activation: {
      defaultState: 'inactive',
      preservesHistoryWhenInactive: true,
      scope: 'tenant',
      supportedStates,
    },
    dependencies: { core: [], externalSystems: [], modules: dependencies },
    module: {
      description: 'Unit module',
      displayName: 'Unit module',
      id: moduleId,
      implementedAs: 'ultramodern_microvertical',
      kind: 'business_module',
    },
    publicSurface: {
      actions: [],
      api: [],
      components: [],
      events: [],
      reports: [],
      resourceTypes: [],
      search: [],
    },
  },
  runtime: { outboxSubscriptions: [] },
  schemaVersion: '0',
});

const catalog = (
  ...contracts: readonly OntosModuleDeploymentContract[]
): InstalledModuleCatalog => {
  const byModule = new Map(contracts.map((item) => [item.manifest.module.id, item]));
  return Object.freeze({
    contracts: Object.freeze([...contracts]),
    deploymentAppIds: Object.freeze(contracts.map(({ deployment }) => deployment.appId)),
    getByDeploymentAppId: (appId: string) =>
      contracts.find(({ deployment }) => deployment.appId === appId),
    getByModuleId: (moduleId: string) => byModule.get(moduleId),
    moduleIds: Object.freeze(contracts.map(({ manifest }) => manifest.module.id)),
    outboxSubscriptions: Object.freeze([]),
  });
};

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
    new TenantModuleStateUnknownModuleError({
      code: 'tenant_module_state_module_unknown',
      reason: 'The requested OntOS module is not installed',
    }),
    new TenantModuleStateUnsupportedStateError({
      code: 'tenant_module_state_unsupported',
      reason: 'The requested state is not supported by the installed module',
    }),
    new TenantModuleStateDependencyInactiveError({
      code: 'tenant_module_state_dependency_inactive',
      reason: 'A mandatory OntOS module dependency must be active first',
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

test('validates installed membership, supported states, and active-first dependencies', async () => {
  const dependency = contract('documents.center', ['inactive', 'active']);
  const target = contract(
    'property.registry',
    ['inactive', 'active', 'read_only'],
    [
      {
        activation: 'must_be_active_first',
        id: 'documents.center',
        reason: 'Documents are required first',
        required: true,
      },
    ],
  );
  const installed = catalog(dependency, target);

  const unknown = await Effect.runPromise(
    Effect.flip(validateTenantModuleStateTransition(installed, [], 'unknown.module', 'active')),
  );
  assert.equal(unknown._tag, 'TenantModuleStateUnknownModuleError');
  const unsupported = await Effect.runPromise(
    Effect.flip(
      validateTenantModuleStateTransition(installed, [], 'property.registry', 'archived'),
    ),
  );
  assert.equal(unsupported._tag, 'TenantModuleStateUnsupportedStateError');
  const inactiveDependency = await Effect.runPromise(
    Effect.flip(validateTenantModuleStateTransition(installed, [], 'property.registry', 'active')),
  );
  assert.equal(inactiveDependency._tag, 'TenantModuleStateDependencyInactiveError');
  await Effect.runPromise(
    validateTenantModuleStateTransition(
      installed,
      [{ moduleKey: 'documents.center', state: 'active' }],
      'property.registry',
      'active',
    ),
  );
  await Effect.runPromise(
    validateTenantModuleStateTransition(installed, [], 'stale.module', 'inactive'),
  );
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
    Effect.runPromise(
      Schema.decodeUnknownEffect(descriptor.payloadSchema)({
        moduleKey: 'testing.module',
        newState: 'active',
        reason: 'x'.repeat(501),
      }),
    ),
  );
  await assert.rejects(
    Effect.runPromise(
      Schema.decodeUnknownEffect(descriptor.payloadSchema)({
        moduleKey: 'testing.module',
        newState: 'enabled',
        tenantId: 'browser-supplied',
      }),
    ),
  );
});
