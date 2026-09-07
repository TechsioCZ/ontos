import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
/* oxlint-disable sonarjs/use-type-alias -- Existing compatibility boundary; expires: 2026-12-31. */
// @effect-diagnostics asyncFunction:off globalDate:off globalDateInEffect:off missingEffectError:off unsafeEffectTypeAssertion:off -- Existing compatibility boundary; expires: 2026-12-31.
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Option, Predicate, Schema } from 'effect';
import { ConnectionError, SqlError } from 'effect/unstable/sql/SqlError';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defineAction,
  defineActionResourcePermission,
  getActionHandler,
} from '../../src/actions/definition.ts';
import {
  ActionInvocationPersistenceError,
  ActionPermissionCheckError,
  ActionTransactionError,
} from '../../src/actions/errors.ts';
import {
  defineGlobalPolicy,
  defineMicroverticalPolicy,
  denyPolicy,
} from '../../src/actions/policy.ts';
import type {
  ActionInvocationRecord,
  ActionRepositoryService,
  FinalizeActionPolicyDenialInput,
  FlushActionSuccessInput,
  RejectPermissionDeniedInput,
} from '../../src/actions/repository.ts';
import {
  computeActionRequestHash,
  computeCanonicalValueHash,
  getActionInvocationPersistenceFailureCause,
  getActionTransactionFailureCause,
  makeActionRepository,
} from '../../src/actions/repository.ts';
import type { ActionRuntimeStage } from '../../src/actions/runtime.ts';
import { ACTION_RUNTIME_STAGES, makeActionRuntime } from '../../src/actions/runtime.ts';
import type { PrincipalManagementRepositoryService } from '../../src/auth/principal-management.ts';
import { PrincipalManagementRepository } from '../../src/auth/principal-management.ts';
import { supportRecoveryPrincipalContextResolverFromRepository } from '../../src/auth/support-recovery-principal-context.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { recordSupportImpersonationAction } from '../../src/modules/actions/record-support-impersonation.action.ts';
import { makeModuleEntrypointGateway } from '../../src/modules/module-entrypoint-gateway.ts';
import type { ModuleEntrypointDescriptor } from '../../src/modules/module-entrypoint.ts';
import {
  defineSystemModuleEntrypoint,
  defineTenantModuleEntrypoint,
} from '../../src/modules/module-entrypoint.ts';
import {
  ModuleStateCheckUnavailableError,
  ModuleStateDeniedError,
} from '../../src/modules/module-state-gate-errors.ts';
import {
  checkModuleEntrypoint,
  makeModuleStateSnapshot,
} from '../../src/modules/module-state-gate.ts';
import type { TenantModuleState } from '../../src/modules/tenant-module-state-service.ts';
import type {
  ActionPermissionDecision,
  CheckActionPermissionInput,
} from '../../src/permissions/service.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import { makeTestDatabase } from '../support/database.ts';

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

const CounterpartyIdSchema = Schema.String.pipe(Schema.brand('CounterpartyId'));
type CounterpartyId = typeof CounterpartyIdSchema.Type;
const completionTime = () => DateTime.toDateUtc(DateTime.makeUnsafe(0));

const forEachSequential = async <Item>(
  items: readonly Item[],
  run: (item: Item) => Promise<void>,
): Promise<void> => {
  const iterator = items.values();
  const visitNext = async (): Promise<void> => {
    const next = iterator.next();
    if (next.done === true) {
      return;
    }
    await run(next.value);
    await visitNext();
  };
  await visitNext();
};

const unusedPrincipalManagementOperation = () =>
  Effect.die('The ambient PrincipalManagementRepository must not be used by the Action runtime');
const ambientPrincipalManagementRepository: PrincipalManagementRepositoryService = {
  bindApiKey: unusedPrincipalManagementOperation,
  changePrincipalStatus: unusedPrincipalManagementOperation,
  createNonHumanPrincipal: unusedPrincipalManagementOperation,
  setApiKeyBindingStatus: unusedPrincipalManagementOperation,
  validateSupportImpersonation: unusedPrincipalManagementOperation,
};
const providePrincipalManagementRepository = Effect.provideService(
  PrincipalManagementRepository,
  ambientPrincipalManagementRepository,
);

interface HarnessOptions {
  readonly commit?: Effect.Effect<readonly object[], SqlError>;
  readonly commitFailureCode?: string;
  readonly createRecord?: ActionInvocationRecord;
  readonly legalEntityPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
  readonly lockedModuleState?: 'active' | 'denied' | 'unavailable';
  readonly moduleState?: TenantModuleState | 'missing' | 'unavailable';
  readonly permissionDecision?: ActionPermissionDecision;
  readonly permissionFailure?: boolean;
  readonly policyFinalizationFailure?: boolean;
  readonly rejectionFailure?: boolean;
  readonly resolutionUnavailable?: boolean;
  readonly resourcePermissionDecision?: 'allowed' | 'denied' | 'unavailable';
  readonly tenantPermissionDecision?: 'allowed' | 'denied' | 'unavailable';
  readonly transactionMode?: 'commit-definite' | 'definite-failure' | 'normal' | 'uncertain';
}

