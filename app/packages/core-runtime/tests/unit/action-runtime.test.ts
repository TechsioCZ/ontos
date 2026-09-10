import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Option, Predicate, Schema, Struct } from 'effect';
import { expect, it } from 'effect-rstest';
import { ConnectionError, SqlError } from 'effect/unstable/sql/SqlError';
import {
  defineAction,
  defineActionBusinessPermission,
  defineActionResourcePermission,
  getActionHandler,
} from '../../src/actions/definition.ts';
import { commitActionThenReject } from '../../src/actions/context.ts';
import {
  ActionInvocationPersistenceError,
  ActionPermissionCheckError,
  ActionPermissionDenied,
  ActionTransactionError,
} from '../../src/actions/errors.ts';
import { defineGlobalPolicy, defineMicroverticalPolicy, denyPolicy } from '../../src/actions/policy.ts';
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
import {
  allowOwnerAuthorizationOverlay,
  type OwnerAuthorizationOverlayService,
} from '../../src/permissions/owner-authorization-overlay.ts';
import type { PrincipalManagementRepositoryService } from '../../src/auth/principal-management.ts';
import { PrincipalManagementRepository } from '../../src/auth/principal-management.ts';
import { supportRecoveryPrincipalContextResolverFromRepository } from '../../src/auth/support-recovery-principal-context.ts';
import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { recordSupportImpersonationAction } from '../../src/modules/actions/record-support-impersonation.action.ts';
import { makeModuleEntrypointGateway } from '../../src/modules/module-entrypoint-gateway.ts';
import type { ModuleEntrypointDescriptor } from '../../src/modules/module-entrypoint.ts';
import { defineSystemModuleEntrypoint, defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import {
  ModuleStateCheckUnavailableError,
  ModuleStateDeniedError,
} from '../../src/modules/module-state-gate-errors.ts';
import { checkModuleEntrypoint, makeModuleStateSnapshot } from '../../src/modules/module-state-gate.ts';
import type { TenantModuleState } from '../../src/modules/tenant-module-state-service.ts';
import type { ActionPermissionDecision, CheckActionPermissionInput } from '../../src/permissions/service.ts';
import { BusinessPermissionCodeSchema } from '../../src/permissions/business-permission.ts';
import { toBusinessPermissionAccessKey } from '../../src/permissions/context-access.ts';
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
const RetailProfileIdSchema = Schema.String.pipe(Schema.brand('RetailProfileId'));
type RetailProfileId = typeof RetailProfileIdSchema.Type;
type RetainedCauseError = ActionTransactionError | ActionInvocationPersistenceError;

const expectSameJson = (actual: RetainedCauseError, expected: RetainedCauseError) => {
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
};

const completionTime = () => DateTime.toDateUtc(DateTime.makeUnsafe(0));

const forEachSequential = <Item, E, R>(items: readonly Item[], run: (item: Item) => Effect.Effect<void, E, R>) =>
  Effect.forEach(items, run, { discard: true });

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

const PermissionDecisionSchema = Schema.Literals(['allowed', 'denied', 'unavailable']);
type PermissionDecision = typeof PermissionDecisionSchema.Type;

interface HarnessOptions {
  readonly businessPermissionDecision?: PermissionDecision;
  readonly commit?: Effect.Effect<readonly object[], SqlError>;
  readonly commitFailureCode?: string;
  readonly createRecord?: ActionInvocationRecord;
  readonly legalEntityPermissionDecision?: PermissionDecision;
  readonly lockedModuleState?: 'active' | 'denied' | 'unavailable';
  readonly moduleState?: TenantModuleState | 'missing' | 'unavailable';
  readonly onBusinessPermissionCheck?: () => void;
  readonly onResourcePermissionCheck?: () => void;
  readonly omitOwnerAuthorizationOverlay?: boolean;
  readonly ownerAuthorizationOverlay?: OwnerAuthorizationOverlayService;
  readonly permissionDecision?: ActionPermissionDecision;
  readonly permissionFailure?: boolean;
  readonly policyFinalizationFailure?: boolean;
  readonly rejectionFailure?: boolean;
  readonly resolutionUnavailable?: boolean;
  readonly resourcePermissionDecision?: PermissionDecision;
  readonly tenantPermissionDecision?: PermissionDecision;
  readonly transactionMode?: 'commit-definite' | 'definite-failure' | 'normal' | 'uncertain';
}

const makeHarness = Effect.fn(function* makeHarness(options: HarnessOptions = {}) {
  const finalized: FinalizeActionPolicyDenialInput[] = [];
  const flushed: FlushActionSuccessInput[] = [];
  const businessPermissionChecks: unknown[] = [];
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
  let committedTransactionCount = 0;
  let rolledBackTransactionCount = 0;
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
  const commitTransaction = () =>
    Effect.gen(function* commitTransactionEffect() {
      const defaultCommitCodes = {
        'commit-definite': '40001',
        uncertain: '08007',
      };
      const defaultCode =
        options.transactionMode === 'uncertain' || options.transactionMode === 'commit-definite'
          ? defaultCommitCodes[options.transactionMode]
          : undefined;
      const code = options.commitFailureCode ?? defaultCode;
      if (code !== undefined) {
        return yield* new SqlError({
          reason: new ConnectionError({ cause: { code } }),
        });
      }
      if (options.commit !== undefined) {
        return yield* options.commit;
      }
      return [];
    });
  const query = Effect.fn(function* executeQuery(statement: string, values: readonly unknown[]) {
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
          reason: new ConnectionError({
            cause: new Error('transaction unavailable'),
          }),
        });
      }
    }
    if (text === 'commit') {
      const committed = yield* commitTransaction();
      committedTransactionCount += 1;
      return committed;
    }
    if (text === 'rollback') {
      rolledBackTransactionCount += 1;
      return [];
    }
    if (text.includes('current_setting')) {
      return [
        {
          legal_entity_id: installedLegalEntityId,
          tenant_id: installedTenantId,
        },
      ];
    }
    if (text.startsWith('select')) {
      return [{ authBindingId: principal.authBindingId }];
    }
    return [];
  });
  const database = { executor: yield* makeTestDatabase(query) };

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
        options.moduleState === undefined || options.moduleState === 'missing' ? 'active' : options.moduleState;
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
  const ownerAuthorizationOptions =
    options.omitOwnerAuthorizationOverlay === true
      ? {}
      : {
          ownerAuthorizationOverlay:
            options.ownerAuthorizationOverlay ?? allowOwnerAuthorizationOverlay,
        };
  const runtime = makeActionRuntime(
    database,
    repository,
    permission,
    testOperationalScopeResolver,
    {
      contextAccess: {
        businessPermissions: (input) => {
          options.onBusinessPermissionCheck?.();
          businessPermissionChecks.push(input);
          return Effect.succeed(
            input.targets.map((target) => ({
              decision: options.businessPermissionDecision ?? ('allowed' as const),
              key: toBusinessPermissionAccessKey(target),
            })),
          );
        },
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
          options.onResourcePermissionCheck?.();
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
      ...ownerAuthorizationOptions,
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
    businessPermissionChecks,
    counts: () => ({
      createCount,
      lockCount,
      transactionCount,
      transitionCount,
    }),
    finalized,
    flushed,
    gateCounts: () => ({
      handlerResolutionCount,
      moduleStateReadCount,
      moduleStateRecheckCount,
    }),
    legalEntityChecks,
    permissionChecks,
    permissionCounts: () => ({ permissionCheckCount, rejectionCount }),
    rejections,
    requestHashes,
    resourceChecks,
    runtime,
    stages,
    tenantChecks,
    transactionOutcomes: () => ({
      committedTransactionCount,
      rolledBackTransactionCount,
    }),
  };
});

const makeRepositoryFailures = Effect.fn(function* testProgram1() {
  const cause = new SqlError({
    reason: new ConnectionError({
      cause: new Error('private repository defect'),
    }),
  });
  const executor = yield* makeTestDatabase(() => Effect.fail(cause));
  const repository = makeActionRepository();
  const input = {
    actionInvocationId: 'invocation-1',
    actionKey: 'shell.counter.denied',
    auditProfile: 'sensitive',
    principal,
    transport: transport('denied'),
  } as const;
  const transactionFailure = yield* Effect.flip(repository.rejectPermissionDenied(executor, input));
  const persistenceFailure = yield* Effect.flip(
    repository.finalizePolicyDenial(executor, {
      ...input,
      policy: { policyKey: 'global.counter-locked.v1', scope: 'global' },
      reasonCode: 'counter_locked',
    }),
  );
  expect(Schema.is(ActionTransactionError)(transactionFailure)).toBe(true);
  if (!Schema.is(ActionTransactionError)(transactionFailure)) {
    throw new Error('Expected typed test outcome');
  }
  expect(Schema.is(ActionInvocationPersistenceError)(persistenceFailure)).toBe(true);
  if (!Schema.is(ActionInvocationPersistenceError)(persistenceFailure)) {
    throw new Error('Expected typed test outcome');
  }
  return { cause, persistenceFailure, transactionFailure };
});

