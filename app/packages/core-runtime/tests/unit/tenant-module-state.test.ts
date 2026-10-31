import { Effect, Schema, Predicate } from 'effect';
// @effect-diagnostics preferSchemaOverJson:off -- Verifies native JSON serialization of errors and schema AST metadata; expires: 2026-12-31.
import { expect, it } from 'effect-rstest';

import type { OntosModuleDeploymentContract } from '../../src/index.ts';
import { changeTenantModuleStateAction } from '../../src/modules/actions/change-tenant-module-state.action.ts';
import {
  TenantModuleStateConcurrentChangeError,
  TenantModuleStatePersistenceUnavailableError,
  TenantModuleStateReadUnavailableError,
  TenantModuleStateTenantMissingError,
  TenantModuleStateUnchangedError,
  TenantModuleStateUnknownModuleError,
  TenantModuleStateUnsupportedChangeSourceError,
  TenantModuleStateUnsupportedStateError,
  TenantModuleStateUnsatisfiedDependencyError,
  TenantModuleStateValidationUnavailableError,
} from '../../src/modules/tenant-module-state-errors.ts';
import {
  TENANT_MODULE_STATES,
  TenantModuleStateSchema,
  rejectUnchangedTenantModuleState,
  resolveTenantModuleStateChangeSource,
  validateTenantModuleStateTransition,
  tenantModuleIntrinsicDependencyClosure,
  validateTenantModuleIntrinsicDependencyStates,
} from '../../src/modules/tenant-module-state-service.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';
import { makeInstalledCatalogFixture as catalog } from '../support/installed-catalog.ts';

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

it.effect('uses one canonical tenant module state schema', () =>
  Effect.gen(function* testScenario1() {
    const decodedStates = yield* Effect.forEach((state: (typeof TENANT_MODULE_STATES)[number]) =>
      Schema.decodeEffect(TenantModuleStateSchema)(state),
    )(TENANT_MODULE_STATES);
    expect(decodedStates).toEqual(TENANT_MODULE_STATES);

    const failure = yield* Effect.flip(Schema.decodeUnknownEffect(TenantModuleStateSchema)('enabled'));
    expect(Predicate.isTagged(failure, 'SchemaError')).toBe(true);
  }),
);

it.effect('maps only trusted supported authentication methods to history sources', () =>
  Effect.gen(function* testScenario2() {
    expect(yield* resolveTenantModuleStateChangeSource('session')).toBe('user');
    expect(yield* resolveTenantModuleStateChangeSource('support_impersonation')).toBe('support');
    expect(yield* resolveTenantModuleStateChangeSource('system')).toBe('system');

    const unsupported = yield* Effect.flip(resolveTenantModuleStateChangeSource('api_key'));
    expect(Predicate.isTagged(unsupported, 'TenantModuleStateUnsupportedChangeSourceError')).toBe(true);
    expect(unsupported.code).toBe('tenant_module_state_change_source_unsupported');
  }),
);

it.effect('rejects a no-op transition without changing first-state semantics', () =>
  Effect.gen(function* testScenario3() {
    yield* rejectUnchangedTenantModuleState(null, 'active');
    yield* rejectUnchangedTenantModuleState('inactive', 'active');

    const unchanged = yield* Effect.flip(rejectUnchangedTenantModuleState('active', 'active'));
    expect(Predicate.isTagged(unchanged, 'TenantModuleStateUnchangedError')).toBe(true);
    expect(unchanged.code).toBe('tenant_module_state_unchanged');
  }),
);

it('keeps Core module-state errors stable and sanitized', () => {
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
    new TenantModuleStateUnsatisfiedDependencyError({
      code: 'tenant_module_state_dependency_unsatisfied',
      reason: 'An intrinsic module dependency is absent, incompatible, or not active',
    }),
    new TenantModuleStateValidationUnavailableError({
      code: 'tenant_module_state_validation_unavailable',
      reason: 'Tenant module transition validation is temporarily unavailable',
    }),
  ];

  for (const error of errors) {
    const serialized = JSON.stringify(error);
    expect(serialized).not.toMatch(/postgres|select |insert |tenant-[0-9]|principal-[0-9]/iu);
  }
});

it.effect('validates only installed membership and the target module supported states', () =>
  Effect.gen(function* testScenario4() {
    const other = contract('documents.center', ['inactive', 'active']);
    const target = contract('property.registry', ['inactive', 'active', 'read_only']);
    const installed = catalog(other, target);

    const unknown = yield* Effect.flip(validateTenantModuleStateTransition(installed, 'unknown.module', 'active'));
    expect(Predicate.isTagged(unknown, 'TenantModuleStateUnknownModuleError')).toBe(true);
    const unsupported = yield* Effect.flip(
      validateTenantModuleStateTransition(installed, 'property.registry', 'archived'),
    );
    expect(Predicate.isTagged(unsupported, 'TenantModuleStateUnsupportedStateError')).toBe(true);
    yield* validateTenantModuleStateTransition(installed, 'property.registry', 'active');
    yield* validateTenantModuleStateTransition(installed, 'stale.module', 'inactive');
  }),
);