const makeHarness = (options: HarnessOptions = {}) => {
  const finalized: FinalizeActionPolicyDenialInput[] = [];
  const flushed: FlushActionSuccessInput[] = [];
  const legalEntityChecks: unknown[] = [];
  const permissionChecks: CheckActionPermissionInput[] = [];
  const rejections: RejectPermissionDeniedInput[] = [];
  const requestHashes: string[] = [];
  const resourceChecks: unknown[] = [];
  const stages: ActionRuntimeStage[] = [];
  const tenantChecks: unknown[] = [];
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
      requestHashes.push(input.requestHash);
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
        completedAt: completionTime(),
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
        completedAt: completionTime(),
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
  const query = (statement: string, values: readonly unknown[]) =>
    Effect.gen(function* executeQuery() {
      const text = statement.toLowerCase();
      if (text.includes('set_config')) {
        const [tenantId, legalEntityId] = values;
        if (Predicate.isString(tenantId) && Predicate.isString(legalEntityId)) {
          installedTenantId = tenantId;
          installedLegalEntityId = legalEntityId;
        }
      }
      if (text === 'begin') {
        transactionCount += 1;
        if (options.transactionMode === 'definite-failure') {
          return yield* new SqlError({
            reason: new ConnectionError({ cause: new Error('transaction unavailable') }),
          });
        }
      }
      if (text === 'commit') {
        const defaultCommitCodes = { 'commit-definite': '40001', uncertain: '08007' };
        const defaultCode =
          options.transactionMode === 'uncertain' || options.transactionMode === 'commit-definite'
            ? defaultCommitCodes[options.transactionMode]
            : undefined;
        const code = options.commitFailureCode ?? defaultCode;
        if (code !== undefined) {
          return yield* new SqlError({ reason: new ConnectionError({ cause: { code } }) });
        }
        if (options.commit !== undefined) {
          return yield* options.commit;
        }
      }
      if (text.includes('current_setting')) {
        return [{ legal_entity_id: installedLegalEntityId, tenant_id: installedTenantId }];
      }
      if (text.startsWith('select')) {
        return [{ authBindingId: principal.authBindingId }];
      }
      return [];
    });
  const database = { executor: makeTestDatabase(query) };

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
        legalEntities: (input) => {
          legalEntityChecks.push(input);
          return Effect.succeed(
            input.legalEntityIds.map((key) => ({
              decision: options.legalEntityPermissionDecision ?? ('allowed' as const),
              key,
            })),
          );
        },
        modules: () => Effect.succeed([]),
        resources: (input) => {
          resourceChecks.push(input);
          return Effect.succeed(
            input.resources.map(({ moduleId, resourceId, resourceType }) => ({
              decision: options.resourcePermissionDecision ?? ('allowed' as const),
              key: `${moduleId}:${resourceType}:${resourceId}`,
            })),
          );
        },
        tenants: (input) => {
          tenantChecks.push(input);
          return Effect.succeed(
            input.tenantIds.map((key) => ({
              decision: options.tenantPermissionDecision ?? ('allowed' as const),
              key,
            })),
          );
        },
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
    legalEntityChecks,
    permissionChecks,
    permissionCounts: () => ({ permissionCheckCount, rejectionCount }),
    rejections,
    requestHashes,
    resourceChecks,
    runtime,
    stages,
    tenantChecks,
  };
};

const makeRepositoryFailures = async () => {
  const cause = new SqlError({
    reason: new ConnectionError({ cause: new Error('private repository defect') }),
  });
  const executor = makeTestDatabase(() => Effect.fail(cause));
  const repository = makeActionRepository();
  const input = {
    actionInvocationId: 'invocation-1',
    actionKey: 'shell.counter.denied',
    auditProfile: 'sensitive',
    principal,
    transport: transport('denied'),
  } as const;
  const transactionFailure = await runEffectTestPromise(
    Effect.flip(repository.rejectPermissionDenied(executor, input)),
  );
  const persistenceFailure = await runEffectTestPromise(
    Effect.flip(
      repository.finalizePolicyDenial(executor, {
        ...input,
        policy: { policyKey: 'global.counter-locked.v1', scope: 'global' },
        reasonCode: 'counter_locked',
      }),
    ),
  );
  assert.ok(Schema.is(ActionTransactionError)(transactionFailure));
  assert.ok(Schema.is(ActionInvocationPersistenceError)(persistenceFailure));
  return { cause, persistenceFailure, transactionFailure };
};

void test('repository constructors retain original causes across Effect Cause propagation', async () => {
  const { cause, persistenceFailure, transactionFailure } = await makeRepositoryFailures();
  const propagatedTransaction = await runEffectTestPromise(
    Effect.flip(Effect.failCause(Cause.fail(transactionFailure))),
  );
  const propagatedPersistence = await runEffectTestPromise(
    Effect.flip(Effect.failCause(Cause.fail(persistenceFailure))),
  );
  assert.equal(propagatedTransaction, transactionFailure);
  assert.equal(propagatedPersistence, persistenceFailure);
  assert.deepEqual(getActionTransactionFailureCause(propagatedTransaction), Cause.die(cause));
  assert.deepEqual(
    getActionInvocationPersistenceFailureCause(propagatedPersistence),
    Cause.die(cause),
  );
});

void test('public error classes expose no retained-cause accessors', () => {
  for (const errorClass of [ActionTransactionError, ActionInvocationPersistenceError]) {
    assert.equal('withCause' in errorClass, false);
    assert.equal('causeOf' in errorClass, false);
  }
});