it.effect(
  'repository constructors retain original causes across Effect Cause propagation',
  Effect.fn(function* testProgram2() {
    const { cause, persistenceFailure, transactionFailure } = yield* makeRepositoryFailures();
    const propagatedTransaction = yield* Effect.flip(Effect.failCause(Cause.fail(transactionFailure)));
    const propagatedPersistence = yield* Effect.flip(Effect.failCause(Cause.fail(persistenceFailure)));
    expect(propagatedTransaction).toBe(transactionFailure);
    expect(propagatedPersistence).toBe(persistenceFailure);
    expect(getActionTransactionFailureCause(propagatedTransaction)).toEqual(Cause.die(cause));
    expect(getActionInvocationPersistenceFailureCause(propagatedPersistence)).toEqual(Cause.die(cause));
  }),
);

it('public error classes expose no retained-cause accessors', () => {
  for (const errorClass of [ActionTransactionError, ActionInvocationPersistenceError]) {
    expect('withCause' in errorClass).toBe(false);
    expect('causeOf' in errorClass).toBe(false);
  }
});

it.effect(
  'repository causes are absent from reflection, JSON, and Schema encoding',
  Effect.fn(function* testProgram3() {
    const { persistenceFailure, transactionFailure } = yield* makeRepositoryFailures();
    const publicTransaction = new ActionTransactionError({
      code: transactionFailure.code,
      reason: transactionFailure.reason,
    });
    const publicPersistence = new ActionInvocationPersistenceError({
      code: persistenceFailure.code,
      reason: persistenceFailure.reason,
    });
    expect(Object.keys(transactionFailure)).toEqual(Object.keys(publicTransaction));
    expect(Object.keys(persistenceFailure)).toEqual(Object.keys(publicPersistence));
    expect(Reflect.ownKeys(transactionFailure)).toEqual(Reflect.ownKeys(publicTransaction));
    expect(Reflect.ownKeys(persistenceFailure)).toEqual(Reflect.ownKeys(publicPersistence));
    expectSameJson(transactionFailure, publicTransaction);
    expectSameJson(persistenceFailure, publicPersistence);
    const encodedTransactionFailure = yield* Schema.encodeEffect(ActionTransactionError)(transactionFailure);
    expect(Schema.is(Schema.toEncoded(ActionTransactionError))(encodedTransactionFailure)).toBe(true);
    expect(Struct.omit(encodedTransactionFailure, ['_tag'])).toEqual({
      code: transactionFailure.code,
      reason: transactionFailure.reason,
    });
    const encodedPersistenceFailure = yield* Schema.encodeEffect(ActionInvocationPersistenceError)(persistenceFailure);
    expect(Schema.is(Schema.toEncoded(ActionInvocationPersistenceError))(encodedPersistenceFailure)).toBe(true);
    expect(Struct.omit(encodedPersistenceFailure, ['_tag'])).toEqual({
      code: persistenceFailure.code,
      reason: persistenceFailure.reason,
    });
  }),
);

it('repository cause readers reject foreign objects carrying the former cause property', () => {
  const formerCauseProperty = ['ontos', 'Repository', 'Failure', 'Cause'].join('');
  const cause = new Error('foreign defect');
  const transactionFailure = Object.assign(
    new ActionTransactionError({
      code: 'action_transaction_failed',
      reason: 'foreign failure',
    }),
    { [formerCauseProperty]: cause },
  );
  const persistenceFailure = Object.assign(
    new ActionInvocationPersistenceError({
      code: 'action_invocation_persistence_failed',
      reason: 'foreign failure',
    }),
    { [formerCauseProperty]: cause },
  );
  expect(getActionTransactionFailureCause(transactionFailure)).toBe(undefined);
  expect(getActionInvocationPersistenceFailureCause(persistenceFailure)).toBe(undefined);
});

const registration = () =>
  defineAction(
    {
      accessEvidencePolicy: {
        captureMode: 'metadata_only',
        policyKey: 'counter.read.v1',
      },
      actionKey: 'shell.counter.change',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {
        'counter.changed': Schema.Struct({ amount: Schema.Finite }),
      },
      entrypoint: defineSystemModuleEntrypoint({
        access: 'write',
        authorization: {
          kind: 'action_execution',
          provisioning: 'tenant_membership_default',
        },
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
    Effect.fn(function* changeCounter(payload, context) {
      expect(context.actionInvocationId).toBe('invocation-1');
      expect(Object.isFrozen(context)).toBe(true);
      expect('transaction' in context).toBe(false);
      expect(context.services).toEqual({});
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

it.effect(
  'executes the complete stage order with transaction ownership and success evidence',
  Effect.fn(function* testProgram4() {
    const harness = yield* makeHarness();
    const result = yield* harness.runtime.runAction({
      payload: { amount: 3 },
      principal,
      registration: registration(),
      transport: transport(),
    });

    expect(result).toEqual({ total: 3 });
    expect(harness.stages).toEqual(ACTION_RUNTIME_STAGES);
    expect(harness.counts()).toEqual({
      createCount: 1,
      lockCount: 1,
      transactionCount: 1,
      transitionCount: 1,
    });
    expect(harness.flushed.length).toBe(1);
    expect(harness.flushed[0]?.evidence.dataAccessEvents.length).toBe(1);
    expect(harness.flushed[0]?.evidence.domainEvents.length).toBe(1);
    expect(harness.flushed[0]?.evidence.outboxMessages.length).toBe(1);
    expect(harness.flushed[0]?.allowedPolicies).toEqual([]);
    expect(harness.permissionChecks).toEqual([
      {
        actionKey: 'shell.counter.change',
        correlationId: 'correlation-intent-1',
        principalId: principal.principalId,
      },
    ]);
    expect(harness.gateCounts()).toEqual({
      handlerResolutionCount: 1,
      moduleStateReadCount: 0,
      moduleStateRecheckCount: 0,
    });
  }),
);

it.effect(
  'runs the owner overlay inside the transaction and persists an owner denial before the handler',
  Effect.fn(function* testOwnerOverlayDenial() {
    const ownerInputs: unknown[] = [];
    const harness = yield* makeHarness({
      ownerAuthorizationOverlay: {
        authorize: (_transaction, input) => {
          ownerInputs.push(input);
          return Effect.succeed('denied' as const);
        },
      },
    });
    const failure = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 3 },
        principal,
        registration: registration(),
        transport: transport('owner-denied'),
      }),
    );

    expect(Schema.is(ActionPermissionDenied)(failure)).toBe(true);
    expect(ownerInputs).toHaveLength(1);
    expect(harness.gateCounts().handlerResolutionCount).toBe(0);
    expect(harness.counts()).toEqual({
      createCount: 1,
      lockCount: 1,
      transactionCount: 1,
      transitionCount: 0,
    });
    expect(harness.permissionCounts().rejectionCount).toBe(1);
  }),
);

it.effect('keeps owner-neutral Actions available without an owner adapter', () =>
  Effect.gen(function* ownerNeutralActionWithoutOverlay() {
    const harness = yield* makeHarness({ omitOwnerAuthorizationOverlay: true });
    const result = yield* harness.runtime.runAction({
      payload: { amount: 2 },
      principal,
      registration: registration(),
      transport: transport('owner-neutral-without-overlay'),
    });
    expect(result).toEqual({ total: 2 });
    expect(harness.rejections).toHaveLength(0);
  }),
);

it.effect(
  'hashes the encoded representation of decoded DateTime and Option values',
  Effect.fn(function* testProgram5() {
    const occurredAt = '2026-09-07T10:30:00.000Z';
    const payloadSchema = Schema.Struct({
      note: Schema.OptionFromNullOr(Schema.String),
      occurredAt: Schema.DateTimeUtcFromString,
    });
    const action = defineAction(
      {
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'shell.temporal.v1',
        },
        actionKey: 'shell.temporal.change',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
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
        expect(DateTime.formatIso(payload.occurredAt)).toBe(occurredAt);
        expect(Option.isNone(payload.note)).toBe(true);
        return Effect.succeed(payload);
      },
    );
    const harness = yield* makeHarness();

    const result = yield* harness.runtime.runAction({
      payload: { note: null, occurredAt },
      principal,
      registration: action,
      transport: transport('temporal-payload'),
    });

    expect(harness.requestHashes).toEqual([
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
    expect(DateTime.formatIso(result.occurredAt)).toBe(occurredAt);
    expect(Option.isNone(result.note)).toBe(true);
    expect(harness.flushed[0]?.resultHash).toBe(computeCanonicalValueHash({ note: null, occurredAt }));
  }),
);

it.effect(
  'uses a resolver-branded recovery only for the exact support-stop Action and still checks permission',
  Effect.fn(function* testProgram6() {
    const recoveryPrincipal = yield* supportRecoveryPrincipalContextResolverFromRepository({
      load: () =>
        Effect.succeedSome({
          bindingPrincipalId: principal.principalId,
          bindingTenantId: principal.tenantId,
          principalKind: 'human' as const,
          principalTenantId: principal.tenantId,
          tenantId: principal.tenantId,
        }),
    }).resolveStoppedImpersonation({
      originalAuthBindingId: principal.authBindingId,
      originalPrincipalId: principal.principalId,
      originalSessionId: 'expired-original-session',
      tenantId: principal.tenantId,
    });
    const harness = yield* makeHarness({
      permissionDecision: 'allowed',
      tenantPermissionDecision: 'denied',
    });

    const result = yield* harness.runtime
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
      .pipe(providePrincipalManagementRepository);

    expect(result).toEqual({ checkpoint: 'stopped', recorded: true });
    expect(harness.permissionCounts()).toEqual({
      permissionCheckCount: 1,
      rejectionCount: 0,
    });

    const deniedHarness = yield* makeHarness({ permissionDecision: 'denied' });
    const denied = yield* Effect.flip(
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
    );
    expect(Predicate.isTagged(denied, 'ActionPermissionDenied')).toBe(true);

    expect(deniedHarness.permissionCounts()).toEqual({
      permissionCheckCount: 1,
      rejectionCount: 1,
    });

    const wrongCheckpoint = yield* Effect.flip(
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
    );
    expect(Predicate.isTagged(wrongCheckpoint, 'ActionTrustedContextValidationError')).toBe(true);

    const wrongAction = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal: recoveryPrincipal,
        registration: registration(),
        transport: transport('support-recovery-wrong-action'),
      }),
    );
    expect(Predicate.isTagged(wrongAction, 'ActionTrustedContextValidationError')).toBe(true);
  }),
);

