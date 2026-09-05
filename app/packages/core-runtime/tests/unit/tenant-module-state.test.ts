import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off
import test from 'node:test';
import { Effect, Schema } from 'effect';
import type { ScopedTransactionExecutor } from '../../src/db/scoped-transaction.ts';
import type { CoreDatabaseExecutor } from '../../src/db/types.ts';
import { changeTenantModuleStateAction } from '../../src/modules/actions/change-tenant-module-state.action.ts';
import type { InstalledModuleCatalog, OntosModuleDeploymentContract } from '../../src/index.ts';
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
  makeTenantModuleStateService,
  persistTenantModuleStateChange,
  rejectUnchangedTenantModuleState,
  resolveTenantModuleStateChangeSource,
  validateTenantModuleStateTransition,
} from '../../src/modules/tenant-module-state-service.ts';

const contract = (
  moduleId: string,
  supportedStates: OntosModuleDeploymentContract['manifest']['activation']['supportedStates'],
): OntosModuleDeploymentContract => ({
  deployment: { appId: 'unit-module', buildMarker: 'unit-build' },
  manifest: {
    activation: {
      defaultState: 'inactive',
      preservesHistoryWhenInactive: true,
      scope: 'tenant',
      supportedStates,
    },
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
      shellContributions: {
        mediaAttachments: [],
        navigation: [],
        pages: [],
        publicComponents: [],
        reports: [],
        resourceDetails: [],
        search: [],
        timelines: [],
      },
    },
  },
  runtime: { outboxSubscriptions: [] },
  schemaVersion: '2',
});

const catalog = (
  ...contracts: readonly OntosModuleDeploymentContract[]
): InstalledModuleCatalog => {
  const byModule = new Map(contracts.map((item) => [item.manifest.module.id, item]));
  return Object.freeze({
    contracts: Object.freeze([...contracts]),
    deploymentAppIds: Object.freeze(contracts.map(({ deployment }) => deployment.appId)),
    deploymentStatuses: Object.freeze(
      contracts.map((moduleContract) => ({
        appId: moduleContract.deployment.appId,
        moduleId: moduleContract.manifest.module.id,
        status: 'available' as const,
      })),
    ),
    getByDeploymentAppId: (appId: string) =>
      contracts.find(({ deployment }) => deployment.appId === appId),
    getByModuleId: (moduleId: string) => byModule.get(moduleId),
    moduleIds: Object.freeze(contracts.map(({ manifest }) => manifest.module.id)),
    outboxSubscriptions: Object.freeze([]),
  });
};

const persistenceInput = {
  actionInvocationId: 'invocation-unit',
  authMethod: 'session' as const,
  moduleKey: 'testing.module',
  newState: 'active' as const,
  principalId: 'principal-unit',
  tenantId: 'tenant-unit',
};

// Only the query endpoints exercised by these unit tests; no database connection.
const persistenceTransaction = (
  failAt: string | undefined,
  originalFailure: unknown,
  currentRows: readonly object[] = [],
  historyRows: readonly object[] = [{ moduleStateChangeId: 'change-unit' }],
): ScopedTransactionExecutor => {
  let selects = 0;
  let inserts = 0;
  const result = (stage: string, rows: readonly object[]) =>
    stage === failAt ? Promise.reject(originalFailure) : Promise.resolve(rows);
  return {
    select: () => {
      selects += 1;
      return {
        from: () => ({
          where: () =>
            selects === 1
              ? { for: () => result('tenant', [{ tenantId: 'tenant-unit' }]) }
              : result('current', currentRows),
        }),
      };
    },
    insert: () => {
      inserts += 1;
      return {
        values: () => ({
          returning: () =>
            inserts === 1
              ? result('history', historyRows)
              : result('insert', [{ tenantModuleStateId: 'state-unit' }]),
        }),
      };
    },
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => result('update', [{ tenantModuleStateId: 'state-unit' }]),
        }),
      }),
    }),
  } as unknown as ScopedTransactionExecutor;
};

void test('retains diagnostics privately without changing JSON or Schema encoding', async () => {
  const original = new Error('postgres select tenant-123 private diagnostics');
  const read = TenantModuleStateReadUnavailableError.withOriginalFailure(original);
  const persistence = TenantModuleStatePersistenceUnavailableError.withOriginalFailure(original);
  const readWire = {
    _tag: 'TenantModuleStateReadUnavailableError',
    code: 'tenant_module_state_read_unavailable',
    reason: 'Tenant module state is temporarily unavailable',
  };
  const persistenceWire = {
    _tag: 'TenantModuleStatePersistenceUnavailableError',
    code: 'tenant_module_state_persistence_unavailable',
    reason: 'Tenant module state could not be persisted',
  };
  assert.equal(read.getOriginalFailure(), original);
  assert.equal(persistence.getOriginalFailure(), original);
  assert.deepEqual(JSON.parse(JSON.stringify(read)), readWire);
  assert.deepEqual(JSON.parse(JSON.stringify(persistence)), persistenceWire);
  assert.deepEqual(
    await Effect.runPromise(Schema.encodeEffect(TenantModuleStateReadUnavailableError)(read)),
    readWire,
  );
  assert.deepEqual(
    await Effect.runPromise(
      Schema.encodeEffect(TenantModuleStatePersistenceUnavailableError)(persistence),
    ),
    persistenceWire,
  );
  assert.equal(
    TenantModuleStateReadUnavailableError.withOriginalFailure().getOriginalFailure(),
    undefined,
  );
  assert.equal(
    TenantModuleStatePersistenceUnavailableError.withOriginalFailure().getOriginalFailure(),
    undefined,
  );
});