void test('repository causes are absent from reflection, JSON, and Schema encoding', async () => {
  const { persistenceFailure, transactionFailure } = await makeRepositoryFailures();
  const publicTransaction = new ActionTransactionError({
    code: transactionFailure.code,
    reason: transactionFailure.reason,
  });
  const publicPersistence = new ActionInvocationPersistenceError({
    code: persistenceFailure.code,
    reason: persistenceFailure.reason,
  });
  assert.deepEqual(Object.keys(transactionFailure), Object.keys(publicTransaction));
  assert.deepEqual(Object.keys(persistenceFailure), Object.keys(publicPersistence));
  assert.deepEqual(Reflect.ownKeys(transactionFailure), Reflect.ownKeys(publicTransaction));
  assert.deepEqual(Reflect.ownKeys(persistenceFailure), Reflect.ownKeys(publicPersistence));
  assert.equal(JSON.stringify(transactionFailure), JSON.stringify(publicTransaction));
  assert.equal(JSON.stringify(persistenceFailure), JSON.stringify(publicPersistence));
  assert.deepEqual(Schema.encodeSync(ActionTransactionError)(transactionFailure), {
    _tag: 'ActionTransactionError',
    code: transactionFailure.code,
    reason: transactionFailure.reason,
  });
  assert.deepEqual(Schema.encodeSync(ActionInvocationPersistenceError)(persistenceFailure), {
    _tag: 'ActionInvocationPersistenceError',
    code: persistenceFailure.code,
    reason: persistenceFailure.reason,
  });
});

void test('repository cause readers reject foreign objects carrying the former cause property', () => {
  const formerCauseProperty = ['ontos', 'Repository', 'Failure', 'Cause'].join('');
  const cause = new Error('foreign defect');
  const transactionFailure = Object.assign(
    new ActionTransactionError({ code: 'action_transaction_failed', reason: 'foreign failure' }),
    { [formerCauseProperty]: cause },
  );
  const persistenceFailure = Object.assign(
    new ActionInvocationPersistenceError({
      code: 'action_invocation_persistence_failed',
      reason: 'foreign failure',
    }),
    { [formerCauseProperty]: cause },
  );
  assert.equal(getActionTransactionFailureCause(transactionFailure), undefined);
  assert.equal(getActionInvocationPersistenceFailureCause(persistenceFailure), undefined);
});

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

void test('executes the complete stage order with transaction ownership and success evidence', async () => {
  const harness = makeHarness();
  const result = await runEffectTestPromise(
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

void test('hashes the encoded representation of decoded DateTime and Option values', async () => {
  const occurredAt = '2026-09-07T10:30:00.000Z';
  const payloadSchema = Schema.Struct({
    note: Schema.OptionFromNullOr(Schema.String),
    occurredAt: Schema.DateTimeUtcFromString,
  });
  const action = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'shell.temporal.v1' },
      actionKey: 'shell.temporal.change',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineSystemModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'shell.temporal.change',
        moduleKey: 'core.shell',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'core.shell',
      payloadSchema,
      policies: [],
      resultSchema: payloadSchema,
      schemaVersion: '1',
    },
    (payload) => {
      assert.equal(DateTime.formatIso(payload.occurredAt), occurredAt);
      assert.equal(Option.isNone(payload.note), true);
      return Effect.succeed(payload);
    },
  );
  const harness = makeHarness();

  const result = await runEffectTestPromise(
    harness.runtime.runAction({
      payload: { note: null, occurredAt },
      principal,
      registration: action,
      transport: transport('temporal-payload'),
    }),
  );

  assert.deepEqual(harness.requestHashes, [
    computeActionRequestHash({
      actionKey: 'shell.temporal.change',
      normalizedPayload: { note: null, occurredAt },
      owningModuleKey: 'core.shell',
      principal,
      schemaVersion: '1',
      target: {
        targetModuleKey: 'core.shell',
        targetResourceId: 'primary',
        targetResourceType: 'counter',
      },
    }),
  ]);
  assert.equal(DateTime.formatIso(result.occurredAt), occurredAt);
  assert.equal(Option.isNone(result.note), true);
  assert.equal(
    harness.flushed[0]?.resultHash,
    computeCanonicalValueHash({ note: null, occurredAt }),
  );
});

