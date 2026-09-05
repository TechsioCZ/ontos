// @effect-diagnostics asyncFunction:off globalDate:off globalDateInEffect:off missingEffectError:off unsafeEffectTypeAssertion:off
/* eslint-disable max-classes-per-file, no-await-in-loop, no-throw-literal -- Test-local typed errors, sequential lifecycle assertions, and the controlled Drizzle transaction fake are deliberate. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect, Schema, Predicate } from 'effect';
import { Pool } from 'pg';
import { CoreDatabase } from '../../src/db/client.ts';
import type {
  ActionInvocationRecord,
  ActionRepositoryService,
  FinalizeActionPolicyDenialInput,
  FlushActionSuccessInput,
  RejectPermissionDeniedInput,
} from '../../src/actions/repository.ts';
import { ACTION_RUNTIME_STAGES, makeActionRuntime } from '../../src/actions/runtime.ts';
import type { ActionRuntimeStage } from '../../src/actions/runtime.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import { defineAction, getActionHandler } from '../../src/actions/definition.ts';
import {
  ActionInvocationPersistenceError,
  ActionPermissionCheckError,
  ActionTransactionError,
} from '../../src/actions/errors.ts';
import {
  ModuleStateCheckUnavailableError,
  ModuleStateDeniedError,
} from '../../src/modules/module-state-gate-errors.ts';
import type { TenantModuleState } from '../../src/modules/tenant-module-state-service.ts';
import {
  defineGlobalPolicy,
  defineMicroverticalPolicy,
  denyPolicy,
} from '../../src/actions/policy.ts';
import type {
  ActionPermissionDecision,
  CheckActionPermissionInput,
} from '../../src/permissions/service.ts';
import {
  defineSystemModuleEntrypoint,
  defineTenantModuleEntrypoint,
} from '../../src/modules/module-entrypoint.ts';
import type { ModuleEntrypointDescriptor } from '../../src/modules/module-entrypoint.ts';
import { makeModuleEntrypointGateway } from '../../src/modules/module-entrypoint-gateway.ts';
import {
  checkModuleEntrypoint,
  makeModuleStateSnapshot,
} from '../../src/modules/module-state-gate.ts';
import { supportRecoveryPrincipalContextResolverFromRepository } from '../../src/auth/support-recovery-principal-context.ts';
import { coreRelations } from '../../src/db/schema.ts';
import { recordSupportImpersonationAction } from '../../src/modules/actions/record-support-impersonation.action.ts';

const principal = {
  authBindingId: '00000000-0000-4000-8000-000000000004',
  authContextRef: 'better-auth-session:test-session',
  authMethod: 'session',
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
} as const;

const transport = (idempotencyKey = 'intent-1') => ({
  correlationId: `correlation-${idempotencyKey}`,
  idempotencyKey,
  targetModuleKey: 'core.shell',
  targetResourceId: 'primary',
  targetResourceType: 'counter',
});

const QueryConfigSchema = Schema.Struct({ text: Schema.String });

interface HarnessOptions {
  readonly commitFailureCode?: string;
  readonly createRecord?: ActionInvocationRecord;
  readonly lockedModuleState?: 'active' | 'denied' | 'unavailable';
  readonly moduleState?: TenantModuleState | 'missing' | 'unavailable';
  readonly permissionDecision?: ActionPermissionDecision;
  readonly permissionFailure?: boolean;
  readonly policyFinalizationFailure?: boolean;
  readonly rejectionFailure?: boolean;
  readonly resolutionUnavailable?: boolean;
  readonly tenantPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
  readonly transactionMode?: 'commit-definite' | 'definite-failure' | 'normal' | 'uncertain';
}

const makeHarness = (options: HarnessOptions = {}) => {
  const finalized: FinalizeActionPolicyDenialInput[] = [];
  const flushed: FlushActionSuccessInput[] = [];
  const permissionChecks: CheckActionPermissionInput[] = [];
  const rejections: RejectPermissionDeniedInput[] = [];
  const stages: ActionRuntimeStage[] = [];
  let createCount = 0;
  let lockCount = 0;
  let permissionCheckCount = 0;
  let moduleStateReadCount = 0;
  let moduleStateRecheckCount = 0;
  let handlerResolutionCount = 0;
  let rejectionCount = 0;
  let transitionCount = 0;
  let transactionCount = 0;
  const invocation =
    options.createRecord ??
    ({
      actionInvocationId: 'invocation-1',
      completedAt: null,
      requestHash: '',
      status: 'received',
    } satisfies ActionInvocationRecord);
  let currentInvocation = invocation;
  let preparedHash = '';

  const repository: ActionRepositoryService = {
    createOrResolveInvocation: (_executor, input) => {
      createCount += 1;
      preparedHash = input.requestHash;
      return Effect.succeed({
        ...currentInvocation,
        requestHash: currentInvocation.requestHash || input.requestHash,
      });
    },
    finalizePolicyDenial: (_executor, input) => {
      if (options.policyFinalizationFailure === true) {
        return Effect.fail(
          new ActionInvocationPersistenceError({
            code: 'action_invocation_persistence_failed',
            reason: 'test rejection persistence failed',
          }),
        );
      }
      finalized.push(input);
      currentInvocation = {
        ...currentInvocation,
        completedAt: new Date(),
        status: 'rejected',
      };
      return Effect.void;
    },
    flushSuccess: (_transaction, input) => {
      flushed.push(input);
      return Effect.void;
    },
    lockInvocation: () => {
      lockCount += 1;
      return Effect.succeed({
        ...currentInvocation,
        requestHash: currentInvocation.requestHash || preparedHash,
      });
    },
    rejectPermissionDenied: (_executor, input) => {
      rejectionCount += 1;
      rejections.push(input);
      if (options.rejectionFailure === true) {
        return Effect.fail(
          new ActionTransactionError({
            code: 'action_transaction_failed',
            reason: 'test denial evidence transaction failed',
          }),
        );
      }
      currentInvocation = {
        ...currentInvocation,
        completedAt: new Date(),
        status: 'rejected',
      };
      return Effect.void;
    },
    resolveInvocation: () =>
      options.resolutionUnavailable === true
        ? Effect.fail(
            new ActionInvocationPersistenceError({
              code: 'action_invocation_persistence_failed',
              reason: 'test database unavailable',
            }),
          )
        : Effect.succeed(currentInvocation),
    transitionInvocationToRunning: () => {
      transitionCount += 1;
      if (
        (currentInvocation.status === 'received' || currentInvocation.status === 'running') &&
        currentInvocation.completedAt === null
      ) {
        currentInvocation = { ...currentInvocation, status: 'running' };
      }
      return Effect.succeed({
        ...currentInvocation,
        requestHash: currentInvocation.requestHash || preparedHash,
      });
    },
  };

  let installedTenantId: string = principal.tenantId;
  let installedLegalEntityId: string = principal.legalEntityId;
  const query = async <Query, Values>(queryInput: Query, values?: Values) =>
    await Promise.resolve().then(() => {
      const { text } = Schema.decodeUnknownSync(QueryConfigSchema)(queryInput);
      if (text.includes('set_config') && Array.isArray(values)) {
        const [tenantId, legalEntityId] = values;
        if (Predicate.isString(tenantId) && Predicate.isString(legalEntityId)) {
          installedTenantId = tenantId;
          installedLegalEntityId = legalEntityId;
        }
      }
      if (text === 'begin') {
        transactionCount += 1;
        if (options.transactionMode === 'definite-failure') {
          throw new Error('transaction unavailable');
        }
      }
      if (text === 'commit') {
        if (options.transactionMode === 'uncertain') {
          throw { commitIndeterminate: true };
        }
        if (options.commitFailureCode !== undefined) {
          throw Object.assign(new Error('commit acknowledgement failed'), {
            code: options.commitFailureCode,
          });
        }
        if (options.transactionMode === 'commit-definite') {
          throw Object.assign(new Error('serialization failure'), { code: '40001' });
        }
      }
      if (text.includes('current_setting')) {
        return {
          rows: [
            {
              legal_entity_id: installedLegalEntityId,
              tenant_id: installedTenantId,
            },
          ],
        };
      }
      if (text.startsWith('select')) {
        return { rows: [{ authBindingId: principal.authBindingId }] };
      }
      return { rows: [] };
    });
  const pool = new Pool();
  Object.defineProperty(pool, 'connect', {
    value: async () => ({ query, release: () => {} }),
  });
  Object.defineProperty(pool, 'query', { value: query });
  const database = {
    executor: drizzle({ client: pool, relations: coreRelations }),
  };

  const permission = {
    checkActionPermission: (input: CheckActionPermissionInput) => {
      permissionCheckCount += 1;
      permissionChecks.push(input);
      return options.permissionFailure === true
        ? Effect.fail(
            new ActionPermissionCheckError({
              code: 'action_permission_check_failed',
              reason: 'test authorization service unavailable',
            }),
          )
        : Effect.succeed(options.permissionDecision ?? 'allowed');
    },
  };

  const moduleStateGate = {
    check: checkModuleEntrypoint,
    prepareSnapshot: (tenantId: string, entrypoints: readonly ModuleEntrypointDescriptor[]) => {
      const moduleKeys = entrypoints
        .filter((entrypoint) => entrypoint.scope === 'tenant')
        .map((entrypoint) => entrypoint.moduleKey);
      if (moduleKeys.length > 0) {
        moduleStateReadCount += 1;
      }
      if (options.moduleState === 'unavailable') {
        return Effect.fail(
          new ModuleStateCheckUnavailableError({
            code: 'module_state_check_unavailable',
            reason: 'controlled unavailable state read',
          }),
        );
      }
      const availableState: TenantModuleState =
        options.moduleState === undefined || options.moduleState === 'missing'
          ? 'active'
          : options.moduleState;
      return Effect.succeed(
        makeModuleStateSnapshot(
          tenantId,
          entrypoints,
          options.moduleState === 'missing'
            ? []
            : moduleKeys.map((moduleKey) => ({
                moduleKey,
                state: availableState,
              })),
        ),
      );
    },
    recheckWrite: () => {
      moduleStateRecheckCount += 1;
      if (options.lockedModuleState === 'denied') {
        return Effect.fail(
          new ModuleStateDeniedError({
            code: 'module_state_denied',
            reason: 'controlled locked denial',
          }),
        );
      }
      if (options.lockedModuleState === 'unavailable') {
        return Effect.fail(
          new ModuleStateCheckUnavailableError({
            code: 'module_state_check_unavailable',
            reason: 'controlled locked unavailable check',
          }),
        );
      }
      return Effect.void;
    },
  } as const;
  const runtime = makeActionRuntime(
    database,
    repository,
    permission,
    testOperationalScopeResolver,
    {
      contextAccess: {
        legalEntities: () => Effect.succeed([]),
        modules: () => Effect.succeed([]),
        resources: () => Effect.succeed([]),
        tenants: ({ tenantIds }) =>
          Effect.succeed(
            tenantIds.map((key) => ({
              decision: options.tenantPermissionDecision ?? ('allowed' as const),
              key,
            })),
          ),
      },
      moduleEntrypointGateway: makeModuleEntrypointGateway(moduleStateGate),
      moduleStateGate,
      onStage: (stage) => {
        stages.push(stage);
      },
      resolveHandler: (action) => {
        handlerResolutionCount += 1;
        return getActionHandler(action);
      },
    },
  );

  return {
    counts: () => ({ createCount, lockCount, transactionCount, transitionCount }),
    finalized,
    flushed,
    gateCounts: () => ({ handlerResolutionCount, moduleStateReadCount, moduleStateRecheckCount }),
    permissionChecks,
    permissionCounts: () => ({ permissionCheckCount, rejectionCount }),
    rejections,
    runtime,
    stages,
  };
};

const registration = () =>
  defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'shell.counter.change',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {
        'counter.changed': Schema.Struct({ amount: Schema.Finite }),
      },
      entrypoint: defineSystemModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'shell.counter.change',
        moduleKey: 'core.shell',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'core.shell',
      payloadSchema: Schema.Struct({ amount: Schema.Finite }),
      policies: [],
      resultSchema: Schema.Struct({ total: Schema.Finite }),
      schemaVersion: '1',
    },
    (payload, context) =>
      Effect.gen(function* changeCounter() {
        assert.equal(context.actionInvocationId, 'invocation-1');
        assert.equal(Object.isFrozen(context), true);
        assert.equal('transaction' in context, false);
        assert.deepEqual(context.services, {});
        yield* context.recordDataAccess({
          accessKind: 'read',
          queryHash: `counter-${payload.amount}`,
          resultCount: 1,
          servingModuleKey: 'core.shell',
        });
        const domainEvent = yield* context.addDomainEvent({
          eventType: 'counter.changed',
          payloadJson: { amount: payload.amount },
          producerModuleKey: 'core.shell',
          subjectModuleKey: 'core.shell',
          subjectResourceId: 'primary',
          subjectResourceType: 'counter',
        });
        yield* context.addOutboxMessage(domainEvent, {
          payloadJson: { amount: payload.amount },
          producerModuleKey: 'core.shell',
          topic: 'counter.project',
        });
        return { total: payload.amount };
      }),
  );

test('executes the complete stage order with transaction ownership and success evidence', async () => {
  const harness = makeHarness();
  const result = await Effect.runPromise(
    harness.runtime.runAction({
      payload: { amount: 3 },
      principal,
      registration: registration(),
      transport: transport(),
    }),
  );

  assert.deepEqual(result, { total: 3 });
  assert.deepEqual(harness.stages, ACTION_RUNTIME_STAGES);
  assert.deepEqual(harness.counts(), {
    createCount: 1,
    lockCount: 1,
    transactionCount: 1,
    transitionCount: 1,
  });
  assert.equal(harness.flushed.length, 1);
  assert.equal(harness.flushed[0]?.evidence.dataAccessEvents.length, 1);
  assert.equal(harness.flushed[0]?.evidence.domainEvents.length, 1);
  assert.equal(harness.flushed[0]?.evidence.outboxMessages.length, 1);
  assert.deepEqual(harness.flushed[0]?.allowedPolicies, []);
  assert.deepEqual(harness.permissionChecks, [
    {
      actionKey: 'shell.counter.change',
      correlationId: 'correlation-intent-1',
      principalId: principal.principalId,
    },
  ]);
  assert.deepEqual(harness.gateCounts(), {
    handlerResolutionCount: 1,
    moduleStateReadCount: 0,
    moduleStateRecheckCount: 0,
  });
});

test('uses a resolver-branded recovery only for the exact support-stop Action and still checks permission', async () => {
  const recoveryPrincipal = await Effect.runPromise(
    supportRecoveryPrincipalContextResolverFromRepository({
      load: async () => ({
        bindingPrincipalId: principal.principalId,
        bindingTenantId: principal.tenantId,
        principalKind: 'human',
        principalTenantId: principal.tenantId,
        tenantId: principal.tenantId,
      }),
    }).resolveStoppedImpersonation({
      originalAuthBindingId: principal.authBindingId,
      originalPrincipalId: principal.principalId,
      originalSessionId: 'expired-original-session',
      tenantId: principal.tenantId,
    }),
  );
  const harness = makeHarness({
    permissionDecision: 'allowed',
    tenantPermissionDecision: 'denied',
  });

  const result = await Effect.runPromise(
    harness.runtime.runAction({
      payload: {
        checkpoint: 'stopped',
        originalPrincipalId: principal.principalId,
        reason: 'Securely terminate support access',
        sessionRef: 'better-auth-session:impersonated-session',
        targetPrincipalId: '00000000-0000-4000-8000-000000000099',
      },
      principal: recoveryPrincipal,
      registration: recordSupportImpersonationAction,
      transport: transport('support-recovery'),
    }),
  );

  assert.deepEqual(result, { checkpoint: 'stopped', recorded: true });
  assert.deepEqual(harness.permissionCounts(), { permissionCheckCount: 1, rejectionCount: 0 });

  const deniedHarness = makeHarness({ permissionDecision: 'denied' });
  const denied = await Effect.runPromise(
    Effect.flip(
      deniedHarness.runtime.runAction({
        payload: {
          checkpoint: 'stopped',
          originalPrincipalId: principal.principalId,
          reason: 'Securely terminate support access',
          sessionRef: 'better-auth-session:impersonated-session',
          targetPrincipalId: '00000000-0000-4000-8000-000000000099',
        },
        principal: recoveryPrincipal,
        registration: recordSupportImpersonationAction,
        transport: transport('support-recovery-denied'),
      }),
    ),
  );
  assert.equal(denied._tag, 'ActionPermissionDenied');
  assert.deepEqual(deniedHarness.permissionCounts(), {
    permissionCheckCount: 1,
    rejectionCount: 1,
  });

  const wrongCheckpoint = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: {
          checkpoint: 'requested',
          originalPrincipalId: principal.principalId,
          reason: 'Attempt to misuse recovery authority',
          targetPrincipalId: '00000000-0000-4000-8000-000000000099',
        },
        principal: recoveryPrincipal,
        registration: recordSupportImpersonationAction,
        transport: transport('support-recovery-wrong-checkpoint'),
      }),
    ),
  );
  assert.equal(wrongCheckpoint._tag, 'ActionTrustedContextValidationError');

  const wrongAction = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal: recoveryPrincipal,
        registration: registration(),
        transport: transport('support-recovery-wrong-action'),
      }),
    ),
  );
  assert.equal(wrongAction._tag, 'ActionTrustedContextValidationError');
});

test('fails business Actions closed before invocation, permission, Policy, or handler access', async () => {
  for (const [index, state] of (
    [
      'inactive',
      'read_only',
      'suspended',
      'quarantined',
      'deprecated',
      'archived',
      'missing',
    ] as const
  ).entries()) {
    let handlerCalls = 0;
    let policyCalls = 0;
    const harness = makeHarness({ moduleState: state });
    const action = defineAction(
      {
        accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'stock.read.v1' },
        actionKey: `inventory.stock.reserve-state-${index}`,
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
          entrypointKey: `inventory.stock.reserve-state-${index}`,
          moduleKey: 'inventory.stock',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: 'inventory.stock',
        payloadSchema: Schema.Void,
        policies: [
          defineGlobalPolicy({
            evaluate: () => Effect.sync(() => (policyCalls += 1)),
            policyKey: `global.unreachable-${index}.v1`,
          }),
        ],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () =>
        Effect.sync(() => {
          handlerCalls += 1;
        }),
    );
    const failure = await Effect.runPromise(
      Effect.flip(
        harness.runtime.runAction({
          payload: undefined,
          principal,
          registration: action,
          transport: transport(`state-${state}`),
        }),
      ),
    );
    assert.equal(failure._tag, 'ModuleStateDeniedError', state);
    assert.equal(handlerCalls, 0);
    assert.equal(policyCalls, 0);
    assert.deepEqual(harness.counts(), {
      createCount: 0,
      lockCount: 0,
      transactionCount: 0,
      transitionCount: 0,
    });
    assert.deepEqual(harness.permissionCounts(), {
      permissionCheckCount: 0,
      rejectionCount: 0,
    });
    assert.deepEqual(harness.gateCounts(), {
      handlerResolutionCount: 0,
      moduleStateReadCount: 1,
      moduleStateRecheckCount: 0,
    });
  }
});

test('distinguishes unavailable early checks and rolls back a denied locked recheck', async () => {
  const action = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'stock.read.v1' },
      actionKey: 'inventory.stock.reserve-locked',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'inventory.stock.reserve-locked',
        moduleKey: 'inventory.stock',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'inventory.stock',
      payloadSchema: Schema.Void,
      policies: [],
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    () => Effect.void,
  );

  const unavailable = makeHarness({ moduleState: 'unavailable' });
  const unavailableFailure = await Effect.runPromise(
    Effect.flip(
      unavailable.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport('state-unavailable'),
      }),
    ),
  );
  assert.equal(unavailableFailure._tag, 'ModuleStateCheckUnavailableError');
  assert.equal(unavailable.counts().createCount, 0);

  const locked = makeHarness({ lockedModuleState: 'denied' });
  const lockedFailure = await Effect.runPromise(
    Effect.flip(
      locked.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport('state-locked-denied'),
      }),
    ),
  );
  assert.equal(lockedFailure._tag, 'ModuleStateDeniedError');
  assert.deepEqual(locked.gateCounts(), {
    handlerResolutionCount: 0,
    moduleStateReadCount: 1,
    moduleStateRecheckCount: 1,
  });
  assert.deepEqual(locked.counts(), {
    createCount: 1,
    lockCount: 1,
    transactionCount: 1,
    transitionCount: 1,
  });
});

test('allows an explicitly authorized Action before Policy evaluation', async () => {
  const harness = makeHarness({ permissionDecision: 'allowed' });
  const result = await Effect.runPromise(
    harness.runtime.runAction({
      payload: { amount: 2 },
      principal,
      registration: registration(),
      transport: transport('allowed'),
    }),
  );

  assert.deepEqual(result, { total: 2 });
  assert.ok(
    harness.stages.indexOf('permission_checked') < harness.stages.indexOf('policy_boundary'),
  );
  assert.equal(harness.counts().transitionCount, 1);
  assert.equal(harness.counts().transactionCount, 1);
});

test('requires a declared tenant role independently from the Action executor relation', async () => {
  const tenantAuthorizedRegistration = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'identity.read.v1' },
      actionKey: 'core.identity.tenant-authorized',
      auditProfile: 'sensitive',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineSystemModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'core.identity.tenant-authorized',
        moduleKey: 'core.identity',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'core.identity',
      payloadSchema: Schema.Void,
      policies: [],
      resultSchema: Schema.Void,
      schemaVersion: '1',
      tenantPermission: () => 'manage_identity',
    },
    () => Effect.void,
  );

  for (const [decision, expectedTag] of [
    ['denied', 'ActionPermissionDenied'],
    ['unavailable', 'ActionPermissionCheckError'],
  ] as const) {
    const harness = makeHarness({
      permissionDecision: 'allowed',
      tenantPermissionDecision: decision,
    });
    const failure = await Effect.runPromise(
      Effect.flip(
        harness.runtime.runAction({
          payload: undefined,
          principal,
          registration: tenantAuthorizedRegistration,
          transport: transport(`tenant-${decision}`),
        }),
      ),
    );
    assert.equal(failure._tag, expectedTag);
    assert.equal(harness.counts().transitionCount, 0);
  }

  const allowed = makeHarness({
    permissionDecision: 'allowed',
    tenantPermissionDecision: 'allowed',
  });
  await Effect.runPromise(
    allowed.runtime.runAction({
      payload: undefined,
      principal,
      registration: tenantAuthorizedRegistration,
      transport: transport('tenant-allowed'),
    }),
  );
  assert.equal(allowed.counts().transitionCount, 1);
});

test('persists a definite permission denial before returning it and never evaluates Policies', async () => {
  let handlerCount = 0;
  let policyCount = 0;
  let serviceFactoryCount = 0;
  const harness = makeHarness({ permissionDecision: 'denied' });
  const deniedRegistration = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'shell.counter.denied',
      auditProfile: 'sensitive',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineSystemModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'shell.counter.denied',
        moduleKey: 'core.shell',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'core.shell',
      payloadSchema: Schema.Void,
      policies: [
        defineGlobalPolicy<unknown>({
          evaluate: () => {
            policyCount += 1;
            return Effect.void;
          },
          policyKey: 'global.unreachable-after-permission-denial.v1',
        }),
      ],
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    () => {
      handlerCount += 1;
      return Effect.void;
    },
    () => {
      serviceFactoryCount += 1;
      return Effect.succeed({});
    },
  );

  const failure = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: undefined,
        principal,
        registration: deniedRegistration,
        transport: transport('denied'),
      }),
    ),
  );

  assert.equal(failure._tag, 'ActionPermissionDenied');
  assert.equal(failure.code, 'action_permission_denied');
  assert.equal(handlerCount, 0);
  assert.equal(policyCount, 0);
  assert.equal(serviceFactoryCount, 0);
  assert.deepEqual(harness.stages, [
    'payload_decoded',
    'trusted_context_validated',
    'module_state_gate',
    'invocation_prepared',
    'authentication_boundary',
    'permission_checked',
  ]);
  assert.deepEqual(harness.permissionCounts(), {
    permissionCheckCount: 1,
    rejectionCount: 1,
  });
  assert.deepEqual(harness.counts(), {
    createCount: 1,
    lockCount: 0,
    transactionCount: 0,
    transitionCount: 0,
  });
  assert.deepEqual(harness.rejections, [
    {
      actionInvocationId: 'invocation-1',
      actionKey: 'shell.counter.denied',
      auditProfile: 'sensitive',
      principal,
      transport: transport('denied'),
    },
  ]);
});

test('fails closed before Policy evaluation when permission cannot be determined', async () => {
  const harness = makeHarness({ permissionFailure: true });
  const failure = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('unavailable'),
      }),
    ),
  );

  assert.equal(failure._tag, 'ActionPermissionCheckError');
  assert.deepEqual(harness.permissionCounts(), {
    permissionCheckCount: 1,
    rejectionCount: 0,
  });
  assert.deepEqual(harness.counts(), {
    createCount: 1,
    lockCount: 0,
    transactionCount: 0,
    transitionCount: 0,
  });
  assert.deepEqual(harness.stages, [
    'payload_decoded',
    'trusted_context_validated',
    'module_state_gate',
    'invocation_prepared',
    'authentication_boundary',
  ]);
});

test('does not claim permission denial when terminal evidence persistence rolls back', async () => {
  const harness = makeHarness({ permissionDecision: 'denied', rejectionFailure: true });
  const failure = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('permission-denial-persistence-failure'),
      }),
    ),
  );

  assert.equal(failure._tag, 'ActionTransactionError');
  assert.deepEqual(harness.permissionCounts(), {
    permissionCheckCount: 1,
    rejectionCount: 1,
  });
  assert.equal(harness.counts().transitionCount, 0);
  assert.equal(harness.counts().transactionCount, 0);
});

test('evaluates Policies in order before running and hands allowed checkpoints to success', async () => {
  const observed: string[] = [];
  const globalPolicy = defineGlobalPolicy<{ readonly amount: number }>({
    evaluate: () => {
      observed.push('global');
      return Effect.void;
    },
    policyKey: 'global.tenant-active.v1',
  });
  const modulePolicy = defineMicroverticalPolicy<{ readonly amount: number }, 'inventory.stock'>({
    evaluate: (input) => {
      observed.push(`module:${input.payload.amount}`);
      assert.equal(input.principal.principalId, principal.principalId);
      assert.equal(input.action.actionKey, 'inventory.stock.policy-allowed');
      assert.equal(input.target.targetResourceId, 'primary');
      assert.equal('idempotencyKey' in input.transport, false);
      return Effect.void;
    },
    owningModuleKey: 'inventory.stock',
    policyKey: 'inventory.stock.allowed.v1',
  });
  const action = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'inventory.stock.policy-allowed',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'inventory.stock.policy-allowed',
        moduleKey: 'inventory.stock',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'inventory.stock',
      payloadSchema: Schema.Struct({ amount: Schema.Finite }),
      policies: [globalPolicy, modulePolicy],
      resultSchema: Schema.Finite,
      schemaVersion: '1',
    },
    (payload) => {
      observed.push('handler');
      return Effect.succeed(payload.amount);
    },
  );
  const harness = makeHarness();

  const result = await Effect.runPromise(
    harness.runtime.runAction({
      payload: { amount: 4 },
      principal,
      registration: action,
      transport: { ...transport(), targetModuleKey: 'inventory.stock' },
    }),
  );

  assert.equal(result, 4);
  assert.deepEqual(observed, ['global', 'module:4', 'handler']);
  assert.deepEqual(harness.flushed[0]?.allowedPolicies, [
    { policyKey: 'global.tenant-active.v1', scope: 'global' },
    {
      owningModuleKey: 'inventory.stock',
      policyKey: 'inventory.stock.allowed.v1',
      scope: 'microvertical',
    },
  ]);
});

test('short-circuits the first Policy denial, finalizes it, and never starts execution', async () => {
  const observed: string[] = [];
  let handlerExecutions = 0;
  const policies = [
    defineGlobalPolicy<{ readonly amount: number }>({
      evaluate: () => {
        observed.push('first');
        return Effect.void;
      },
      policyKey: 'global.first.v1',
    }),
    defineGlobalPolicy<{ readonly amount: number }>({
      evaluate: () => {
        observed.push('denied');
        return Effect.fail(denyPolicy('counter_locked', 'Counter changes are locked — try later'));
      },
      policyKey: 'global.counter-locked.v1',
    }),
    defineGlobalPolicy<{ readonly amount: number }>({
      evaluate: () => {
        observed.push('unreachable');
        return Effect.void;
      },
      policyKey: 'global.unreachable.v1',
    }),
  ] as const;
  const action = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'shell.counter.policy-denied',
      auditProfile: 'sensitive',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineSystemModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'shell.counter.policy-denied',
        moduleKey: 'core.shell',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'core.shell',
      payloadSchema: Schema.Struct({ amount: Schema.Finite }),
      policies,
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    () => {
      handlerExecutions += 1;
      return Effect.void;
    },
  );
  const harness = makeHarness();

  const denial = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: action,
        transport: transport('policy-denied'),
      }),
    ),
  );

  assert.equal(denial._tag, 'ActionPolicyDenied');
  assert.equal(denial.policyReasonCode, 'counter_locked');
  assert.equal(denial.reason, 'Counter changes are locked — try later');
  assert.deepEqual(observed, ['first', 'denied']);
  assert.equal(handlerExecutions, 0);
  assert.deepEqual(harness.counts(), {
    createCount: 1,
    lockCount: 0,
    transactionCount: 0,
    transitionCount: 0,
  });
  assert.deepEqual(harness.stages, [
    'payload_decoded',
    'trusted_context_validated',
    'module_state_gate',
    'invocation_prepared',
    'authentication_boundary',
    'permission_checked',
    'policy_boundary',
  ]);
  assert.deepEqual(harness.finalized[0], {
    actionInvocationId: 'invocation-1',
    actionKey: 'shell.counter.policy-denied',
    auditProfile: 'sensitive',
    policy: { policyKey: 'global.counter-locked.v1', scope: 'global' },
    principal,
    reasonCode: 'counter_locked',
    transport: transport('policy-denied'),
  });
  assert.equal(harness.flushed.length, 0);
});

test('sanitizes Policy defects and interrupts without finalizing', async () => {
  const evaluators = [() => Effect.die('secret evaluator defect'), () => Effect.interrupt] as const;

  for (const [index, evaluate] of evaluators.entries()) {
    let handlerExecutions = 0;
    const policy = defineGlobalPolicy<unknown>({
      evaluate,
      policyKey: `global.failure-${index}.v1`,
    });
    const action = defineAction(
      {
        accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
        actionKey: `shell.counter.policy-failure-${index}`,
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
          entrypointKey: `shell.counter.policy-failure-${index}`,
          moduleKey: 'core.shell',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: 'core.shell',
        payloadSchema: Schema.Void,
        policies: [policy],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => {
        handlerExecutions += 1;
        return Effect.void;
      },
    );
    const harness = makeHarness();
    const error = await Effect.runPromise(
      Effect.flip(
        harness.runtime.runAction({
          payload: undefined,
          principal,
          registration: action,
          transport: transport(`policy-failure-${index}`),
        }),
      ),
    );

    assert.equal(error._tag, 'ActionPolicyEvaluationError');
    assert.equal(error.reason.includes('secret'), false);
    assert.equal(handlerExecutions, 0);
    assert.equal(harness.finalized.length, 0);
    assert.deepEqual(harness.counts(), {
      createCount: 1,
      lockCount: 0,
      transactionCount: 0,
      transitionCount: 0,
    });
  }
});

test('returns persistence failure when denial evidence cannot be finalized', async () => {
  let handlerExecutions = 0;
  const policy = defineGlobalPolicy<unknown>({
    evaluate: () => Effect.fail(denyPolicy('blocked', 'This action is blocked')),
    policyKey: 'global.blocked.v1',
  });
  const action = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'shell.counter.policy-persistence-failure',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineSystemModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'shell.counter.policy-persistence-failure',
        moduleKey: 'core.shell',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'core.shell',
      payloadSchema: Schema.Void,
      policies: [policy],
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    () => {
      handlerExecutions += 1;
      return Effect.void;
    },
  );
  const harness = makeHarness({ policyFinalizationFailure: true });

  const error = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport('policy-finalization-failure'),
      }),
    ),
  );

  assert.equal(error._tag, 'ActionInvocationPersistenceError');
  assert.equal(handlerExecutions, 0);
  assert.equal(harness.finalized.length, 0);
  assert.equal(harness.counts().transactionCount, 0);
});

test('creates fresh collectors for every execution', async () => {
  const harness = makeHarness();
  for (const [key, amount] of [
    ['first', 1],
    ['second', 2],
  ] as const) {
    await Effect.runPromise(
      harness.runtime.runAction({
        payload: { amount },
        principal,
        registration: registration(),
        transport: transport(key),
      }),
    );
  }

  assert.equal(harness.flushed.length, 2);
  assert.deepEqual(
    harness.flushed.map((item) => item.evidence.domainEvents.length),
    [1, 1],
  );
  assert.notEqual(harness.flushed[0]?.evidence, harness.flushed[1]?.evidence);
});

test('evaluates Policies afresh for separate invocations', async () => {
  let evaluations = 0;
  const policy = defineGlobalPolicy<{ readonly amount: number }>({
    evaluate: () => {
      evaluations += 1;
      return Effect.void;
    },
    policyKey: 'global.fresh-evaluation.v1',
  });
  const action = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'shell.counter.fresh-policy',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineSystemModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'shell.counter.fresh-policy',
        moduleKey: 'core.shell',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'core.shell',
      payloadSchema: Schema.Struct({ amount: Schema.Finite }),
      policies: [policy],
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    () => Effect.void,
  );
  for (const key of ['fresh-first', 'fresh-second']) {
    const harness = makeHarness({
      createRecord: {
        actionInvocationId: key,
        completedAt: null,
        requestHash: '',
        status: 'received',
      },
    });
    await Effect.runPromise(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: action,
        transport: transport(key),
      }),
    );
  }

  assert.equal(evaluations, 2);
});

test('rejects structural payloads, trusted context, and missing idempotency before invocation', async () => {
  const harness = makeHarness();
  const invalidPayload = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 'not-a-number' },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    ),
  );
  const invalidPrincipal = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal: { ...principal, principalId: 'not-a-uuid' },
        registration: registration(),
        transport: transport(),
      }),
    ),
  );
  const missingKey = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: { correlationId: 'correlation-missing-key' },
      }),
    ),
  );
  const forgedSystemPrincipal = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal: {
          authContextRef: 'job:forged:run:plain-object',
          authMethod: 'system',
          principalId: principal.principalId,
          tenantId: principal.tenantId,
        },
        registration: registration(),
        transport: transport('forged-system'),
      }),
    ),
  );

  assert.equal(invalidPayload._tag, 'ActionPayloadValidationError');
  assert.equal(invalidPrincipal._tag, 'ActionTrustedContextValidationError');
  assert.equal(missingKey._tag, 'ActionIdempotencyKeyRequired');
  assert.equal(forgedSystemPrincipal._tag, 'ActionTrustedContextValidationError');
  assert.equal(harness.counts().createCount, 0);
});

test('preserves declared domain rejections and rolls back collected evidence', async () => {
  class DomainRejected extends Schema.TaggedError<DomainRejected>()('DomainRejected', {
    reason: Schema.String,
  }) {}
  const harness = makeHarness();
  let policyEvaluations = 0;
  const allowedPolicy = defineGlobalPolicy<unknown>({
    evaluate: () => {
      policyEvaluations += 1;
      return Effect.void;
    },
    policyKey: 'global.domain-rejection-allowed.v1',
  });
  const rejected = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'shell.counter.reject',
      auditProfile: 'standard',
      domainErrorSchema: DomainRejected,
      domainEvents: {
        'counter.considered': Schema.Struct({}),
      },
      entrypoint: defineSystemModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'shell.counter.reject',
        moduleKey: 'core.shell',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'core.shell',
      payloadSchema: Schema.Void,
      policies: [allowedPolicy],
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    (_payload, context) =>
      Effect.gen(function* rejectCounter() {
        yield* context.addDomainEvent({
          eventType: 'counter.considered',
          payloadJson: {},
          producerModuleKey: 'core.shell',
          subjectModuleKey: 'core.shell',
          subjectResourceId: 'primary',
          subjectResourceType: 'counter',
        });
        return yield* new DomainRejected({ reason: 'counter_locked' });
      }),
  );

  const error = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: undefined,
        principal,
        registration: rejected,
        transport: transport(),
      }),
    ),
  );

  assert.equal(error._tag, 'DomainRejected');
  assert.equal(error.reason, 'counter_locked');
  assert.equal(policyEvaluations, 1);
  assert.equal(harness.flushed.length, 0);
});

test('sanitizes unexpected defects and rejects invalid typed results', async () => {
  const defectHarness = makeHarness();
  const defective = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'shell.counter.defect',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineSystemModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'shell.counter.defect',
        moduleKey: 'core.shell',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'core.shell',
      payloadSchema: Schema.Void,
      policies: [],
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    () => Effect.die('secret database detail'),
  );
  const defect = await Effect.runPromise(
    Effect.flip(
      defectHarness.runtime.runAction({
        payload: undefined,
        principal,
        registration: defective,
        transport: transport(),
      }),
    ),
  );

  const resultHarness = makeHarness();
  const invalidResult = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'shell.counter.invalid-result',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineSystemModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'shell.counter.invalid-result',
        moduleKey: 'core.shell',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'core.shell',
      payloadSchema: Schema.Void,
      policies: [],
      resultSchema: Schema.Struct({ total: Schema.Finite }),
      schemaVersion: '1',
    },
    () => {
      const result = { total: 0 };
      Object.defineProperty(result, 'total', { value: 'invalid' });
      return Effect.succeed(result);
    },
  );
  const resultError = await Effect.runPromise(
    Effect.flip(
      resultHarness.runtime.runAction({
        payload: undefined,
        principal,
        registration: invalidResult,
        transport: transport(),
      }),
    ),
  );

  assert.equal(defect._tag, 'ActionHandlerExecutionError');
  assert.equal(defect.reason.includes('secret'), false);
  assert.equal(resultError._tag, 'ActionResultValidationError');
  assert.equal(defectHarness.flushed.length, 0);
  assert.equal(resultHarness.flushed.length, 0);
});

test('sanitizes undeclared handler failures instead of widening the domain error contract', async () => {
  class DeclaredDomainError extends Schema.TaggedError<DeclaredDomainError>()(
    'DeclaredDomainError',
    { reason: Schema.String },
  ) {}
  const undeclaredDomainError = new DeclaredDomainError({
    reason: 'secret undeclared failure',
  });
  Object.defineProperty(undeclaredDomainError, '_tag', {
    value: 'UndeclaredDomainError',
  });
  const harness = makeHarness();
  const action = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'shell.counter.undeclared-error',
      auditProfile: 'standard',
      domainErrorSchema: DeclaredDomainError,
      domainEvents: {},
      entrypoint: defineSystemModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'shell.counter.undeclared-error',
        moduleKey: 'core.shell',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'core.shell',
      payloadSchema: Schema.Void,
      policies: [],
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    () => Effect.fail(undeclaredDomainError),
  );
  const error = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport(),
      }),
    ),
  );

  assert.equal(error._tag, 'ActionHandlerExecutionError');
  assert.equal(error.reason.includes('secret'), false);
  assert.equal(harness.flushed.length, 0);
});

test('handles committed, conflict, definite rollback, and indeterminate commit branches', async () => {
  const committed = makeHarness({
    createRecord: {
      actionInvocationId: 'committed',
      completedAt: null,
      requestHash: '',
      status: 'succeeded',
    },
  });
  const committedError = await Effect.runPromise(
    Effect.flip(
      committed.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    ),
  );

  const conflict = makeHarness({
    createRecord: {
      actionInvocationId: 'conflict',
      completedAt: null,
      requestHash: 'different-request-hash',
      status: 'running',
    },
  });
  const conflictError = await Effect.runPromise(
    Effect.flip(
      conflict.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    ),
  );

  const definite = makeHarness({ transactionMode: 'definite-failure' });
  const definiteError = await Effect.runPromise(
    Effect.flip(
      definite.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    ),
  );

  const uncertain = makeHarness({ transactionMode: 'uncertain' });
  const uncertainError = await Effect.runPromise(
    Effect.flip(
      uncertain.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    ),
  );

  const definiteCommit = makeHarness({ transactionMode: 'commit-definite' });
  const definiteCommitError = await Effect.runPromise(
    Effect.flip(
      definiteCommit.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('definite-commit'),
      }),
    ),
  );

  const acknowledgementFailureCodes = ['ETIMEDOUT', 'ECONNABORTED', 'ENETRESET', '08007'];
  const acknowledgementErrors = await Promise.all(
    acknowledgementFailureCodes.map(async (code) => {
      const harness = makeHarness({ commitFailureCode: code });
      return await Effect.runPromise(
        Effect.flip(
          harness.runtime.runAction({
            payload: { amount: 1 },
            principal,
            registration: registration(),
            transport: transport(`uncertain-${code}`),
          }),
        ),
      );
    }),
  );

  assert.equal(committedError._tag, 'ActionAlreadyCommitted');
  assert.equal(committed.counts().transactionCount, 0);
  assert.equal(committed.permissionCounts().permissionCheckCount, 0);
  assert.equal(conflictError._tag, 'ActionRequestHashConflict');
  assert.equal(conflict.counts().transactionCount, 0);
  assert.equal(conflict.permissionCounts().permissionCheckCount, 0);
  assert.equal(definiteError._tag, 'ActionTransactionError');
  assert.equal(definiteCommitError._tag, 'ActionTransactionError');
  assert.equal(uncertainError._tag, 'ActionCommitIndeterminate');
  assert.equal(uncertain.flushed.length, 1);
  assert.deepEqual(
    acknowledgementErrors.map((error) => error._tag),
    acknowledgementFailureCodes.map(() => 'ActionCommitIndeterminate'),
  );
});

test('resolves commit state explicitly and keeps unavailable outcomes indeterminate', async () => {
  const invocationId = '00000000-0000-4000-8000-000000000099';
  const open = makeHarness({
    createRecord: {
      actionInvocationId: invocationId,
      completedAt: null,
      requestHash: 'request',
      status: 'running',
    },
  });
  const openResolution = await Effect.runPromise(
    open.runtime.resolveActionCommit({ invocationId, principal }),
  );

  const committed = makeHarness({
    createRecord: {
      actionInvocationId: invocationId,
      completedAt: new Date(),
      requestHash: 'request',
      status: 'succeeded',
    },
  });
  const committedResolution = await Effect.runPromise(
    Effect.flip(committed.runtime.resolveActionCommit({ invocationId, principal })),
  );

  const unavailable = makeHarness({
    createRecord: {
      actionInvocationId: invocationId,
      completedAt: null,
      requestHash: 'request',
      status: 'indeterminate',
    },
    resolutionUnavailable: true,
  });
  const unavailableResolution = await Effect.runPromise(
    Effect.flip(unavailable.runtime.resolveActionCommit({ invocationId, principal })),
  );

  assert.deepEqual(openResolution, {
    _tag: 'ActionCommitOpen',
    invocationId,
  });
  assert.equal(committedResolution._tag, 'ActionAlreadyCommitted');
  assert.equal(unavailableResolution._tag, 'ActionCommitIndeterminate');
  assert.equal(unavailableResolution.invocationId, invocationId);
});

test('rejects terminal invocation states before handler execution', async () => {
  const terminal = makeHarness({
    createRecord: {
      actionInvocationId: 'terminal',
      completedAt: new Date(),
      requestHash: '',
      status: 'failed',
    },
  });
  const error = await Effect.runPromise(
    Effect.flip(
      terminal.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    ),
  );

  assert.equal(error._tag, 'ActionInvocationStateError');
  assert.equal(terminal.counts().transitionCount, 0);
  assert.equal(terminal.counts().transactionCount, 0);
});

test('uses one runtime contract for Shell/Core and MicroVertical-shaped registrations', async () => {
  const shell = makeHarness();
  const microvertical = makeHarness();
  const moduleRegistration = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'stock.read.v1' },
      actionKey: 'inventory.stock.reserve',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'inventory.stock.reserve',
        moduleKey: 'inventory.stock',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'inventory.stock',
      payloadSchema: Schema.Struct({ quantity: Schema.Finite }),
      policies: [],
      resultSchema: Schema.Struct({ reserved: Schema.Boolean }),
      schemaVersion: '1',
    },
    () => Effect.succeed({ reserved: true }),
  );

  const shellResult = await Effect.runPromise(
    shell.runtime.runAction({
      payload: { amount: 1 },
      principal,
      registration: registration(),
      transport: transport('shell'),
    }),
  );
  const moduleResult = await Effect.runPromise(
    microvertical.runtime.runAction({
      payload: { quantity: 2 },
      principal,
      registration: moduleRegistration,
      transport: {
        ...transport('microvertical'),
        targetModuleKey: 'inventory.stock',
      },
    }),
  );

  assert.deepEqual(shellResult, { total: 1 });
  assert.deepEqual(moduleResult, { reserved: true });
});

test('the Core database service identity remains server-only', () => {
  assert.equal(Predicate.isFunction(CoreDatabase), true);
});