it.effect(
  'fails business Actions closed before invocation, permission, Policy, or handler access',
  Effect.fn(function* testProgram7() {
    yield* forEachSequential(
      (['inactive', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived', 'missing'] as const).map(
        (state, index) => [index, state] as const,
      ),
      Effect.fn(function* testProgram8([index, state]) {
        let handlerCalls = 0;
        let policyCalls = 0;
        const harness = yield* makeHarness({ moduleState: state });
        const action = defineAction(
          {
            accessEvidencePolicy: {
              captureMode: 'metadata_only',
              policyKey: 'stock.read.v1',
            },
            actionKey: `inventory.stock.reserve-state-${index}`,
            auditProfile: 'standard',
            domainErrorSchema: Schema.Never,
            domainEvents: {},
            entrypoint: defineTenantModuleEntrypoint({
              access: 'write',
              authorization: {
                kind: 'action_execution',
                provisioning: 'tenant_membership_default',
              },
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
        const failure = yield* Effect.flip(
          harness.runtime.runAction({
            payload: undefined,
            principal,
            registration: action,
            transport: transport(`state-${state}`),
          }),
        );
        expect(Predicate.isTagged(failure, 'ModuleStateDeniedError'), state).toBe(true);

        expect(handlerCalls).toBe(0);
        expect(policyCalls).toBe(0);
        expect(harness.counts()).toEqual({
          createCount: 0,
          lockCount: 0,
          transactionCount: 0,
          transitionCount: 0,
        });
        expect(harness.permissionCounts()).toEqual({
          permissionCheckCount: 0,
          rejectionCount: 0,
        });
        expect(harness.gateCounts()).toEqual({
          handlerResolutionCount: 0,
          moduleStateReadCount: 1,
          moduleStateRecheckCount: 0,
        });
      }),
    );
  }),
);

it.effect(
  'distinguishes unavailable early checks and rolls back a denied locked recheck',
  Effect.fn(function* testProgram9() {
    const action = defineAction(
      {
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'stock.read.v1',
        },
        actionKey: 'inventory.stock.reserve-locked',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
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

    const unavailable = yield* makeHarness({ moduleState: 'unavailable' });
    const unavailableFailure = yield* Effect.flip(
      unavailable.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport('state-unavailable'),
      }),
    );
    expect(Predicate.isTagged(unavailableFailure, 'ModuleStateCheckUnavailableError')).toBe(true);

    expect(unavailable.counts().createCount).toBe(0);

    const locked = yield* makeHarness({ lockedModuleState: 'denied' });
    const lockedFailure = yield* Effect.flip(
      locked.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport('state-locked-denied'),
      }),
    );
    expect(Predicate.isTagged(lockedFailure, 'ModuleStateDeniedError')).toBe(true);

    expect(locked.gateCounts()).toEqual({
      handlerResolutionCount: 0,
      moduleStateReadCount: 1,
      moduleStateRecheckCount: 1,
    });
    expect(locked.counts()).toEqual({
      createCount: 1,
      lockCount: 1,
      transactionCount: 1,
      transitionCount: 0,
    });
  }),
);

it.effect(
  'allows an explicitly authorized Action before Policy evaluation',
  Effect.fn(function* testProgram10() {
    const harness = yield* makeHarness({ permissionDecision: 'allowed' });
    const result = yield* harness.runtime.runAction({
      payload: { amount: 2 },
      principal,
      registration: registration(),
      transport: transport('allowed'),
    });

    expect(result).toEqual({ total: 2 });
    expect(harness.stages.indexOf('permission_checked') < harness.stages.indexOf('policy_boundary')).toBe(true);
    expect(harness.counts().transitionCount).toBe(1);
    expect(harness.counts().transactionCount).toBe(1);
  }),
);

it.effect(
  'requires a declared tenant role independently from the Action executor relation',
  Effect.fn(function* testProgram11() {
    const tenantAuthorizedRegistration = defineAction(
      {
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'identity.read.v1',
        },
        actionKey: 'core.identity.tenant-authorized',
        auditProfile: 'sensitive',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
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

    yield* forEachSequential(
      [
        ['denied', 'ActionPermissionDenied'],
        ['unavailable', 'ActionPermissionCheckError'],
      ] as const,
      Effect.fn(function* testProgram12([decision, expectedTag]) {
        const harness = yield* makeHarness({
          permissionDecision: 'allowed',
          tenantPermissionDecision: decision,
        });
        const failure = yield* Effect.flip(
          harness.runtime.runAction({
            payload: undefined,
            principal,
            registration: tenantAuthorizedRegistration,
            transport: transport(`tenant-${decision}`),
          }),
        );
        expect(Predicate.isTagged(failure, expectedTag)).toBe(true);

        expect(harness.counts().transitionCount).toBe(0);
      }),
    );

    const allowed = yield* makeHarness({
      permissionDecision: 'allowed',
      tenantPermissionDecision: 'allowed',
    });
    yield* allowed.runtime.runAction({
      payload: undefined,
      principal,
      registration: tenantAuthorizedRegistration,
      transport: transport('tenant-allowed'),
    });
    expect(allowed.counts().transitionCount).toBe(1);
  }),
);

it.effect(
  'accepts every Party write authority as an explicit tenant permission',
  Effect.fn(function* testProgram13() {
    const partyPermissions = [
      'manage_party_identity',
      'manage_party_relationships',
      'merge_party_identity',
      'review_party_identity',
    ] as const;
    yield* forEachSequential(
      partyPermissions.map((permission, index) => [index, permission] as const),
      Effect.fn(function* testProgram14([index, permission]) {
        const actionKey = `party.registry.permission-${index}`;
        const action = defineAction(
          {
            accessEvidencePolicy: {
              captureMode: 'metadata_only',
              policyKey: 'party.read.v1',
            },
            actionKey,
            auditProfile: 'sensitive',
            domainErrorSchema: Schema.Never,
            domainEvents: {},
            entrypoint: defineTenantModuleEntrypoint({
              access: 'write',
              authorization: {
                kind: 'action_execution',
                provisioning: 'tenant_membership_default',
              },
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
        const harness = yield* makeHarness();
        yield* harness.runtime.runAction({
          payload: undefined,
          principal,
          registration: action,
          transport: transport(permission),
        });
        expect(harness.tenantChecks).toEqual([
          {
            permission,
            principalId: principal.principalId,
            tenantIds: [principal.tenantId],
          },
        ]);
        expect(harness.flushed[0]?.transport).toEqual({
          correlationId: `correlation-${permission}`,
          idempotencyKey: permission,
        });
      }),
    );
  }),
);

it.effect(
  'canonicalizes every resolved tenant permission target for hash and evidence',
  Effect.fn(function* testProgram15() {
    const action = defineAction(
      {
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'identity.read.v1',
        },
        actionKey: 'core.identity.rotate-managed-key',
        auditProfile: 'sensitive',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
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
    const first = yield* makeHarness();
    const second = yield* makeHarness();
    yield* first.runtime.runAction({
      payload: undefined,
      principal,
      registration: action,
      transport: {
        ...transport('same-idempotency-key'),
        targetModuleKey: 'forged.one',
        targetResourceId: 'forged-one',
        targetResourceType: 'first',
      },
    });
    yield* second.runtime.runAction({
      payload: undefined,
      principal,
      registration: action,
      transport: {
        ...transport('same-idempotency-key'),
        targetModuleKey: 'forged.two',
        targetResourceId: 'forged-two',
        targetResourceType: 'second',
      },
    });

    expect(first.requestHashes).toEqual(second.requestHashes);
    expect(first.flushed[0]?.transport).toEqual({
      correlationId: 'correlation-same-idempotency-key',
      idempotencyKey: 'same-idempotency-key',
    });
    expect(second.flushed[0]?.transport).toEqual(first.flushed[0]?.transport);
  }),
);

it.effect(
  'authorizes Counterparty creation against the trusted Legal Entity before Policy and transaction',
  Effect.fn(function* testProgram16() {
    let handlerCalls = 0;
    let policyCalls = 0;
    const action = defineAction(
      {
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counterparty.read.v1',
        },
        actionKey: 'party.registry.create-counterparty',
        auditProfile: 'sensitive',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
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
              expect(input.target).toEqual({});
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

    const denied = yield* makeHarness({
      legalEntityPermissionDecision: 'denied',
    });
    const failure = yield* Effect.flip(
      denied.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: forgedTransport,
      }),
    );
    expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);

    expect(policyCalls).toBe(0);
    expect(handlerCalls).toBe(0);
    expect(denied.counts().transactionCount).toBe(0);
    expect(denied.legalEntityChecks).toEqual([
      {
        legalEntityIds: [principal.legalEntityId],
        permission: 'manage_counterparty',
        principalId: principal.principalId,
        tenantId: principal.tenantId,
      },
    ]);
    expect(denied.rejections[0]?.transport).toEqual({
      correlationId: 'correlation-legal-entity-denied',
      idempotencyKey: 'legal-entity-denied',
    });
    expect(denied.stages.at(-1)).toBe('permission_checked');

    const unavailable = yield* makeHarness({
      legalEntityPermissionDecision: 'unavailable',
    });
    const unavailableFailure = yield* Effect.flip(
      unavailable.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: forgedTransport,
      }),
    );
    expect(Predicate.isTagged(unavailableFailure, 'ActionPermissionCheckError')).toBe(true);

    expect(unavailable.rejections.length).toBe(0);
    expect(unavailable.counts().transactionCount).toBe(0);
    expect(unavailable.stages.includes('permission_checked')).toBe(false);

    const allowed = yield* makeHarness();
    yield* allowed.runtime.runAction({
      payload: undefined,
      principal,
      registration: action,
      transport: {
        ...forgedTransport,
        idempotencyKey: 'legal-entity-allowed',
      },
    });
    expect(policyCalls).toBe(1);
    expect(handlerCalls).toBe(1);
    expect(allowed.flushed[0]?.transport).toEqual({
      correlationId: 'correlation-legal-entity-denied',
      idempotencyKey: 'legal-entity-allowed',
    });
    expect(allowed.stages.indexOf('permission_checked') < allowed.stages.indexOf('policy_boundary')).toBe(true);
  }),
);

it.effect(
  'authorizes the resolved Resource target before Policy, transaction, and handler',
  Effect.fn(function* testProgram17() {
    let handlerCalls = 0;
    let policyCalls = 0;
    const action = defineAction(
      {
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counterparty.read.v1',
        },
        actionKey: 'party.registry.end-counterparty-role',
        auditProfile: 'sensitive',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
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
              expect(input.target).toEqual({
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
          expect(scope.legalEntityId).toBe(principal.legalEntityId);
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

    const denied = yield* makeHarness({ resourcePermissionDecision: 'denied' });
    const failure = yield* Effect.flip(
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
    );

    expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);

    expect(policyCalls).toBe(0);
    expect(handlerCalls).toBe(0);
    expect(denied.counts().transactionCount).toBe(0);
    expect(denied.resourceChecks).toEqual([
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
    expect(denied.rejections[0]?.transport).toEqual({
      correlationId: 'correlation-resource-denied',
      idempotencyKey: 'resource-denied',
      targetModuleKey: 'party.registry',
      targetResourceId: 'counterparty-1',
      targetResourceType: 'counterparty',
    });

    const unavailable = yield* makeHarness({
      resourcePermissionDecision: 'unavailable',
    });
    const unavailableFailure = yield* Effect.flip(
      unavailable.runtime.runAction({
        payload: { counterpartyId: 'counterparty-1' },
        principal,
        registration: action,
        transport: transport('resource-unavailable'),
      }),
    );
    expect(Predicate.isTagged(unavailableFailure, 'ActionPermissionCheckError')).toBe(true);

    expect(unavailable.rejections.length).toBe(0);
    expect(unavailable.counts().transactionCount).toBe(0);
  }),
);

it.effect(
  'enforces conjunctive business and Resource permissions before Policy and handler execution',
  Effect.fn(function* testConjunctiveBusinessAndResourcePermissions() {
    const observed: string[] = [];
    let handlerCalls = 0;
    let policyCalls = 0;
    const permission = yield* Schema.decodeUnknownEffect(BusinessPermissionCodeSchema)(
      'retail.settings.payment_term_preference.manage',
    );
    const action = defineAction(
      {
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'retail-profile.write.v1',
        },
        actionKey: 'commerce.customer-context.change-payment-term',
        auditProfile: 'sensitive',
        businessPermission: defineActionBusinessPermission<{ readonly profileId: RetailProfileId }>(
          ({ profileId }, scope) => ({
            permission,
            target: {
              kind: 'retail_profile',
              legalEntityId: scope.legalEntityId ?? '',
              profileId,
              tenantId: scope.tenantId,
            },
          }),
        ),
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'commerce.customer-context.change-payment-term',
          moduleKey: 'commerce.customer-context',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'required',
        owningModuleKey: 'commerce.customer-context',
        payloadSchema: Schema.Struct({ profileId: RetailProfileIdSchema }),
        policies: [
          defineGlobalPolicy({
            evaluate: () => {
              policyCalls += 1;
              observed.push('policy');
              return Effect.void;
            },
            policyKey: 'global.retail-profile-write.v1',
          }),
        ],
        resourcePermission: defineActionResourcePermission<{
          readonly profileId: RetailProfileId;
        }>(({ profileId }) => ({
          permission: 'write',
          resource: {
            moduleId: 'commerce.customer-context',
            resourceId: profileId,
            resourceType: 'retail-profile',
          },
        })),
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => {
        observed.push('handler');
        handlerCalls += 1;
        return Effect.void;
      },
    );
    const run = (harness: Effect.Success<ReturnType<typeof makeHarness>>, idempotencyKey: string) =>
      harness.runtime.runAction({
        payload: { profileId: 'profile-1' },
        principal,
        registration: action,
        transport: transport(idempotencyKey),
      });

    const allowed = yield* makeHarness({
      onBusinessPermissionCheck: () => {
        observed.push('business_permission');
      },
      onResourcePermissionCheck: () => {
        observed.push('resource_permission');
      },
    });
    yield* run(allowed, 'conjunctive-allowed');
    expect(observed).toEqual(['resource_permission', 'business_permission', 'policy', 'handler']);
    expect(handlerCalls).toBe(1);
    expect(policyCalls).toBe(1);

    const ownerMissing = yield* makeHarness({
      businessPermissionDecision: 'allowed',
      omitOwnerAuthorizationOverlay: true,
      resourcePermissionDecision: 'allowed',
    });
    const ownerMissingFailure = yield* Effect.flip(run(ownerMissing, 'owner-overlay-missing'));
    expect(Predicate.isTagged(ownerMissingFailure, 'ActionPermissionCheckError')).toBe(true);
    expect(ownerMissing.rejections).toHaveLength(0);
    expect(ownerMissing.counts().transactionCount).toBe(1);
    expect(handlerCalls).toBe(1);

    const resourceDenied = yield* makeHarness({ resourcePermissionDecision: 'denied' });
    const resourceDeniedFailure = yield* Effect.flip(run(resourceDenied, 'resource-denied'));
    expect(Predicate.isTagged(resourceDeniedFailure, 'ActionPermissionDenied')).toBe(true);
    expect(resourceDenied.resourceChecks).toHaveLength(1);
    expect(resourceDenied.businessPermissionChecks).toHaveLength(1);

    const businessDenied = yield* makeHarness({ businessPermissionDecision: 'denied' });
    const businessDeniedFailure = yield* Effect.flip(run(businessDenied, 'business-denied'));
    expect(Predicate.isTagged(businessDeniedFailure, 'ActionPermissionDenied')).toBe(true);
    expect(businessDenied.resourceChecks).toHaveLength(1);
    expect(businessDenied.businessPermissionChecks).toHaveLength(1);

    const resourceUnavailable = yield* makeHarness({ resourcePermissionDecision: 'unavailable' });
    const resourceUnavailableFailure = yield* Effect.flip(
      run(resourceUnavailable, 'resource-unavailable'),
    );
    expect(Predicate.isTagged(resourceUnavailableFailure, 'ActionPermissionCheckError')).toBe(true);

    const businessUnavailable = yield* makeHarness({ businessPermissionDecision: 'unavailable' });
    const businessUnavailableFailure = yield* Effect.flip(
      run(businessUnavailable, 'business-unavailable'),
    );
    expect(Predicate.isTagged(businessUnavailableFailure, 'ActionPermissionCheckError')).toBe(true);
    expect(businessUnavailable.resourceChecks).toHaveLength(1);
    expect(businessUnavailable.businessPermissionChecks).toHaveLength(1);

    expect(handlerCalls).toBe(1);
    expect(policyCalls).toBe(2);
  }),
);

it.effect(
  'accepts Storefront business targets only from exact gateway-verified scope',
  Effect.fn(function* testTrustedStorefrontBusinessPermission() {
    const permission = yield* Schema.decodeUnknownEffect(BusinessPermissionCodeSchema)(
      'counterparty.purchase.submit',
    );
    const StorefrontIdSchema = Schema.String.pipe(Schema.brand('StorefrontId'));
    let handlerCalls = 0;
    const action = defineAction(
      {
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counterparty-storefront.write.v1',
        },
        actionKey: 'commerce.customer-context.storefront-command',
        auditProfile: 'sensitive',
        businessPermission: defineActionBusinessPermission<{
          readonly counterpartyId: CounterpartyId;
          readonly storefrontId: string;
        }>(({ counterpartyId, storefrontId }, scope) => ({
          permission,
          target: {
            counterpartyId,
            kind: 'counterparty_storefront',
            legalEntityId: scope.legalEntityId ?? '',
            storefrontId,
            tenantId: scope.tenantId,
          },
          // Deliberately mirrors untrusted payload to prove Core does not accept self-promotion.
          trustedStorefrontId: storefrontId,
        })),
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'commerce.customer-context.storefront-command',
          moduleKey: 'commerce.customer-context',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'required',
        owningModuleKey: 'commerce.customer-context',
        payloadSchema: Schema.Struct({
          counterpartyId: CounterpartyIdSchema,
          storefrontId: StorefrontIdSchema,
        }),
        policies: [],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => {
        handlerCalls += 1;
        return Effect.void;
      },
    );
    const run = (storefrontPrincipal: typeof principal, storefrontId: string, key: string) =>
      Effect.gen(function* runStorefrontAction() {
        const harness = yield* makeHarness();
        const result = yield* Effect.exit(
          harness.runtime.runAction({
            payload: { counterpartyId: 'counterparty-1', storefrontId },
            principal: storefrontPrincipal,
            registration: action,
            transport: transport(key),
          }),
        );
        return { harness, result };
      });

    const untrusted = yield* run(principal, 'storefront-a', 'storefront-untrusted');
    expect(Exit.isFailure(untrusted.result)).toBe(true);
    expect(untrusted.harness.businessPermissionChecks).toHaveLength(0);

    const trusted = trustVerifiedGatewayPrincipalContext({
      ...principal,
      trustedStorefrontId: 'storefront-a',
    });
    const mismatch = yield* run(trusted, 'storefront-b', 'storefront-mismatch');
    expect(Exit.isFailure(mismatch.result)).toBe(true);
    expect(mismatch.harness.businessPermissionChecks).toHaveLength(0);

    const allowed = yield* run(trusted, 'storefront-a', 'storefront-allowed');
    expect(Exit.isSuccess(allowed.result)).toBe(true);
    expect(allowed.harness.businessPermissionChecks).toEqual([
      {
        principal: { principalId: principal.principalId, tenantId: principal.tenantId },
        targets: [
          {
            permission,
            target: {
              counterpartyId: 'counterparty-1',
              kind: 'counterparty_storefront',
              legalEntityId: principal.legalEntityId,
              storefrontId: 'storefront-a',
              tenantId: principal.tenantId,
            },
          },
        ],
        trustedStorefrontId: 'storefront-a',
      },
    ]);
    expect(handlerCalls).toBe(1);
  }),
);

it.effect(
  'persists a definite permission denial before returning it and never evaluates Policies',
  Effect.fn(function* testProgram18() {
    let handlerCount = 0;
    let policyCount = 0;
    let serviceFactoryCount = 0;
    const harness = yield* makeHarness({ permissionDecision: 'denied' });
    const deniedRegistration = defineAction(
      {
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counter.read.v1',
        },
        actionKey: 'shell.counter.denied',
        auditProfile: 'sensitive',
        deniedAuditEvidence: {
          resolve: () => ({
            operation: 'grant',
            recipient: '00000000-0000-4000-8000-000000000003',
            requestedScope: { kind: 'counterparty' },
          }),
          schema: Schema.Struct({
            operation: Schema.Literal('grant'),
            recipient: Schema.String,
            requestedScope: Schema.Struct({ kind: Schema.Literal('counterparty') }),
          }),
        },
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
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

    const failure = yield* Effect.flip(
      harness.runtime.runAction({
        payload: undefined,
        principal,
        registration: deniedRegistration,
        transport: transport('denied'),
      }),
    );

    expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);

    expect(failure.code).toBe('action_permission_denied');
    expect(handlerCount).toBe(0);
    expect(policyCount).toBe(0);
    expect(serviceFactoryCount).toBe(0);
    expect(harness.stages).toEqual([
      'payload_decoded',
      'trusted_context_validated',
      'module_state_gate',
      'invocation_prepared',
      'authentication_boundary',
      'permission_checked',
    ]);
    expect(harness.permissionCounts()).toEqual({
      permissionCheckCount: 1,
      rejectionCount: 1,
    });
    expect(harness.counts()).toEqual({
      createCount: 1,
      lockCount: 0,
      transactionCount: 0,
      transitionCount: 0,
    });
    expect(harness.rejections).toEqual([
      {
        actionInvocationId: 'invocation-1',
        actionKey: 'shell.counter.denied',
        auditProfile: 'sensitive',
        deniedAuditEvidence: {
          operation: 'grant',
          recipient: '00000000-0000-4000-8000-000000000003',
          requestedScope: { kind: 'counterparty' },
        },
        principal,
        transport: transport('denied'),
      },
    ]);
  }),
);

it.effect(
  'fails closed before Policy evaluation when permission cannot be determined',
  Effect.fn(function* testProgram19() {
    const harness = yield* makeHarness({ permissionFailure: true });
    const failure = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('unavailable'),
      }),
    );

    expect(Predicate.isTagged(failure, 'ActionPermissionCheckError')).toBe(true);

    expect(harness.permissionCounts()).toEqual({
      permissionCheckCount: 1,
      rejectionCount: 0,
    });
    expect(harness.counts()).toEqual({
      createCount: 1,
      lockCount: 0,
      transactionCount: 0,
      transitionCount: 0,
    });
    expect(harness.stages).toEqual([
      'payload_decoded',
      'trusted_context_validated',
      'module_state_gate',
      'invocation_prepared',
      'authentication_boundary',
    ]);
  }),
);

it.effect(
  'does not claim permission denial when terminal evidence persistence rolls back',
  Effect.fn(function* testProgram20() {
    const harness = yield* makeHarness({
      permissionDecision: 'denied',
      rejectionFailure: true,
    });
    const failure = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('permission-denial-persistence-failure'),
      }),
    );

    expect(Predicate.isTagged(failure, 'ActionTransactionError')).toBe(true);

    expect(harness.permissionCounts()).toEqual({
      permissionCheckCount: 1,
      rejectionCount: 1,
    });
    expect(harness.counts().transitionCount).toBe(0);
    expect(harness.counts().transactionCount).toBe(0);
  }),
);

it.effect(
  'evaluates Policies in order before running and hands allowed checkpoints to success',
  Effect.fn(function* testProgram21() {
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
        expect(input.principal.principalId).toBe(principal.principalId);
        expect(input.action.actionKey).toBe('inventory.stock.policy-allowed');
        expect(input.target.targetResourceId).toBe('primary');
        expect('idempotencyKey' in input.transport).toBe(false);
        return Effect.void;
      },
      owningModuleKey: 'inventory.stock',
      policyKey: 'inventory.stock.allowed.v1',
    });
    const action = defineAction(
      {
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counter.read.v1',
        },
        actionKey: 'inventory.stock.policy-allowed',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
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
    const harness = yield* makeHarness();

    const result = yield* harness.runtime.runAction({
      payload: { amount: 4 },
      principal,
      registration: action,
      transport: { ...transport(), targetModuleKey: 'inventory.stock' },
    });

    expect(result).toBe(4);
    expect(observed).toEqual(['global', 'module:4', 'handler']);
    expect(harness.flushed[0]?.allowedPolicies).toEqual([
      { policyKey: 'global.tenant-active.v1', scope: 'global' },
      {
        owningModuleKey: 'inventory.stock',
        policyKey: 'inventory.stock.allowed.v1',
        scope: 'microvertical',
      },
    ]);
  }),
);