void test('uses a resolver-branded recovery only for the exact support-stop Action and still checks permission', async () => {
  const recoveryPrincipal = await runEffectTestPromise(
    supportRecoveryPrincipalContextResolverFromRepository({
      load: () =>
        Effect.succeed(
          Option.some({
            bindingPrincipalId: principal.principalId,
            bindingTenantId: principal.tenantId,
            principalKind: 'human' as const,
            principalTenantId: principal.tenantId,
            tenantId: principal.tenantId,
          }),
        ),
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

  const result = await runEffectTestPromise(
    harness.runtime
      .runAction({
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
      })
      .pipe(providePrincipalManagementRepository),
  );

  assert.deepEqual(result, { checkpoint: 'stopped', recorded: true });
  assert.deepEqual(harness.permissionCounts(), { permissionCheckCount: 1, rejectionCount: 0 });

  const deniedHarness = makeHarness({ permissionDecision: 'denied' });
  const denied = await runEffectTestPromise(
    Effect.flip(
      deniedHarness.runtime
        .runAction({
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
        })
        .pipe(providePrincipalManagementRepository),
    ),
  );
  assert.ok(Predicate.isTagged(denied, 'ActionPermissionDenied'));
  assert.deepEqual(deniedHarness.permissionCounts(), {
    permissionCheckCount: 1,
    rejectionCount: 1,
  });

  const wrongCheckpoint = await runEffectTestPromise(
    Effect.flip(
      harness.runtime
        .runAction({
          payload: {
            checkpoint: 'requested',
            originalPrincipalId: principal.principalId,
            reason: 'Attempt to misuse recovery authority',
            targetPrincipalId: '00000000-0000-4000-8000-000000000099',
          },
          principal: recoveryPrincipal,
          registration: recordSupportImpersonationAction,
          transport: transport('support-recovery-wrong-checkpoint'),
        })
        .pipe(providePrincipalManagementRepository),
    ),
  );
  assert.ok(Predicate.isTagged(wrongCheckpoint, 'ActionTrustedContextValidationError'));

  const wrongAction = await runEffectTestPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal: recoveryPrincipal,
        registration: registration(),
        transport: transport('support-recovery-wrong-action'),
      }),
    ),
  );
  assert.ok(Predicate.isTagged(wrongAction, 'ActionTrustedContextValidationError'));
});

void test('fails business Actions closed before invocation, permission, Policy, or handler access', async () => {
  await forEachSequential(
    (
      [
        'inactive',
        'read_only',
        'suspended',
        'quarantined',
        'deprecated',
        'archived',
        'missing',
      ] as const
    ).map((state, index) => [index, state] as const),
    async ([index, state]) => {
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
      const failure = await runEffectTestPromise(
        Effect.flip(
          harness.runtime.runAction({
            payload: undefined,
            principal,
            registration: action,
            transport: transport(`state-${state}`),
          }),
        ),
      );
      assert.ok(Predicate.isTagged(failure, 'ModuleStateDeniedError'), state);
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
    },
  );
});

void test('distinguishes unavailable early checks and rolls back a denied locked recheck', async () => {
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
  const unavailableFailure = await runEffectTestPromise(
    Effect.flip(
      unavailable.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport('state-unavailable'),
      }),
    ),
  );
  assert.ok(Predicate.isTagged(unavailableFailure, 'ModuleStateCheckUnavailableError'));
  assert.equal(unavailable.counts().createCount, 0);

  const locked = makeHarness({ lockedModuleState: 'denied' });
  const lockedFailure = await runEffectTestPromise(
    Effect.flip(
      locked.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport('state-locked-denied'),
      }),
    ),
  );
  assert.ok(Predicate.isTagged(lockedFailure, 'ModuleStateDeniedError'));
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