void test('preserves caught read SQL and schema failures across all read methods', async (context) => {
  const factory = context.mock.method(TenantModuleStateReadUnavailableError, 'withOriginalFailure');
  const sqlFailure = new Error('postgres select private diagnostics');
  for (const invalidState of [false, true]) {
    const executor = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () =>
              invalidState
                ? Promise.resolve([{ moduleKey: 'testing.module', state: 'enabled' }])
                : Promise.reject(sqlFailure),
          }),
        }),
      }),
    } as unknown as Pick<CoreDatabaseExecutor, 'select'>;
    const service = makeTenantModuleStateService({ executor });
    for (const read of [
      service.getTenantModuleStates('tenant-unit', ['testing.module']),
      service.listTenantModuleStates('tenant-unit'),
      service.listActiveTenantModules('tenant-unit'),
    ]) {
      const failure = await Effect.runPromise(Effect.flip(read));
      assert.equal(failure._tag, 'TenantModuleStateReadUnavailableError');
      const caught = factory.mock.calls.at(-1)?.arguments[0];
      assert.equal(failure.getOriginalFailure(), caught);
      if (invalidState) {
        assert.ok(caught instanceof Schema.SchemaError);
      } else {
        assert.equal(caught, sqlFailure);
      }
    }
  }
});

void test('preserves caught SQL failures at every persistence boundary', async () => {
  for (const stage of ['tenant', 'current', 'history', 'insert', 'update']) {
    const original = new Error(`postgres ${stage} private diagnostics`);
    const transaction = persistenceTransaction(
      stage,
      original,
      stage === 'update' ? [{ state: 'inactive', tenantModuleStateId: 'state-unit' }] : [],
    );
    const failure = await Effect.runPromise(
      Effect.flip(persistTenantModuleStateChange(transaction, persistenceInput)),
    );
    assert.ok(Schema.is(TenantModuleStatePersistenceUnavailableError)(failure));
    assert.equal(failure.getOriginalFailure(), original);
  }
});

void test('preserves caught persistence schema failure and cause-free missing history', async (context) => {
  const factory = context.mock.method(
    TenantModuleStatePersistenceUnavailableError,
    'withOriginalFailure',
  );
  const failure = await Effect.runPromise(
    Effect.flip(
      persistTenantModuleStateChange(
        persistenceTransaction(undefined, undefined, [{ state: 'enabled' }]),
        persistenceInput,
      ),
    ),
  );
  assert.ok(Schema.is(TenantModuleStatePersistenceUnavailableError)(failure));
  const caught = factory.mock.calls.at(-1)?.arguments[0];
  assert.ok(caught instanceof Schema.SchemaError);
  assert.equal(failure.getOriginalFailure(), caught);
  const missingHistory = await Effect.runPromise(
    Effect.flip(
      persistTenantModuleStateChange(
        persistenceTransaction(undefined, undefined, [], []),
        persistenceInput,
      ),
    ),
  );
  assert.ok(Schema.is(TenantModuleStatePersistenceUnavailableError)(missingHistory));
  assert.equal(missingHistory.getOriginalFailure(), undefined);
});

void test('uses one canonical tenant module state schema', async () => {
  const decodedStates = await Promise.all(
    TENANT_MODULE_STATES.map(
      async (state) =>
        await Effect.runPromise(Schema.decodeUnknownEffect(TenantModuleStateSchema)(state)),
    ),
  );
  assert.deepEqual(decodedStates, TENANT_MODULE_STATES);

  const failure = await Effect.runPromise(
    Effect.flip(Schema.decodeUnknownEffect(TenantModuleStateSchema)('enabled')),
  );
  assert.equal(failure._tag, 'SchemaError');
});

void test('maps only trusted supported authentication methods to history sources', async () => {
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

void test('rejects a no-op transition without changing first-state semantics', async () => {
  await Effect.runPromise(rejectUnchangedTenantModuleState(null, 'active'));
  await Effect.runPromise(rejectUnchangedTenantModuleState('inactive', 'active'));

  const unchanged = await Effect.runPromise(
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

  const unknown = await Effect.runPromise(
    Effect.flip(validateTenantModuleStateTransition(installed, 'unknown.module', 'active')),
  );
  assert.equal(unknown._tag, 'TenantModuleStateUnknownModuleError');
  const unsupported = await Effect.runPromise(
    Effect.flip(validateTenantModuleStateTransition(installed, 'property.registry', 'archived')),
  );
  assert.equal(unsupported._tag, 'TenantModuleStateUnsupportedStateError');
  await Effect.runPromise(
    validateTenantModuleStateTransition(installed, 'property.registry', 'active'),
  );
  await Effect.runPromise(
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