it.effect(
  'short-circuits the first Policy denial, finalizes it, and never starts execution',
  Effect.fn(function* testProgram22() {
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
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counter.read.v1',
        },
        actionKey: 'shell.counter.policy-denied',
        auditProfile: 'sensitive',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
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
    const harness = yield* makeHarness();

    const denial = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: action,
        transport: transport('policy-denied'),
      }),
    );

    expect(Predicate.isTagged(denial, 'ActionPolicyDenied')).toBe(true);
    if (!Predicate.isTagged(denial, 'ActionPolicyDenied')) {
      throw new Error('Expected typed test outcome');
    }
    expect(denial.policyReasonCode).toBe('counter_locked');
    expect(denial.reason).toBe('Counter changes are locked — try later');
    expect(observed).toEqual(['first', 'denied']);
    expect(handlerExecutions).toBe(0);
    expect(harness.counts()).toEqual({
      createCount: 1,
      lockCount: 0,
      transactionCount: 0,
      transitionCount: 0,
    });
    expect(harness.stages).toEqual([
      'payload_decoded',
      'trusted_context_validated',
      'module_state_gate',
      'invocation_prepared',
      'authentication_boundary',
      'permission_checked',
      'policy_boundary',
    ]);
    expect(harness.finalized[0]).toEqual({
      actionInvocationId: 'invocation-1',
      actionKey: 'shell.counter.policy-denied',
      auditProfile: 'sensitive',
      policy: { policyKey: 'global.counter-locked.v1', scope: 'global' },
      principal,
      reasonCode: 'counter_locked',
      transport: transport('policy-denied'),
    });
    expect(harness.flushed.length).toBe(0);
  }),
);