void test('allows an explicitly authorized Action before Policy evaluation', async () => {
  const harness = makeHarness({ permissionDecision: 'allowed' });
  const result = await runEffectTestPromise(
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

void test('requires a declared tenant role independently from the Action executor relation', async () => {
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

  await forEachSequential(
    [
      ['denied', 'ActionPermissionDenied'],
      ['unavailable', 'ActionPermissionCheckError'],
    ] as const,
    async ([decision, expectedTag]) => {
      const harness = makeHarness({
        permissionDecision: 'allowed',
        tenantPermissionDecision: decision,
      });
      const failure = await runEffectTestPromise(
        Effect.flip(
          harness.runtime.runAction({
            payload: undefined,
            principal,
            registration: tenantAuthorizedRegistration,
            transport: transport(`tenant-${decision}`),
          }),
        ),
      );
      assert.ok(Predicate.isTagged(failure, expectedTag));
      assert.equal(harness.counts().transitionCount, 0);
    },
  );

  const allowed = makeHarness({
    permissionDecision: 'allowed',
    tenantPermissionDecision: 'allowed',
  });
  await runEffectTestPromise(
    allowed.runtime.runAction({
      payload: undefined,
      principal,
      registration: tenantAuthorizedRegistration,
      transport: transport('tenant-allowed'),
    }),
  );
  assert.equal(allowed.counts().transitionCount, 1);
});

void test('accepts every Party write authority as an explicit tenant permission', async () => {
  const partyPermissions = [
    'manage_party_identity',
    'manage_party_relationships',
    'merge_party_identity',
    'review_party_identity',
  ] as const;
  await forEachSequential(
    partyPermissions.map((permission, index) => [index, permission] as const),
    async ([index, permission]) => {
      const actionKey = `party.registry.permission-${index}`;
      const action = defineAction(
        {
          accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'party.read.v1' },
          actionKey,
          auditProfile: 'sensitive',
          domainErrorSchema: Schema.Never,
          domainEvents: {},
          entrypoint: defineTenantModuleEntrypoint({
            access: 'write',
            authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
            entrypointKey: actionKey,
            moduleKey: 'party.registry',
            role: 'action',
          }),
          idempotency: 'required',
          legalEntityScope: 'optional',
          owningModuleKey: 'party.registry',
          payloadSchema: Schema.Void,
          policies: [],
          resultSchema: Schema.Void,
          schemaVersion: '1',
          tenantPermission: () => permission,
        },
        () => Effect.void,
      );
      const harness = makeHarness();
      await runEffectTestPromise(
        harness.runtime.runAction({
          payload: undefined,
          principal,
          registration: action,
          transport: transport(permission),
        }),
      );
      assert.deepEqual(harness.tenantChecks, [
        {
          permission,
          principalId: principal.principalId,
          tenantIds: [principal.tenantId],
        },
      ]);
      assert.deepEqual(harness.flushed[0]?.transport, {
        correlationId: `correlation-${permission}`,
        idempotencyKey: permission,
      });
    },
  );
});

void test('canonicalizes every resolved tenant permission target for hash and evidence', async () => {
  const action = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'identity.read.v1' },
      actionKey: 'core.identity.rotate-managed-key',
      auditProfile: 'sensitive',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineSystemModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'core.identity.rotate-managed-key',
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
  const first = makeHarness();
  const second = makeHarness();
  await runEffectTestPromise(
    first.runtime.runAction({
      payload: undefined,
      principal,
      registration: action,
      transport: {
        ...transport('same-idempotency-key'),
        targetModuleKey: 'forged.one',
        targetResourceId: 'forged-one',
        targetResourceType: 'first',
      },
    }),
  );
  await runEffectTestPromise(
    second.runtime.runAction({
      payload: undefined,
      principal,
      registration: action,
      transport: {
        ...transport('same-idempotency-key'),
        targetModuleKey: 'forged.two',
        targetResourceId: 'forged-two',
        targetResourceType: 'second',
      },
    }),
  );

  assert.deepEqual(first.requestHashes, second.requestHashes);
  assert.deepEqual(first.flushed[0]?.transport, {
    correlationId: 'correlation-same-idempotency-key',
    idempotencyKey: 'same-idempotency-key',
  });
  assert.deepEqual(second.flushed[0]?.transport, first.flushed[0]?.transport);
});

void test('authorizes Counterparty creation against the trusted Legal Entity before Policy and transaction', async () => {
  let handlerCalls = 0;
  let policyCalls = 0;
  const action = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counterparty.read.v1' },
      actionKey: 'party.registry.create-counterparty',
      auditProfile: 'sensitive',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'party.registry.create-counterparty',
        moduleKey: 'party.registry',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityPermission: 'manage_counterparty',
      legalEntityScope: 'required',
      owningModuleKey: 'party.registry',
      payloadSchema: Schema.Void,
      policies: [
        defineGlobalPolicy<unknown>({
          evaluate: (input) => {
            policyCalls += 1;
            assert.deepEqual(input.target, {});
            return Effect.void;
          },
          policyKey: 'party.registry.counterparty-create.v1',
        }),
      ],
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    () => {
      handlerCalls += 1;
      return Effect.void;
    },
  );
  const forgedTransport = {
    ...transport('legal-entity-denied'),
    targetModuleKey: 'forged.module',
    targetResourceId: 'forged-legal-entity',
    targetResourceType: 'legal_entity',
  };

  const denied = makeHarness({ legalEntityPermissionDecision: 'denied' });
  const failure = await runEffectTestPromise(
    Effect.flip(
      denied.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: forgedTransport,
      }),
    ),
  );
  assert.ok(Predicate.isTagged(failure, 'ActionPermissionDenied'));
  assert.equal(policyCalls, 0);
  assert.equal(handlerCalls, 0);
  assert.equal(denied.counts().transactionCount, 0);
  assert.deepEqual(denied.legalEntityChecks, [
    {
      legalEntityIds: [principal.legalEntityId],
      permission: 'manage_counterparty',
      principalId: principal.principalId,
      tenantId: principal.tenantId,
    },
  ]);
  assert.deepEqual(denied.rejections[0]?.transport, {
    correlationId: 'correlation-legal-entity-denied',
    idempotencyKey: 'legal-entity-denied',
  });
  assert.equal(denied.stages.at(-1), 'permission_checked');

  const unavailable = makeHarness({ legalEntityPermissionDecision: 'unavailable' });
  const unavailableFailure = await runEffectTestPromise(
    Effect.flip(
      unavailable.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: forgedTransport,
      }),
    ),
  );
  assert.ok(Predicate.isTagged(unavailableFailure, 'ActionPermissionCheckError'));
  assert.equal(unavailable.rejections.length, 0);
  assert.equal(unavailable.counts().transactionCount, 0);
  assert.equal(unavailable.stages.includes('permission_checked'), false);

  const allowed = makeHarness();
  await runEffectTestPromise(
    allowed.runtime.runAction({
      payload: undefined,
      principal,
      registration: action,
      transport: {
        ...forgedTransport,
        idempotencyKey: 'legal-entity-allowed',
      },
    }),
  );
  assert.equal(policyCalls, 1);
  assert.equal(handlerCalls, 1);
  assert.deepEqual(allowed.flushed[0]?.transport, {
    correlationId: 'correlation-legal-entity-denied',
    idempotencyKey: 'legal-entity-allowed',
  });
  assert.ok(
    allowed.stages.indexOf('permission_checked') < allowed.stages.indexOf('policy_boundary'),
  );
});