it.effect('declares the generated Core Action contract and bounded business payload', () =>
  Effect.gen(function* testScenario5() {
    const { descriptor } = changeTenantModuleStateAction;
    expect(descriptor.actionKey).toBe('core.modules.change-tenant-module-state');
    expect(descriptor.owningModuleKey).toBe('core.modules');
    expect(descriptor.auditProfile).toBe('sensitive');
    expect(descriptor.idempotency).toBe('required');
    expect(descriptor.policies).toEqual([]);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(JSON.stringify(descriptor.domainErrorSchema.ast)).toMatch(/tenant_module_state_dependency_unsatisfied/iu);

    expect(
      yield* Schema.decodeEffect(descriptor.payloadSchema)({
        expectedState: 'inactive',
        moduleKey: 'testing.module',
        newState: 'active',
        reason: 'Tenant administrator enabled the module',
      }),
    ).toEqual({
      expectedState: 'inactive',
      moduleKey: 'testing.module',
      newState: 'active',
      reason: 'Tenant administrator enabled the module',
    });
    expect(
      yield* Effect.flip(
        Schema.decodeEffect(descriptor.payloadSchema)({
          moduleKey: 'testing.module',
          newState: 'active',
          reason: 'x'.repeat(501),
        }),
      ),
    ).toBeDefined();
    expect(
      yield* Effect.flip(
        Schema.decodeUnknownEffect(descriptor.payloadSchema)({
          moduleKey: 'testing.module',
          newState: 'enabled',
          tenantId: 'browser-supplied',
        }),
      ),
    ).toBeDefined();
  }),
);

it.effect('resolves the complete intrinsic activation closure and rejects missing providers or cycles', () =>
  Effect.gen(function* intrinsicActivationClosure() {
    const intrinsic = (moduleId: string, dependencies: readonly string[]): OntosModuleDeploymentContract => {
      const base = contract(moduleId, ['inactive', 'active']);
      return {
        ...base,
        manifest: {
          ...base.manifest,
          requirements: {
            coreCapabilities: [],
            intrinsic: dependencies.map((dependency) => ({ moduleId: dependency, requiredOperations: [] })),
            operations: [],
            schemaVersion: '1',
          },
        },
      };
    };
    const a = intrinsic('consumer.alpha', ['provider.beta']);
    const b = intrinsic('provider.beta', ['provider.gamma']);
    const c = intrinsic('provider.gamma', []);
    expect(yield* tenantModuleIntrinsicDependencyClosure(catalog(a, b, c), 'consumer.alpha')).toEqual([
      'provider.beta',
      'provider.gamma',
    ]);
    expect(
      Schema.is(TenantModuleStateUnsatisfiedDependencyError)(
        yield* Effect.flip(tenantModuleIntrinsicDependencyClosure(catalog(a, b), 'consumer.alpha')),
      ),
    ).toBe(true);
    const cyclic = intrinsic('provider.beta', ['consumer.alpha']);
    expect(
      Schema.is(TenantModuleStateUnsatisfiedDependencyError)(
        yield* Effect.flip(tenantModuleIntrinsicDependencyClosure(catalog(a, cyclic), 'consumer.alpha')),
      ),
    ).toBe(true);
    expect(yield* tenantModuleIntrinsicDependencyClosure(catalog(c), 'provider.gamma')).toEqual([]);
  }),
);

it.effect('distinguishes malformed dependency state from definite inactive or missing state', () =>
  Effect.gen(function* intrinsicStateEvidence() {
    const dependency = 'provider.required';
    yield* validateTenantModuleIntrinsicDependencyStates([dependency], [{ moduleKey: dependency, state: 'active' }]);
    yield* Effect.forEach(
      [[], [{ moduleKey: dependency, state: 'suspended' }]],
      Effect.fnUntraced(function* definiteDependencyState(rows) {
        const rejected = yield* Effect.flip(validateTenantModuleIntrinsicDependencyStates([dependency], rows));
        expect(Schema.is(TenantModuleStateUnsatisfiedDependencyError)(rejected)).toBe(true);
      }),
      { concurrency: 1, discard: true },
    );
    yield* Effect.forEach(
      [
        [{ moduleKey: dependency, state: 'invalid-storage-value' }],
        [
          { moduleKey: dependency, state: 'active' },
          { moduleKey: dependency, state: 'suspended' },
        ],
        [{ moduleKey: 'unexpected.provider', state: 'active' }],
      ],
      Effect.fnUntraced(function* indeterminateDependencyEvidence(rows) {
        const failure = yield* Effect.flip(validateTenantModuleIntrinsicDependencyStates([dependency], rows));
        expect(Schema.is(TenantModuleStateValidationUnavailableError)(failure)).toBe(true);
      }),
      { concurrency: 1, discard: true },
    );
  }),
);