it.effect(
  'sanitizes Policy defects and interrupts without finalizing',
  Effect.fn(function* testProgram23() {
    const evaluators = [() => Effect.die('secret evaluator defect'), () => Effect.interrupt] as const;

    yield* forEachSequential(
      evaluators.map((evaluate, index) => [index, evaluate] as const),
      Effect.fn(function* testProgram24([index, evaluate]) {
        let handlerExecutions = 0;
        const policy = defineGlobalPolicy<unknown>({
          evaluate,
          policyKey: `global.failure-${index}.v1`,
        });
        const action = defineAction(
          {
            accessEvidencePolicy: {
              captureMode: 'metadata_only',
              policyKey: 'counter.read.v1',
            },
            actionKey: `shell.counter.policy-failure-${index}`,
            auditProfile: 'standard',
            domainErrorSchema: Schema.Never,
            domainEvents: {},
            entrypoint: defineSystemModuleEntrypoint({
              access: 'write',
              authorization: {
                kind: 'action_execution',
                provisioning: 'tenant_membership_default',
              },
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
        const harness = yield* makeHarness();
        const error = yield* Effect.flip(
          harness.runtime.runAction({
            payload: undefined,
            principal,
            registration: action,
            transport: transport(`policy-failure-${index}`),
          }),
        );

        expect(Predicate.isTagged(error, 'ActionPolicyEvaluationError')).toBe(true);

        expect(error.reason.includes('secret')).toBe(false);
        expect(handlerExecutions).toBe(0);
        expect(harness.finalized.length).toBe(0);
        expect(harness.counts()).toEqual({
          createCount: 1,
          lockCount: 0,
          transactionCount: 0,
          transitionCount: 0,
        });
      }),
    );
  }),
);

it.effect(
  'returns persistence failure when denial evidence cannot be finalized',
  Effect.fn(function* testProgram25() {
    let handlerExecutions = 0;
    const policy = defineGlobalPolicy<unknown>({
      evaluate: () => Effect.fail(denyPolicy('blocked', 'This action is blocked')),
      policyKey: 'global.blocked.v1',
    });
    const action = defineAction(
      {
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counter.read.v1',
        },
        actionKey: 'shell.counter.policy-persistence-failure',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
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
    const harness = yield* makeHarness({ policyFinalizationFailure: true });

    const error = yield* Effect.flip(
      harness.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport('policy-finalization-failure'),
      }),
    );

    expect(Predicate.isTagged(error, 'ActionInvocationPersistenceError')).toBe(true);

    expect(handlerExecutions).toBe(0);
    expect(harness.finalized.length).toBe(0);
    expect(harness.counts().transactionCount).toBe(0);
  }),
);

it.effect(
  'creates fresh collectors for every execution',
  Effect.fn(function* testProgram26() {
    const harness = yield* makeHarness();
    yield* forEachSequential(
      [
        ['first', 1],
        ['second', 2],
      ] as const,
      Effect.fn(function* testProgram27([key, amount]) {
        yield* harness.runtime.runAction({
          payload: { amount },
          principal,
          registration: registration(),
          transport: transport(key),
        });
      }),
    );

    expect(harness.flushed.length).toBe(2);
    expect(harness.flushed.map((item) => item.evidence.domainEvents.length)).toEqual([1, 1]);
    expect(harness.flushed[0]?.evidence).not.toBe(harness.flushed[1]?.evidence);
  }),
);

it.effect(
  'evaluates Policies afresh for separate invocations',
  Effect.fn(function* testProgram28() {
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
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counter.read.v1',
        },
        actionKey: 'shell.counter.fresh-policy',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
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
    yield* forEachSequential(
      ['fresh-first', 'fresh-second'],
      Effect.fn(function* testProgram29(key) {
        const harness = yield* makeHarness({
          createRecord: {
            actionInvocationId: key,
            completedAt: null,
            requestHash: '',
            status: 'received',
          },
        });
        yield* harness.runtime.runAction({
          payload: { amount: 1 },
          principal,
          registration: action,
          transport: transport(key),
        });
      }),
    );

    expect(evaluations).toBe(2);
  }),
);

it.effect(
  'rejects structural payloads, trusted context, and missing idempotency before invocation',
  Effect.fn(function* testProgram30() {
    const harness = yield* makeHarness();
    const invalidPayload = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 'not-a-number' },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    );
    const invalidPrincipal = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal: { ...principal, principalId: 'not-a-uuid' },
        registration: registration(),
        transport: transport(),
      }),
    );
    const missingKey = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: { correlationId: 'correlation-missing-key' },
      }),
    );
    const forgedSystemPrincipal = yield* Effect.flip(
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
    );

    expect(Predicate.isTagged(invalidPayload, 'ActionPayloadValidationError')).toBe(true);

    expect(Predicate.isTagged(invalidPrincipal, 'ActionTrustedContextValidationError')).toBe(true);
    expect(Predicate.isTagged(missingKey, 'ActionIdempotencyKeyRequired')).toBe(true);

    expect(Predicate.isTagged(forgedSystemPrincipal, 'ActionTrustedContextValidationError')).toBe(true);
    expect(harness.counts().createCount).toBe(0);
  }),
);