void test('authorizes the resolved Resource target before Policy, transaction, and handler', async () => {
  let handlerCalls = 0;
  let policyCalls = 0;
  const action = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counterparty.read.v1' },
      actionKey: 'party.registry.end-counterparty-role',
      auditProfile: 'sensitive',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'party.registry.end-counterparty-role',
        moduleKey: 'party.registry',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'required',
      owningModuleKey: 'party.registry',
      payloadSchema: Schema.Struct({ counterpartyId: CounterpartyIdSchema }),
      policies: [
        defineGlobalPolicy<{ readonly counterpartyId: CounterpartyId }>({
          evaluate: (input) => {
            policyCalls += 1;
            assert.deepEqual(input.target, {
              targetModuleKey: 'party.registry',
              targetResourceId: 'counterparty-1',
              targetResourceType: 'counterparty',
            });
            return Effect.void;
          },
          policyKey: 'party.registry.role-end.v1',
        }),
      ],
      resourcePermission: defineActionResourcePermission<{
        readonly counterpartyId: CounterpartyId;
      }>(({ counterpartyId }, scope) => {
        assert.equal(scope.legalEntityId, principal.legalEntityId);
        return {
          permission: 'write',
          resource: {
            moduleId: 'party.registry',
            resourceId: counterpartyId,
            resourceType: 'counterparty',
          },
        };
      }),
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    () => {
      handlerCalls += 1;
      return Effect.void;
    },
  );

  const denied = makeHarness({ resourcePermissionDecision: 'denied' });
  const failure = await runEffectTestPromise(
    Effect.flip(
      denied.runtime.runAction({
        payload: { counterpartyId: 'counterparty-1' },
        principal,
        registration: action,
        transport: {
          ...transport('resource-denied'),
          targetModuleKey: 'forged.module',
          targetResourceId: 'forged-resource',
          targetResourceType: 'forged-type',
        },
      }),
    ),
  );

  assert.ok(Predicate.isTagged(failure, 'ActionPermissionDenied'));
  assert.equal(policyCalls, 0);
  assert.equal(handlerCalls, 0);
  assert.equal(denied.counts().transactionCount, 0);
  assert.deepEqual(denied.resourceChecks, [
    {
      legalEntityId: principal.legalEntityId,
      permission: 'write',
      principalId: principal.principalId,
      resources: [
        {
          moduleId: 'party.registry',
          resourceId: 'counterparty-1',
          resourceType: 'counterparty',
        },
      ],
      tenantId: principal.tenantId,
    },
  ]);
  assert.deepEqual(denied.rejections[0]?.transport, {
    correlationId: 'correlation-resource-denied',
    idempotencyKey: 'resource-denied',
    targetModuleKey: 'party.registry',
    targetResourceId: 'counterparty-1',
    targetResourceType: 'counterparty',
  });

  const unavailable = makeHarness({ resourcePermissionDecision: 'unavailable' });
  const unavailableFailure = await runEffectTestPromise(
    Effect.flip(
      unavailable.runtime.runAction({
        payload: { counterpartyId: 'counterparty-1' },
        principal,
        registration: action,
        transport: transport('resource-unavailable'),
      }),
    ),
  );
  assert.ok(Predicate.isTagged(unavailableFailure, 'ActionPermissionCheckError'));
  assert.equal(unavailable.rejections.length, 0);
  assert.equal(unavailable.counts().transactionCount, 0);
});

void test('persists a definite permission denial before returning it and never evaluates Policies', async () => {
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

  const failure = await runEffectTestPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: undefined,
        principal,
        registration: deniedRegistration,
        transport: transport('denied'),
      }),
    ),
  );

  assert.ok(Predicate.isTagged(failure, 'ActionPermissionDenied'));
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

void test('fails closed before Policy evaluation when permission cannot be determined', async () => {
  const harness = makeHarness({ permissionFailure: true });
  const failure = await runEffectTestPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('unavailable'),
      }),
    ),
  );

  assert.ok(Predicate.isTagged(failure, 'ActionPermissionCheckError'));
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

void test('does not claim permission denial when terminal evidence persistence rolls back', async () => {
  const harness = makeHarness({ permissionDecision: 'denied', rejectionFailure: true });
  const failure = await runEffectTestPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('permission-denial-persistence-failure'),
      }),
    ),
  );

  assert.ok(Predicate.isTagged(failure, 'ActionTransactionError'));
  assert.deepEqual(harness.permissionCounts(), {
    permissionCheckCount: 1,
    rejectionCount: 1,
  });
  assert.equal(harness.counts().transitionCount, 0);
  assert.equal(harness.counts().transactionCount, 0);
});

void test('evaluates Policies in order before running and hands allowed checkpoints to success', async () => {
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

  const result = await runEffectTestPromise(
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

void test('short-circuits the first Policy denial, finalizes it, and never starts execution', async () => {
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

  const denial = await runEffectTestPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: action,
        transport: transport('policy-denied'),
      }),
    ),
  );

  assert.ok(Predicate.isTagged(denial, 'ActionPolicyDenied'));
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

void test('sanitizes Policy defects and interrupts without finalizing', async () => {
  const evaluators = [() => Effect.die('secret evaluator defect'), () => Effect.interrupt] as const;

  await forEachSequential(
    evaluators.map((evaluate, index) => [index, evaluate] as const),
    async ([index, evaluate]) => {
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
      const error = await runEffectTestPromise(
        Effect.flip(
          harness.runtime.runAction({
            payload: undefined,
            principal,
            registration: action,
            transport: transport(`policy-failure-${index}`),
          }),
        ),
      );

      assert.ok(Predicate.isTagged(error, 'ActionPolicyEvaluationError'));
      assert.equal(error.reason.includes('secret'), false);
      assert.equal(handlerExecutions, 0);
      assert.equal(harness.finalized.length, 0);
      assert.deepEqual(harness.counts(), {
        createCount: 1,
        lockCount: 0,
        transactionCount: 0,
        transitionCount: 0,
      });
    },
  );
});

void test('returns persistence failure when denial evidence cannot be finalized', async () => {
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

  const error = await runEffectTestPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport('policy-finalization-failure'),
      }),
    ),
  );

  assert.ok(Predicate.isTagged(error, 'ActionInvocationPersistenceError'));
  assert.equal(handlerExecutions, 0);
  assert.equal(harness.finalized.length, 0);
  assert.equal(harness.counts().transactionCount, 0);
});

void test('creates fresh collectors for every execution', async () => {
  const harness = makeHarness();
  await forEachSequential(
    [
      ['first', 1],
      ['second', 2],
    ] as const,
    async ([key, amount]) => {
      await runEffectTestPromise(
        harness.runtime.runAction({
          payload: { amount },
          principal,
          registration: registration(),
          transport: transport(key),
        }),
      );
    },
  );

  assert.equal(harness.flushed.length, 2);
  assert.deepEqual(
    harness.flushed.map((item) => item.evidence.domainEvents.length),
    [1, 1],
  );
  assert.notEqual(harness.flushed[0]?.evidence, harness.flushed[1]?.evidence);
});

void test('evaluates Policies afresh for separate invocations', async () => {
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
  await forEachSequential(['fresh-first', 'fresh-second'], async (key) => {
    const harness = makeHarness({
      createRecord: {
        actionInvocationId: key,
        completedAt: null,
        requestHash: '',
        status: 'received',
      },
    });
    await runEffectTestPromise(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: action,
        transport: transport(key),
      }),
    );
  });

  assert.equal(evaluations, 2);
});

void test('rejects structural payloads, trusted context, and missing idempotency before invocation', async () => {
  const harness = makeHarness();
  const invalidPayload = await runEffectTestPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 'not-a-number' },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    ),
  );
  const invalidPrincipal = await runEffectTestPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal: { ...principal, principalId: 'not-a-uuid' },
        registration: registration(),
        transport: transport(),
      }),
    ),
  );
  const missingKey = await runEffectTestPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: { correlationId: 'correlation-missing-key' },
      }),
    ),
  );
  const forgedSystemPrincipal = await runEffectTestPromise(
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

  assert.ok(Predicate.isTagged(invalidPayload, 'ActionPayloadValidationError'));
  assert.ok(Predicate.isTagged(invalidPrincipal, 'ActionTrustedContextValidationError'));
  assert.ok(Predicate.isTagged(missingKey, 'ActionIdempotencyKeyRequired'));
  assert.ok(Predicate.isTagged(forgedSystemPrincipal, 'ActionTrustedContextValidationError'));
  assert.equal(harness.counts().createCount, 0);
});

void test('preserves declared domain rejections and rolls back collected evidence', async () => {
  const DomainRejectedContract = Schema.TaggedStruct('DomainRejected', {
    reason: Schema.String,
  });
  type DomainRejectedSelf = typeof DomainRejectedContract.Type;
  const DomainRejected = Schema.TaggedError<DomainRejectedSelf>()('DomainRejected', {
    reason: Schema.String,
  });
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

  const error = await runEffectTestPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: undefined,
        principal,
        registration: rejected,
        transport: transport(),
      }),
    ),
  );

  assert.ok(Predicate.isTagged(error, 'DomainRejected'));
  assert.equal(error.reason, 'counter_locked');
  assert.equal(policyEvaluations, 1);
  assert.equal(harness.flushed.length, 0);
});

void test('sanitizes unexpected defects and rejects invalid typed results', async () => {
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
  const defect = await runEffectTestPromise(
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
  const resultError = await runEffectTestPromise(
    Effect.flip(
      resultHarness.runtime.runAction({
        payload: undefined,
        principal,
        registration: invalidResult,
        transport: transport(),
      }),
    ),
  );

  assert.ok(Predicate.isTagged(defect, 'ActionHandlerExecutionError'));
  assert.equal(defect.reason.includes('secret'), false);
  assert.ok(Predicate.isTagged(resultError, 'ActionResultValidationError'));
  assert.equal(defectHarness.flushed.length, 0);
  assert.equal(resultHarness.flushed.length, 0);
});

void test('sanitizes undeclared handler failures instead of widening the domain error contract', async () => {
  const DeclaredDomainErrorContract = Schema.TaggedStruct('DeclaredDomainError', {
    reason: Schema.String,
  });
  type DeclaredDomainErrorSelf = typeof DeclaredDomainErrorContract.Type;
  const DeclaredDomainError = Schema.TaggedError<DeclaredDomainErrorSelf>()('DeclaredDomainError', {
    reason: Schema.String,
  });
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
  const error = await runEffectTestPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport(),
      }),
    ),
  );

  assert.ok(Predicate.isTagged(error, 'ActionHandlerExecutionError'));
  assert.equal(error.reason.includes('secret'), false);
  assert.equal(harness.flushed.length, 0);
});