it.effect(
  'preserves declared domain rejections and rolls back collected evidence',
  Effect.fn(function* testProgram31() {
    const DomainRejectedContract = Schema.TaggedStruct('DomainRejected', {
      reason: Schema.String,
    });
    type DomainRejectedSelf = typeof DomainRejectedContract.Type;
    const DomainRejected = Schema.TaggedError<DomainRejectedSelf>()('DomainRejected', {
      reason: Schema.String,
    });
    const harness = yield* makeHarness();
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
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counter.read.v1',
        },
        actionKey: 'shell.counter.reject',
        auditProfile: 'standard',
        domainErrorSchema: DomainRejected,
        domainEvents: {
          'counter.considered': Schema.Struct({}),
        },
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
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
      Effect.fn(function* rejectCounter(_payload, context) {
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

    const error = yield* Effect.flip(
      harness.runtime.runAction({
        payload: undefined,
        principal,
        registration: rejected,
        transport: transport(),
      }),
    );

    expect(Predicate.isTagged(error, 'DomainRejected')).toBe(true);

    expect(error.reason).toBe('counter_locked');
    expect(policyEvaluations).toBe(1);
    expect(harness.flushed.length).toBe(0);
  }),
);

it.effect(
  'commits business work and success evidence before raising a declared domain rejection',
  Effect.fn(function* commitsBusinessWorkAndSuccessEvidenceBeforeRaisingDeclaredRejection() {
    const CommittedDomainRejectedContract = Schema.TaggedStruct('CommittedDomainRejected', {
      reason: Schema.String,
    });
    type CommittedDomainRejectedSelf = typeof CommittedDomainRejectedContract.Type;
    const CommittedDomainRejected = Schema.TaggedError<CommittedDomainRejectedSelf>()(
      'CommittedDomainRejected',
      { reason: Schema.String },
    );
    const businessWrites: number[] = [];
    const harness = yield* makeHarness();
    const action = defineAction(
      {
        accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
        actionKey: 'shell.counter.commit-then-reject',
        auditProfile: 'standard',
        domainErrorSchema: CommittedDomainRejected,
        domainEvents: {
          'counter.rejection-recorded': Schema.Struct({ amount: Schema.Finite }),
        },
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
          entrypointKey: 'shell.counter.commit-then-reject',
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
      Effect.fn(function* commitThenReject(payload, context) {
        yield* context.services.write(payload.amount);
        yield* context.recordDataAccess({
          accessKind: 'read',
          queryHash: 'counter-rejection-check',
          resultCount: 1,
          servingModuleKey: 'core.shell',
        });
        yield* context.addDomainEvent({
          eventType: 'counter.rejection-recorded',
          payloadJson: { amount: payload.amount },
          producerModuleKey: 'core.shell',
          subjectModuleKey: 'core.shell',
          subjectResourceId: 'primary',
          subjectResourceType: 'counter',
        });
        return commitActionThenReject(new CommittedDomainRejected({ reason: 'proof_expired' }));
      }),
      () =>
        Effect.succeed({
          write: (amount: number) =>
            Effect.sync(() => {
              businessWrites.push(amount);
            }),
        }),
    );

    const error = yield* Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 7 },
        principal,
        registration: action,
        transport: transport('commit-then-reject'),
      }),
    );

    expect(Predicate.isTagged(error, 'CommittedDomainRejected')).toBe(true);
    expect(error.reason).toBe('proof_expired');
    expect(businessWrites).toEqual([7]);
    expect(harness.flushed).toHaveLength(1);
    expect(harness.flushed[0]?.actionInvocationId).toBe('invocation-1');
    expect(harness.flushed[0]?.evidence.dataAccessEvents).toHaveLength(1);
    expect(harness.flushed[0]?.evidence.domainEvents).toHaveLength(1);
    expect(harness.flushed[0]?.resultHash).toBe(
      computeCanonicalValueHash({ _tag: 'CommittedDomainRejected', reason: 'proof_expired' }),
    );
    expect(harness.transactionOutcomes()).toEqual({
      committedTransactionCount: 1,
      rolledBackTransactionCount: 0,
    });
  }),
);