void test('handles committed, conflict, definite rollback, and indeterminate commit branches', async () => {
  const committed = makeHarness({
    createRecord: {
      actionInvocationId: 'committed',
      completedAt: null,
      requestHash: '',
      status: 'succeeded',
    },
  });
  const committedError = await runEffectTestPromise(
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
  const conflictError = await runEffectTestPromise(
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
  const definiteError = await runEffectTestPromise(
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
  const uncertainError = await runEffectTestPromise(
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
  const definiteCommitError = await runEffectTestPromise(
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
      return await runEffectTestPromise(
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

  assert.ok(Predicate.isTagged(committedError, 'ActionAlreadyCommitted'));
  assert.equal(committed.counts().transactionCount, 0);
  assert.equal(committed.permissionCounts().permissionCheckCount, 0);
  assert.ok(Predicate.isTagged(conflictError, 'ActionRequestHashConflict'));
  assert.equal(conflict.counts().transactionCount, 0);
  assert.equal(conflict.permissionCounts().permissionCheckCount, 0);
  assert.ok(Predicate.isTagged(definiteError, 'ActionTransactionError'));
  assert.ok(Predicate.isTagged(definiteCommitError, 'ActionTransactionError'));
  assert.ok(Predicate.isTagged(uncertainError, 'ActionCommitIndeterminate'));
  assert.equal(uncertain.flushed.length, 1);
  assert.equal(acknowledgementErrors.length, acknowledgementFailureCodes.length);
  for (const error of acknowledgementErrors) {
    assert.ok(Predicate.isTagged(error, 'ActionCommitIndeterminate'));
  }
});

void test('interruption during commit waits for native commit settlement', async () => {
  const commitStarted = Deferred.makeUnsafe<null>();
  const commitSettlement = Deferred.makeUnsafe<readonly object[]>();
  const harness = makeHarness({
    commit: Deferred.succeed(commitStarted, null).pipe(
      Effect.andThen(Deferred.await(commitSettlement)),
    ),
  });
  const { exit, pendingBeforeSettlement } = await runEffectTestPromise(
    Effect.gen(function* interruptCommittedAction() {
      const actionFiber = yield* harness.runtime
        .runAction({
          payload: { amount: 1 },
          principal,
          registration: registration(),
          transport: transport('interrupted-commit'),
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(commitStarted);
      const interruption = yield* Fiber.interrupt(actionFiber).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const pending = actionFiber.pollUnsafe() === undefined;
      yield* Deferred.succeed(commitSettlement, []);
      yield* Fiber.join(interruption);
      return { exit: yield* Fiber.await(actionFiber), pendingBeforeSettlement: pending };
    }),
  );
  assert.equal(pendingBeforeSettlement, true);
  assert.ok(Exit.isFailure(exit));
  assert.equal(Cause.hasInterrupts(exit.cause), true);
  assert.equal(harness.flushed.length, 1);
});

void test('resolves commit state explicitly and keeps unavailable outcomes indeterminate', async () => {
  const invocationId = '00000000-0000-4000-8000-000000000099';
  const open = makeHarness({
    createRecord: {
      actionInvocationId: invocationId,
      completedAt: null,
      requestHash: 'request',
      status: 'running',
    },
  });
  const openResolution = await runEffectTestPromise(
    open.runtime.resolveActionCommit({ invocationId, principal }),
  );

  const committed = makeHarness({
    createRecord: {
      actionInvocationId: invocationId,
      completedAt: completionTime(),
      requestHash: 'request',
      status: 'succeeded',
    },
  });
  const committedResolution = await runEffectTestPromise(
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
  const unavailableResolution = await runEffectTestPromise(
    Effect.flip(unavailable.runtime.resolveActionCommit({ invocationId, principal })),
  );

  assert.deepEqual(openResolution, {
    _tag: 'ActionCommitOpen',
    invocationId,
  });
  assert.ok(Predicate.isTagged(committedResolution, 'ActionAlreadyCommitted'));
  assert.ok(Predicate.isTagged(unavailableResolution, 'ActionCommitIndeterminate'));
  assert.equal(unavailableResolution.invocationId, invocationId);
});

void test('rejects terminal invocation states before handler execution', async () => {
  const terminal = makeHarness({
    createRecord: {
      actionInvocationId: 'terminal',
      completedAt: completionTime(),
      requestHash: '',
      status: 'failed',
    },
  });
  const error = await runEffectTestPromise(
    Effect.flip(
      terminal.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    ),
  );

  assert.ok(Predicate.isTagged(error, 'ActionInvocationStateError'));
  assert.equal(terminal.counts().transitionCount, 0);
  assert.equal(terminal.counts().transactionCount, 0);
});

void test('uses one runtime contract for Shell/Core and MicroVertical-shaped registrations', async () => {
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

  const shellResult = await runEffectTestPromise(
    shell.runtime.runAction({
      payload: { amount: 1 },
      principal,
      registration: registration(),
      transport: transport('shell'),
    }),
  );
  const moduleResult = await runEffectTestPromise(
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

void test('the Core database service identity remains server-only', () => {
  assert.equal(Predicate.isFunction(CoreDatabase), true);
});