it.effect(
  'rolls back malformed and undeclared committed domain rejection sentinels',
  Effect.fn(function* rollsBackMalformedAndUndeclaredCommittedDomainRejectionSentinels() {
    const DeclaredCommittedRejectionContract = Schema.TaggedStruct('DeclaredCommittedRejection', {
      reason: Schema.String,
    });
    type DeclaredCommittedRejectionSelf = typeof DeclaredCommittedRejectionContract.Type;
    const DeclaredCommittedRejection = Schema.TaggedError<DeclaredCommittedRejectionSelf>()(
      'DeclaredCommittedRejection',
      { reason: Schema.String },
    );
    const malformed = new DeclaredCommittedRejection({ reason: 'malformed' });
    Object.defineProperty(malformed, 'reason', { value: 42 });
    const undeclared = new DeclaredCommittedRejection({ reason: 'undeclared' });
    Object.defineProperty(undeclared, '_tag', { value: 'UndeclaredCommittedRejection' });

    for (const [id, rejection] of [
      ['malformed', malformed],
      ['undeclared', undeclared],
    ] as const) {
      const harness = yield* makeHarness();
      const action = defineAction(
        {
          accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
          actionKey: `shell.counter.${id}-committed-rejection`,
          auditProfile: 'standard',
          domainErrorSchema: DeclaredCommittedRejection,
          domainEvents: {
            'counter.rejection-considered': Schema.Struct({}),
          },
          entrypoint: defineSystemModuleEntrypoint({
            access: 'write',
            authorization: {
              kind: 'action_execution',
              provisioning: 'tenant_membership_default',
            },
            entrypointKey: `shell.counter.${id}-committed-rejection`,
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
        Effect.fn(function* invalidCommitThenReject(_payload, context) {
          yield* context.addDomainEvent({
            eventType: 'counter.rejection-considered',
            payloadJson: {},
            producerModuleKey: 'core.shell',
            subjectModuleKey: 'core.shell',
            subjectResourceId: 'primary',
            subjectResourceType: 'counter',
          });
          return commitActionThenReject(rejection);
        }),
      );

      const error = yield* Effect.flip(
        harness.runtime.runAction({
          payload: undefined,
          principal,
          registration: action,
          transport: transport(`${id}-committed-rejection`),
        }),
      );

      expect(Predicate.isTagged(error, 'ActionHandlerExecutionError')).toBe(true);
      expect(harness.flushed).toHaveLength(0);
      expect(harness.transactionOutcomes()).toEqual({
        committedTransactionCount: 0,
        rolledBackTransactionCount: 1,
      });
    }
  }),
);

it.effect(
  'sanitizes unexpected defects and rejects invalid typed results',
  Effect.fn(function* testProgram32() {
    const defectHarness = yield* makeHarness();
    const defective = defineAction(
      {
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counter.read.v1',
        },
        actionKey: 'shell.counter.defect',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
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
    const defect = yield* Effect.flip(
      defectHarness.runtime.runAction({
        payload: undefined,
        principal,
        registration: defective,
        transport: transport(),
      }),
    );

    const resultHarness = yield* makeHarness();
    const invalidResult = defineAction(
      {
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counter.read.v1',
        },
        actionKey: 'shell.counter.invalid-result',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
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
    const resultError = yield* Effect.flip(
      resultHarness.runtime.runAction({
        payload: undefined,
        principal,
        registration: invalidResult,
        transport: transport(),
      }),
    );

    expect(Predicate.isTagged(defect, 'ActionHandlerExecutionError')).toBe(true);

    expect(defect.reason.includes('secret')).toBe(false);
    expect(Predicate.isTagged(resultError, 'ActionResultValidationError')).toBe(true);

    expect(defectHarness.flushed.length).toBe(0);
    expect(resultHarness.flushed.length).toBe(0);
  }),
);

it.effect(
  'sanitizes undeclared handler failures instead of widening the domain error contract',
  Effect.fn(function* testProgram33() {
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
    const harness = yield* makeHarness();
    const action = defineAction(
      {
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'counter.read.v1',
        },
        actionKey: 'shell.counter.undeclared-error',
        auditProfile: 'standard',
        domainErrorSchema: DeclaredDomainError,
        domainEvents: {},
        entrypoint: defineSystemModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
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
    const error = yield* Effect.flip(
      harness.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport(),
      }),
    );

    expect(Predicate.isTagged(error, 'ActionHandlerExecutionError')).toBe(true);

    expect(error.reason.includes('secret')).toBe(false);
    expect(harness.flushed.length).toBe(0);
  }),
);

it.effect(
  'handles committed, conflict, definite rollback, and indeterminate commit branches',
  Effect.fn(function* testProgram34() {
    const committed = yield* makeHarness({
      createRecord: {
        actionInvocationId: 'committed',
        completedAt: null,
        requestHash: '',
        status: 'succeeded',
      },
    });
    const committedError = yield* Effect.flip(
      committed.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    );

    const conflict = yield* makeHarness({
      createRecord: {
        actionInvocationId: 'conflict',
        completedAt: null,
        requestHash: 'different-request-hash',
        status: 'running',
      },
    });
    const conflictError = yield* Effect.flip(
      conflict.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    );

    const definite = yield* makeHarness({
      transactionMode: 'definite-failure',
    });
    const definiteError = yield* Effect.flip(
      definite.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    );

    const uncertain = yield* makeHarness({ transactionMode: 'uncertain' });
    const uncertainError = yield* Effect.flip(
      uncertain.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    );

    const definiteCommit = yield* makeHarness({
      transactionMode: 'commit-definite',
    });
    const definiteCommitError = yield* Effect.flip(
      definiteCommit.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('definite-commit'),
      }),
    );

    const acknowledgementFailureCodes = ['ETIMEDOUT', 'ECONNABORTED', 'ENETRESET', '08007'];
    const acknowledgementErrors = yield* Effect.forEach(
      acknowledgementFailureCodes,
      Effect.fn(function* testProgram35(code) {
        const harness = yield* makeHarness({ commitFailureCode: code });
        return yield* Effect.flip(
          harness.runtime.runAction({
            payload: { amount: 1 },
            principal,
            registration: registration(),
            transport: transport(`uncertain-${code}`),
          }),
        );
      }),
      { concurrency: 'unbounded' },
    );

    expect(Predicate.isTagged(committedError, 'ActionAlreadyCommitted')).toBe(true);

    expect(committed.counts().transactionCount).toBe(0);
    expect(committed.permissionCounts().permissionCheckCount).toBe(0);
    expect(Predicate.isTagged(conflictError, 'ActionRequestHashConflict')).toBe(true);

    expect(conflict.counts().transactionCount).toBe(0);
    expect(conflict.permissionCounts().permissionCheckCount).toBe(0);
    expect(Predicate.isTagged(definiteError, 'ActionTransactionError')).toBe(true);

    expect(Predicate.isTagged(definiteCommitError, 'ActionTransactionError')).toBe(true);

    expect(Predicate.isTagged(uncertainError, 'ActionCommitIndeterminate')).toBe(true);

    expect(uncertain.flushed.length).toBe(1);
    expect(acknowledgementErrors.length).toBe(acknowledgementFailureCodes.length);
    for (const error of acknowledgementErrors) {
      expect(Predicate.isTagged(error, 'ActionCommitIndeterminate')).toBe(true);
    }
  }),
);

it.effect(
  'interruption during commit waits for native commit settlement',
  Effect.fn(function* testProgram36() {
    const commitStarted = Deferred.makeUnsafe<null>();
    const commitSettlement = Deferred.makeUnsafe<readonly object[]>();
    const harness = yield* makeHarness({
      commit: Deferred.succeed(commitStarted, null).pipe(Effect.andThen(Deferred.await(commitSettlement))),
    });

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

    const exit = yield* Fiber.await(actionFiber);
    const pendingBeforeSettlement = pending;
    expect(pendingBeforeSettlement).toBe(true);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) {
      throw new Error('Expected typed test outcome');
    }
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(harness.flushed.length).toBe(1);
  }),
);

it.effect(
  'resolves commit state explicitly and keeps unavailable outcomes indeterminate',
  Effect.fn(function* testProgram37() {
    const invocationId = '00000000-0000-4000-8000-000000000099';
    const open = yield* makeHarness({
      createRecord: {
        actionInvocationId: invocationId,
        completedAt: null,
        requestHash: 'request',
        status: 'running',
      },
    });
    const openResolution = yield* open.runtime.resolveActionCommit({
      invocationId,
      principal,
    });

    const committed = yield* makeHarness({
      createRecord: {
        actionInvocationId: invocationId,
        completedAt: completionTime(),
        requestHash: 'request',
        status: 'succeeded',
      },
    });
    const committedResolution = yield* Effect.flip(committed.runtime.resolveActionCommit({ invocationId, principal }));

    const unavailable = yield* makeHarness({
      createRecord: {
        actionInvocationId: invocationId,
        completedAt: null,
        requestHash: 'request',
        status: 'indeterminate',
      },
      resolutionUnavailable: true,
    });
    const unavailableResolution = yield* Effect.flip(
      unavailable.runtime.resolveActionCommit({ invocationId, principal }),
    );

    expect(Predicate.isTagged(openResolution, 'ActionCommitOpen')).toBe(true);
    expect(Struct.omit(openResolution, ['_tag'])).toEqual({
      invocationId,
    });
    expect(Predicate.isTagged(committedResolution, 'ActionAlreadyCommitted')).toBe(true);

    expect(Predicate.isTagged(unavailableResolution, 'ActionCommitIndeterminate')).toBe(true);
    if (!Predicate.isTagged(unavailableResolution, 'ActionCommitIndeterminate')) {
      throw new Error('Expected typed test outcome');
    }
    expect(unavailableResolution.invocationId).toBe(invocationId);
  }),
);

it.effect(
  'rejects terminal invocation states before handler execution',
  Effect.fn(function* testProgram38() {
    const terminal = yield* makeHarness({
      createRecord: {
        actionInvocationId: 'terminal',
        completedAt: completionTime(),
        requestHash: '',
        status: 'failed',
      },
    });
    const error = yield* Effect.flip(
      terminal.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    );

    expect(Predicate.isTagged(error, 'ActionInvocationStateError')).toBe(true);

    expect(terminal.counts().transitionCount).toBe(0);
    expect(terminal.counts().transactionCount).toBe(0);
  }),
);

it.effect(
  'uses one runtime contract for Shell/Core and MicroVertical-shaped registrations',
  Effect.fn(function* testProgram39() {
    const shell = yield* makeHarness();
    const microvertical = yield* makeHarness();
    const moduleRegistration = defineAction(
      {
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'stock.read.v1',
        },
        actionKey: 'inventory.stock.reserve',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: {
            kind: 'action_execution',
            provisioning: 'tenant_membership_default',
          },
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

    const shellResult = yield* shell.runtime.runAction({
      payload: { amount: 1 },
      principal,
      registration: registration(),
      transport: transport('shell'),
    });
    const moduleResult = yield* microvertical.runtime.runAction({
      payload: { quantity: 2 },
      principal,
      registration: moduleRegistration,
      transport: {
        ...transport('microvertical'),
        targetModuleKey: 'inventory.stock',
      },
    });

    expect(shellResult).toEqual({ total: 1 });
    expect(moduleResult).toEqual({ reserved: true });
  }),
);

it('the Core database service identity remains server-only', () => {
  expect(Predicate.isFunction(CoreDatabase)).toBe(true);
});
