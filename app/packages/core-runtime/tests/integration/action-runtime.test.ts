/* eslint-disable max-classes-per-file, no-await-in-loop, no-throw-literal, node/callback-return, promise/prefer-await-to-callbacks -- Test-local typed errors, ordered rollback scenarios, simulated driver failures, and Drizzle callback seams are deliberate. */
import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off globalDateInEffect:off
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { Cause, Deferred, Effect, Exit, Schema, Predicate } from 'effect';
import type { ActionHandlerContext } from '../../src/actions/context.ts';
import { makeActionRepository } from '../../src/actions/repository.ts';
import { defineAction } from '../../src/actions/definition.ts';
import { ActionInvocationPersistenceError } from '../../src/actions/errors.ts';
import { createDomainEventReference } from '../../src/actions/events.ts';
import {
  defineGlobalPolicy,
  defineMicroverticalPolicy,
  denyPolicy,
} from '../../src/actions/policy.ts';
import type { ActionPolicy } from '../../src/actions/policy.ts';
import { makeActionRuntime } from '../../src/actions/runtime.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../support/action-runtime-options.ts';
import {
  defineSystemModuleEntrypoint,
  defineTenantModuleEntrypoint,
} from '../../src/modules/module-entrypoint.ts';
import { makeModuleEntrypointGateway } from '../../src/modules/module-entrypoint-gateway.ts';
import { makeModuleStateGate } from '../../src/modules/module-state-gate.ts';
import { changeTenantModuleStateAction } from '../../src/modules/actions/change-tenant-module-state.action.ts';
import { InstalledModuleCatalogService } from '../../src/modules/catalog.ts';
import type { InstalledModuleCatalog } from '../../src/modules/catalog.ts';
import type { OntosModuleDeploymentContract } from '../../src/modules/manifest.ts';
import {
  TenantModuleStateService,
  makeTenantModuleStateService,
} from '../../src/modules/tenant-module-state-service.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import { makeCoreDatabase } from '../../src/db/client.ts';
import type { ScopedTransactionExecutor } from '../../src/db/scoped-transaction.ts';
import {
  actionInvocations,
  auditEvents,
  dataAccessEvents,
  domainEvents,
  legalEntities,
  outboxMessages,
  principalAuthBindings,
  principals,
  tenantModuleStateChanges,
  tenantModuleStates,
  tenants,
} from '../../src/db/schema.ts';

class TestPersistenceError extends Schema.TaggedError<TestPersistenceError>()(
  'TestPersistenceError',
  {
    reason: Schema.String,
  },
) {}

class TestDomainRejected extends Schema.TaggedError<TestDomainRejected>()('TestDomainRejected', {
  reason: Schema.String,
}) {}

const tenantId = randomUUID();
const legalEntityId = randomUUID();
const principalId = randomUUID();
const authBindingId = randomUUID();

const principal = {
  authBindingId,
  authContextRef: `better-auth-session:${authBindingId}`,
  authMethod: 'session',
  legalEntityId,
  principalId,
  tenantId,
} as const;

const transport = (idempotencyKey: string, targetResourceId = 'primary') => ({
  correlationId: `integration-${idempotencyKey}`,
  idempotencyKey,
  targetModuleKey: 'core.shell',
  targetResourceId,
  targetResourceType: 'test-state',
});

const inventoryStockContract: OntosModuleDeploymentContract = {
  deployment: { appId: 'inventory-stock', buildMarker: 'integration-test' },
  manifest: {
    activation: {
      defaultState: 'inactive',
      preservesHistoryWhenInactive: true,
      scope: 'tenant',
      supportedStates: [
        'inactive',
        'active',
        'read_only',
        'suspended',
        'quarantined',
        'deprecated',
        'archived',
      ],
    },
    module: {
      description: 'Inventory integration fixture',
      displayName: 'Inventory',
      id: 'inventory.stock',
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
};

const inventoryInstalledCatalog: InstalledModuleCatalog = Object.freeze({
  contracts: Object.freeze([inventoryStockContract]),
  deploymentAppIds: Object.freeze(['inventory-stock']),
  deploymentStatuses: Object.freeze([
    { appId: 'inventory-stock', moduleId: 'inventory.stock', status: 'available' as const },
  ]),
  getByDeploymentAppId: (appId: string) =>
    appId === 'inventory-stock' ? inventoryStockContract : undefined,
  getByModuleId: (moduleId: string) =>
    moduleId === 'inventory.stock' ? inventoryStockContract : undefined,
  moduleIds: Object.freeze(['inventory.stock']),
  outboxSubscriptions: Object.freeze([]),
});

const allowedPermission = {
  checkActionPermission: () => Effect.succeed('allowed' as const),
};

const withDatabase = <Value, Error>(
  operation: (database: ContextServiceContract) => Effect.Effect<Value, Error>,
) =>
  Effect.scoped(
    Effect.gen(function* databaseScope() {
      const configuration = yield* loadDatabaseConfig();
      const database = yield* makeCoreDatabase(configuration);
      return yield* operation(database);
    }),
  );

type ContextServiceContract = Parameters<typeof makeActionRuntime>[0];

type EvidencePersistenceStage =
  | 'audit'
  | 'data-access'
  | 'domain-event'
  | 'invocation-success'
  | 'outbox';

const withEvidencePersistenceFailure = (
  database: ContextServiceContract,
  stage: EvidencePersistenceStage,
): ContextServiceContract => {
  const transactionOverride = {
    transaction: async (callback, configuration) =>
      await database.executor.transaction(async (transaction) => {
        const insert: typeof transaction.insert = (table) => {
          if (
            (stage === 'audit' && Object.is(table, auditEvents)) ||
            (stage === 'data-access' && Object.is(table, dataAccessEvents)) ||
            (stage === 'domain-event' && Object.is(table, domainEvents)) ||
            (stage === 'outbox' && Object.is(table, outboxMessages))
          ) {
            throw new Error(`Injected ${stage} persistence failure`);
          }
          return transaction.insert(table);
        };
        const update: typeof transaction.update = (table) => {
          if (stage === 'invocation-success' && Object.is(table, actionInvocations)) {
            throw new Error(`Injected ${stage} persistence failure`);
          }
          return transaction.update(table);
        };
        const faultingTransaction: typeof transaction = Object.assign(Object.create(transaction), {
          insert,
          update,
        });
        return await callback(faultingTransaction);
      }, configuration),
  } satisfies Pick<ContextServiceContract['executor'], 'transaction'>;
  const executor: ContextServiceContract['executor'] = Object.assign(
    Object.create(database.executor),
    transactionOverride,
  );

  return { executor };
};

const databasePromise = async <Value>(
  operation: (database: ContextServiceContract) => PromiseLike<Value>,
): Promise<Value> =>
  await Effect.runPromise(withDatabase((database) => Effect.promise(() => operation(database))));

const liveModuleStateOptions = (database: ContextServiceContract) => {
  const moduleStateGate = makeModuleStateGate(makeTenantModuleStateService(database));
  return {
    ...openActionRuntimeOptions,
    moduleEntrypointGateway: makeModuleEntrypointGateway(moduleStateGate),
    moduleStateGate,
  };
};

before(async () => {
  await databasePromise(async (database) => {
    await database.executor.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Action Runtime Integration',
      slug: `action-runtime-${tenantId}`,
      status: 'active',
      tenantId,
    });
    await database.executor.insert(legalEntities).values({
      legalEntityId,
      legalName: 'Action Runtime Integration',
      registrationCountry: 'CZ',
      registrationNumber: tenantId,
      status: 'active',
      tenantId,
    });
    await database.executor.insert(principals).values({
      displayName: 'Action Runtime Integration',
      kind: 'human',
      principalId,
      status: 'active',
      tenantId,
    });
    await database.executor.insert(principalAuthBindings).values({
      principalAuthBindingId: authBindingId,
      principalId,
      provider: 'better_auth',
      providerSubjectId: `action-runtime-${principalId}`,
      status: 'active',
      subjectType: 'user',
      tenantId,
    });
    await database.executor.insert(tenantModuleStates).values({
      moduleKey: 'inventory.stock',
      state: 'active',
      tenantId,
    });
  });
});

after(async () => {
  await databasePromise(async (database) => {
    await database.executor.delete(outboxMessages).where(eq(outboxMessages.tenantId, tenantId));
    await database.executor.delete(domainEvents).where(eq(domainEvents.tenantId, tenantId));
    await database.executor.delete(dataAccessEvents).where(eq(dataAccessEvents.tenantId, tenantId));
    await database.executor.delete(auditEvents).where(eq(auditEvents.tenantId, tenantId));
    await database.executor
      .delete(tenantModuleStateChanges)
      .where(eq(tenantModuleStateChanges.tenantId, tenantId));
    await database.executor
      .delete(tenantModuleStates)
      .where(eq(tenantModuleStates.tenantId, tenantId));
    await database.executor
      .delete(actionInvocations)
      .where(eq(actionInvocations.tenantId, tenantId));
    await database.executor
      .delete(principalAuthBindings)
      .where(eq(principalAuthBindings.tenantId, tenantId));
    await database.executor.delete(principals).where(eq(principals.tenantId, tenantId));
    await database.executor.delete(legalEntities).where(eq(legalEntities.tenantId, tenantId));
    await database.executor.delete(tenants).where(eq(tenants.tenantId, tenantId));
  });
});

const TestDomainEvents = {
  'test-state.changed': Schema.Struct({ value: Schema.String }),
};

interface TestActionServices {
  readonly transaction: ScopedTransactionExecutor;
}
type TestActionContext = ActionHandlerContext<typeof TestDomainEvents, TestActionServices>;

interface RegistrationOptions {
  readonly actionKey: string;
  readonly mode?: 'orphan-outbox' | 'reject' | 'success';
  readonly moduleStateKey: string;
  readonly onExecute?: () => void;
  readonly pause?: boolean;
  readonly policies?: readonly ActionPolicy<{ readonly value: string }, 'core.shell'>[];
}

const makeRegistration = ({
  actionKey,
  mode = 'success',
  moduleStateKey,
  onExecute,
  pause = false,
  policies = [],
}: RegistrationOptions) =>
  defineAction(
    {
      accessEvidencePolicy: {
        captureMode: 'metadata_only',
        policyKey: 'action-runtime.integration.v1',
      },
      actionKey,
      auditProfile: 'standard',
      domainErrorSchema: Schema.Union([TestDomainRejected, TestPersistenceError]),
      domainEvents: TestDomainEvents,
      entrypoint: defineSystemModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: actionKey,
        moduleKey: 'core.shell',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'core.shell',
      payloadSchema: Schema.Struct({ value: Schema.String }),
      policies,
      resultSchema: Schema.Struct({ stateId: Schema.String, value: Schema.String }),
      schemaVersion: '1',
    },
    (payload, context: TestActionContext) =>
      Effect.gen(function* integrationHandler() {
        onExecute?.();
        const inserted = yield* Effect.tryPromise({
          catch: () => new TestPersistenceError({ reason: 'test business write failed' }),
          try: () =>
            context.services.transaction
              .insert(tenantModuleStates)
              .values({
                moduleKey: moduleStateKey,
                state: 'active',
                tenantId: context.scope.tenantId,
              })
              .returning({
                tenantModuleStateId: tenantModuleStates.tenantModuleStateId,
              }),
        });

        yield* context.recordDataAccess({
          accessKind: 'read',
          queryHash: `lookup-${moduleStateKey}`,
          resultCount: 0,
          servingModuleKey: 'core.shell',
          targetModuleKey: 'core.shell',
          targetResourceId: moduleStateKey,
          targetResourceType: 'test-state',
        });

        if (mode === 'orphan-outbox') {
          yield* context.addOutboxMessage(createDomainEventReference(), {
            payloadJson: { value: payload.value },
            producerModuleKey: 'core.shell',
            topic: 'test-state.project',
          });
        }

        const domainEvent = yield* context.addDomainEvent({
          eventType: 'test-state.changed',
          payloadJson: { value: payload.value },
          producerModuleKey: 'core.shell',
          subjectModuleKey: 'core.shell',
          subjectResourceId: moduleStateKey,
          subjectResourceType: 'test-state',
        });
        yield* context.addOutboxMessage(domainEvent, {
          payloadJson: { value: payload.value },
          producerModuleKey: 'core.shell',
          topic: 'test-state.project',
        });

        if (pause) {
          yield* Effect.sleep('100 millis');
        }
        if (mode === 'reject') {
          return yield* new TestDomainRejected({ reason: 'test domain rejection' });
        }

        const [row] = inserted;
        if (row === undefined) {
          return yield* new TestPersistenceError({ reason: 'test write returned no row' });
        }
        return {
          stateId: row.tenantModuleStateId,
          value: payload.value,
        };
      }),
    (transaction) => Effect.succeed({ transaction }),
  );

const failureTag = <Error>(exit: Exit.Exit<unknown, Error>): string | undefined => {
  if (Exit.isSuccess(exit)) {
    return undefined;
  }
  const failure = Cause.findErrorOption(exit.cause);
  return failure._tag === 'Some' &&
    Predicate.isObjectKeyword(failure.value) &&
    failure.value !== null &&
    '_tag' in failure.value
    ? String(failure.value._tag)
    : undefined;
};

void test('rechecks business module state under the tenant lock and retries after Core recovery', async () => {
  await databasePromise(async (database) => {
    await database.executor
      .update(tenantModuleStates)
      .set({ state: 'active' })
      .where(eq(tenantModuleStates.moduleKey, 'inventory.stock'));

    const policyReached = await Effect.runPromise(Deferred.make<null>());
    const continuePolicy = await Effect.runPromise(Deferred.make<null>());
    let handlerExecutions = 0;
    const action = defineAction(
      {
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'inventory.stock.concurrent-gate.v1',
        },
        actionKey: 'inventory.stock.concurrent-gate',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
          entrypointKey: 'inventory.stock.concurrent-gate',
          moduleKey: 'inventory.stock',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: 'inventory.stock',
        payloadSchema: Schema.Void,
        policies: [
          defineGlobalPolicy({
            evaluate: () =>
              Effect.gen(function* pauseBetweenGates() {
                yield* Deferred.succeed(policyReached, null);
                yield* Deferred.await(continuePolicy);
              }),
            policyKey: 'global.pause-between-module-gates.v1',
          }),
        ],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () =>
        Effect.sync(() => {
          handlerExecutions += 1;
        }),
    );
    const runtime = makeActionRuntime(
      database,
      makeActionRepository(),
      allowedPermission,
      testOperationalScopeResolver,
      liveModuleStateOptions(database),
    );
    const firstAttempt = Effect.runPromise(
      Effect.exit(
        runtime.runAction({
          payload: undefined,
          principal,
          registration: action,
          transport: transport('business-module-concurrent-gate'),
        }),
      ),
    );
    await Effect.runPromise(Deferred.await(policyReached));
    await Effect.runPromise(
      runtime
        .runAction({
          payload: {
            expectedState: 'active',
            moduleKey: 'inventory.stock',
            newState: 'suspended',
            reason: 'integration locked recheck',
          },
          principal,
          registration: changeTenantModuleStateAction,
          transport: transport('business-module-suspend'),
        })
        .pipe(
          Effect.provideService(InstalledModuleCatalogService, {
            load: Effect.succeed(inventoryInstalledCatalog),
          }),
          Effect.provideService(TenantModuleStateService, makeTenantModuleStateService(database)),
        ),
    );
    await Effect.runPromise(Deferred.succeed(continuePolicy, null));
    const denied = await firstAttempt;
    assert.equal(failureTag(denied), 'ModuleStateDeniedError');
    assert.equal(handlerExecutions, 0);

    const [openInvocation] = await database.executor
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.idempotencyKey, 'business-module-concurrent-gate'));
    assert.ok(openInvocation);
    assert.equal(openInvocation.completedAt, null);
    const deniedEvidence = await database.executor
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actionInvocationId, openInvocation.actionInvocationId));
    assert.equal(deniedEvidence.length, 0);

    await Effect.runPromise(
      runtime
        .runAction({
          payload: {
            expectedState: 'suspended',
            moduleKey: 'inventory.stock',
            newState: 'active',
            reason: 'integration recovery',
          },
          principal,
          registration: changeTenantModuleStateAction,
          transport: transport('business-module-reactivate'),
        })
        .pipe(
          Effect.provideService(InstalledModuleCatalogService, {
            load: Effect.succeed(inventoryInstalledCatalog),
          }),
          Effect.provideService(TenantModuleStateService, makeTenantModuleStateService(database)),
        ),
    );
    await Effect.runPromise(
      runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport('business-module-concurrent-gate'),
      }),
    );
    assert.equal(handlerExecutions, 1);
  });
});

void test('atomically commits business state, all success evidence, and the succeeded marker', async () => {
  const key = 'atomic-success';
  const moduleStateKey = `test.${key}.${tenantId}`;

  await databasePromise(async (database) => {
    const runtime = makeActionRuntime(
      database,
      makeActionRepository(),
      allowedPermission,
      testOperationalScopeResolver,
      openActionRuntimeOptions,
    );
    const result = await Effect.runPromise(
      runtime.runAction({
        payload: { value: 'committed' },
        principal,
        registration: makeRegistration({
          actionKey: 'shell.test.atomic-success',
          moduleStateKey,
        }),
        transport: transport(key, moduleStateKey),
      }),
    );

    const [states, invocations, audits, accesses, events, messages] = await Promise.all([
      database.executor
        .select()
        .from(tenantModuleStates)
        .where(eq(tenantModuleStates.moduleKey, moduleStateKey)),
      database.executor
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.idempotencyKey, key)),
      database.executor.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantId)),
      database.executor
        .select()
        .from(dataAccessEvents)
        .where(eq(dataAccessEvents.tenantId, tenantId)),
      database.executor
        .select()
        .from(domainEvents)
        .where(eq(domainEvents.subjectResourceId, moduleStateKey)),
      database.executor.select().from(outboxMessages).where(eq(outboxMessages.tenantId, tenantId)),
    ]);

    assert.equal(result.value, 'committed');
    assert.equal(states.length, 1);
    assert.equal(invocations[0]?.status, 'succeeded');
    assert.ok(invocations[0]?.completedAt);
    assert.equal(
      audits.filter((row) => row.actionInvocationId === invocations[0]?.actionInvocationId).length,
      1,
    );
    assert.equal(
      accesses.filter((row) => row.actionInvocationId === invocations[0]?.actionInvocationId)
        .length,
      1,
    );
    assert.equal(events.length, 1);
    assert.equal(
      messages.filter((row) => row.domainEventId === events[0]?.domainEventId).length,
      1,
    );
    assert.equal((events[0]?.tenantSequenceNo ?? 0) > 0, true);
  });
});

void test('commits allowed Policy checkpoints atomically before handler success evidence', async () => {
  const key = 'policy-allowed';
  const moduleStateKey = `test.${key}.${tenantId}`;
  const observed: string[] = [];
  const policy = defineGlobalPolicy<{ readonly value: string }>({
    evaluate: () => {
      observed.push('policy');
      return Effect.void;
    },
    policyKey: 'global.integration-allowed.v1',
  });

  await databasePromise(async (database) => {
    const runtime = makeActionRuntime(
      database,
      makeActionRepository(),
      allowedPermission,
      testOperationalScopeResolver,
      openActionRuntimeOptions,
    );
    await Effect.runPromise(
      runtime.runAction({
        payload: { value: 'committed' },
        principal,
        registration: makeRegistration({
          actionKey: 'shell.test.policy-allowed',
          moduleStateKey,
          onExecute: () => observed.push('handler'),
          policies: [policy],
        }),
        transport: transport(key, moduleStateKey),
      }),
    );

    const [invocation] = await database.executor
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.idempotencyKey, key));
    assert.ok(invocation);
    const audits = await database.executor
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actionInvocationId, invocation.actionInvocationId));

    assert.deepEqual(observed, ['policy', 'handler']);
    assert.equal(invocation.status, 'succeeded');
    assert.equal(audits.length, 2);
    const policyAudit = audits.find((row) => row.eventType === 'action.policy_checked');
    const executionAudit = audits.find((row) => row.eventType === 'action.executed');
    assert.equal(policyAudit?.outcome, 'allowed');
    assert.equal(policyAudit?.outcomeStage, 'policy');
    assert.equal(executionAudit?.outcome, 'succeeded');
    assert.equal(executionAudit?.outcomeStage, 'execution');
    assert.equal(JSON.stringify(policyAudit?.evidenceJson).includes('committed'), false);
    assert.equal(JSON.stringify(policyAudit?.evidenceJson).includes(policy.policyKey), true);
  });
});

void test('atomically rejects denied global and same-owner MicroVertical Policies without handler evidence', async () => {
  const scenarios = [
    {
      actionKey: 'shell.test.policy-denied-global',
      key: 'policy-denied-global',
      makeRegistration(handler: () => void) {
        const policy = defineGlobalPolicy<{ readonly value: string }>({
          evaluate: () =>
            Effect.fail(
              denyPolicy('tenant_suspended', 'This tenant is suspended — contact support'),
            ),
          policyKey: 'global.tenant-active.v1',
        });
        return makeRegistration({
          actionKey: this.actionKey,
          moduleStateKey: `test.${this.key}.${tenantId}`,
          onExecute: handler,
          policies: [policy],
        });
      },
      reason: 'This tenant is suspended — contact support',
      reasonCode: 'tenant_suspended',
    },
    {
      actionKey: 'inventory.stock.policy-denied-local',
      key: 'policy-denied-local',
      makeRegistration(handler: () => void) {
        const policy = defineMicroverticalPolicy<{ readonly value: string }, 'inventory.stock'>({
          evaluate: () =>
            Effect.fail(denyPolicy('stock_locked', 'Stock is locked for reconciliation')),
          owningModuleKey: 'inventory.stock',
          policyKey: 'inventory.stock.unlocked.v1',
        });
        return defineAction(
          {
            accessEvidencePolicy: {
              captureMode: 'metadata_only',
              policyKey: 'action-runtime.integration.v1',
            },
            actionKey: this.actionKey,
            auditProfile: 'standard',
            domainErrorSchema: Schema.Union([TestDomainRejected, TestPersistenceError]),
            domainEvents: {
              'test-state.changed': Schema.Struct({ value: Schema.String }),
            },
            entrypoint: defineTenantModuleEntrypoint({
              access: 'write',
              authorization: {
                kind: 'action_execution',
                provisioning: 'tenant_membership_default',
              },
              entrypointKey: this.actionKey,
              moduleKey: 'inventory.stock',
              role: 'action',
            }),
            idempotency: 'required',
            legalEntityScope: 'optional',
            owningModuleKey: 'inventory.stock',
            payloadSchema: Schema.Struct({ value: Schema.String }),
            policies: [policy],
            resultSchema: Schema.Struct({ stateId: Schema.String, value: Schema.String }),
            schemaVersion: '1',
          },
          (payload, _context: TestActionContext) => {
            handler();
            return Effect.succeed({ stateId: 'unreachable', value: payload.value });
          },
          (transaction) => Effect.succeed({ transaction }),
        );
      },
      reason: 'Stock is locked for reconciliation',
      reasonCode: 'stock_locked',
    },
  ] as const;

  await databasePromise(async (database) => {
    const runtime = makeActionRuntime(
      database,
      makeActionRepository(),
      allowedPermission,
      testOperationalScopeResolver,
      openActionRuntimeOptions,
    );
    for (const scenario of scenarios) {
      let handlerExecutions = 0;
      const beforeMessages = await database.executor
        .select()
        .from(outboxMessages)
        .where(eq(outboxMessages.tenantId, tenantId));
      const actionEffect = runtime.runAction({
        payload: { value: 'must-not-persist' },
        principal,
        registration: scenario.makeRegistration(() => {
          handlerExecutions += 1;
        }),
        transport: transport(scenario.key, `test.${scenario.key}.${tenantId}`),
      });
      const exit = await Effect.runPromise(Effect.exit(actionEffect));
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
      assert.equal(failureTag(exit), 'ActionPolicyDenied');
      if (
        failure?._tag === 'Some' &&
        Predicate.isObjectKeyword(failure.value) &&
        failure.value !== null
      ) {
        assert.equal('reason' in failure.value && failure.value.reason, scenario.reason);
        assert.equal(
          'policyReasonCode' in failure.value && failure.value.policyReasonCode,
          scenario.reasonCode,
        );
      }
      assert.equal(handlerExecutions, 0);

      const [invocation] = await database.executor
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.idempotencyKey, scenario.key));
      assert.ok(invocation);
      const [audits, accesses, events, states] = await Promise.all([
        database.executor
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.actionInvocationId, invocation.actionInvocationId)),
        database.executor
          .select()
          .from(dataAccessEvents)
          .where(eq(dataAccessEvents.actionInvocationId, invocation.actionInvocationId)),
        database.executor
          .select()
          .from(domainEvents)
          .where(eq(domainEvents.actionInvocationId, invocation.actionInvocationId)),
        database.executor
          .select()
          .from(tenantModuleStates)
          .where(eq(tenantModuleStates.moduleKey, `test.${scenario.key}.${tenantId}`)),
      ]);
      const messages = await database.executor
        .select()
        .from(outboxMessages)
        .where(eq(outboxMessages.tenantId, tenantId));

      assert.equal(invocation.status, 'rejected');
      assert.ok(invocation.completedAt);
      assert.equal(audits.length, 2);
      for (const eventType of ['action.policy_checked', 'action.rejected']) {
        const audit = audits.find((row) => row.eventType === eventType);
        assert.equal(audit?.outcome, 'denied');
        assert.equal(audit?.outcomeStage, 'policy');
        assert.equal(audit?.outcomeCode, scenario.reasonCode);
      }
      assert.equal(JSON.stringify(audits).includes(scenario.reason), false);
      assert.equal(accesses.length, 0);
      assert.equal(events.length, 0);
      assert.equal(states.length, 0);
      assert.equal(messages.length, beforeMessages.length);
    }
  });
});

void test('rolls back every denied-Policy finalization persistence failure', async () => {
  const policy = defineGlobalPolicy<{ readonly value: string }>({
    evaluate: () => Effect.fail(denyPolicy('blocked', 'This operation is blocked')),
    policyKey: 'global.blocked.v1',
  });

  await databasePromise(async (database) => {
    for (const stage of ['audit', 'invocation-success'] as const) {
      const key = `policy-finalization-${stage}`;
      let handlerExecutions = 0;
      const runtime = makeActionRuntime(
        withEvidencePersistenceFailure(database, stage),
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions,
      );
      const exit = await Effect.runPromise(
        Effect.exit(
          runtime.runAction({
            payload: { value: 'must-not-persist' },
            principal,
            registration: makeRegistration({
              actionKey: `shell.test.${key}`,
              moduleStateKey: `test.${key}.${tenantId}`,
              onExecute: () => {
                handlerExecutions += 1;
              },
              policies: [policy],
            }),
            transport: transport(key),
          }),
        ),
      );
      const [invocation] = await database.executor
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.idempotencyKey, key));
      assert.ok(invocation);
      const audits = await database.executor
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.actionInvocationId, invocation.actionInvocationId));

      assert.equal(failureTag(exit), 'ActionInvocationPersistenceError');
      assert.equal(handlerExecutions, 0);
      assert.equal(invocation.status, 'received');
      assert.equal(invocation.completedAt, null);
      assert.equal(audits.length, 0);
    }
  });
});

void test('rolls back domain rejection, evidence persistence failure, and orphan outbox attempts', async () => {
  const scenarios = [
    {
      actionKey: 'shell.test.domain-rejection',
      expectedTag: 'TestDomainRejected',
      key: 'domain-rejection',
      mode: 'reject',
    },
    {
      actionKey: 'shell.test.evidence-failure',
      expectedTag: 'ActionTransactionError',
      key: 'evidence-failure',
      mode: 'success',
    },
    {
      actionKey: 'shell.test.orphan-outbox',
      expectedTag: 'ActionCollectorError',
      key: 'orphan-outbox',
      mode: 'orphan-outbox',
    },
  ] as const;

  await databasePromise(async (database) => {
    for (const scenario of scenarios) {
      const moduleStateKey = `test.${scenario.key}.${tenantId}`;
      const runtime = makeActionRuntime(
        scenario.key === 'evidence-failure'
          ? withEvidencePersistenceFailure(database, 'audit')
          : database,
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions,
      );
      const exit = await Effect.runPromise(
        Effect.exit(
          runtime.runAction({
            payload: { value: scenario.key },
            principal,
            registration: makeRegistration({
              actionKey: scenario.actionKey,
              mode: scenario.mode,
              moduleStateKey,
            }),
            transport: transport(scenario.key, moduleStateKey),
          }),
        ),
      );

      const states = await database.executor
        .select()
        .from(tenantModuleStates)
        .where(eq(tenantModuleStates.moduleKey, moduleStateKey));
      const invocations = await database.executor
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.idempotencyKey, scenario.key));
      const invocationId = invocations[0]?.actionInvocationId;
      const committedEvidence =
        invocationId === undefined
          ? []
          : await database.executor
              .select()
              .from(auditEvents)
              .where(eq(auditEvents.actionInvocationId, invocationId));
      const committedAccesses =
        invocationId === undefined
          ? []
          : await database.executor
              .select()
              .from(dataAccessEvents)
              .where(eq(dataAccessEvents.actionInvocationId, invocationId));
      const committedEvents =
        invocationId === undefined
          ? []
          : await database.executor
              .select()
              .from(domainEvents)
              .where(eq(domainEvents.actionInvocationId, invocationId));

      assert.equal(failureTag(exit), scenario.expectedTag);
      assert.equal(states.length, 0);
      assert.equal(invocations[0]?.status, 'running');
      assert.equal(invocations[0]?.completedAt, null);
      assert.equal(committedEvidence.length, 0);
      assert.equal(committedAccesses.length, 0);
      assert.equal(committedEvents.length, 0);
    }
  });
});

void test('rolls back every individual success-evidence persistence failure', async () => {
  const stages: readonly EvidencePersistenceStage[] = [
    'audit',
    'data-access',
    'domain-event',
    'outbox',
    'invocation-success',
  ];
  const allowedPolicy = defineGlobalPolicy<{ readonly value: string }>({
    evaluate: () => Effect.void,
    policyKey: 'global.atomic-success-evidence.v1',
  });

  await databasePromise(async (database) => {
    for (const stage of stages) {
      const key = `evidence-${stage}`;
      const moduleStateKey = `test.${key}.${tenantId}`;
      const beforeOutbox = await database.executor
        .select()
        .from(outboxMessages)
        .where(eq(outboxMessages.tenantId, tenantId));
      const runtime = makeActionRuntime(
        withEvidencePersistenceFailure(database, stage),
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions,
      );
      const exit = await Effect.runPromise(
        Effect.exit(
          runtime.runAction({
            payload: { value: stage },
            principal,
            registration: makeRegistration({
              actionKey: `shell.test.${key}`,
              moduleStateKey,
              policies: stage === 'audit' ? [allowedPolicy] : [],
            }),
            transport: transport(key, moduleStateKey),
          }),
        ),
      );

      const states = await database.executor
        .select()
        .from(tenantModuleStates)
        .where(eq(tenantModuleStates.moduleKey, moduleStateKey));
      const [invocation] = await database.executor
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.idempotencyKey, key));
      assert.notEqual(invocation, undefined);
      const invocationId = invocation?.actionInvocationId ?? '';
      const [audits, accesses, events, afterOutbox] = await Promise.all([
        database.executor
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.actionInvocationId, invocationId)),
        database.executor
          .select()
          .from(dataAccessEvents)
          .where(eq(dataAccessEvents.actionInvocationId, invocationId)),
        database.executor
          .select()
          .from(domainEvents)
          .where(eq(domainEvents.actionInvocationId, invocationId)),
        database.executor
          .select()
          .from(outboxMessages)
          .where(eq(outboxMessages.tenantId, tenantId)),
      ]);

      assert.equal(failureTag(exit), 'ActionTransactionError', stage);
      assert.equal(states.length, 0, stage);
      assert.equal(invocation?.status, 'running', stage);
      assert.equal(invocation?.completedAt, null, stage);
      assert.equal(audits.length, 0, stage);
      assert.equal(accesses.length, 0, stage);
      assert.equal(events.length, 0, stage);
      assert.equal(afterOutbox.length, beforeOutbox.length, stage);
    }
  });
});

void test('keeps Policy rejection terminal and deduplicates repeated and concurrent evidence', async () => {
  await databasePromise(async (database) => {
    const runtime = makeActionRuntime(
      database,
      makeActionRepository(),
      allowedPermission,
      testOperationalScopeResolver,
      openActionRuntimeOptions,
    );
    let evaluations = 0;
    let handlerExecutions = 0;
    const policy = defineGlobalPolicy<{ readonly value: string }>({
      evaluate: () => {
        evaluations += 1;
        return Effect.fail(denyPolicy('terminal_rejection', 'This rejection is terminal'));
      },
      policyKey: 'global.terminal-rejection.v1',
    });
    const key = 'policy-terminal-retry';
    const action = makeRegistration({
      actionKey: 'shell.test.policy-terminal-retry',
      moduleStateKey: `test.${key}.${tenantId}`,
      onExecute: () => {
        handlerExecutions += 1;
      },
      policies: [policy],
    });
    const input = {
      payload: { value: 'same' },
      principal,
      registration: action,
      transport: transport(key),
    };
    const first = await Effect.runPromise(Effect.exit(runtime.runAction(input)));
    const retry = await Effect.runPromise(Effect.exit(runtime.runAction(input)));
    const [invocation] = await database.executor
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.idempotencyKey, key));
    assert.ok(invocation);
    const audits = await database.executor
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actionInvocationId, invocation.actionInvocationId));

    assert.equal(failureTag(first), 'ActionPolicyDenied');
    assert.equal(failureTag(retry), 'ActionInvocationStateError');
    assert.equal(evaluations, 1);
    assert.equal(handlerExecutions, 0);
    assert.equal(invocation.status, 'rejected');
    assert.equal(audits.length, 2);

    let concurrentEvaluations = 0;
    const concurrentKey = 'policy-terminal-concurrent';
    const concurrentPolicy = defineGlobalPolicy<{ readonly value: string }>({
      evaluate: () =>
        Effect.gen(function* delayedDenial() {
          concurrentEvaluations += 1;
          yield* Effect.sleep('20 millis');
          return yield* denyPolicy('concurrent_rejection', 'Concurrent request rejected');
        }),
      policyKey: 'global.concurrent-rejection.v1',
    });
    const concurrentInput = {
      payload: { value: 'same' },
      principal,
      registration: makeRegistration({
        actionKey: 'shell.test.policy-terminal-concurrent',
        moduleStateKey: `test.${concurrentKey}.${tenantId}`,
        onExecute: () => {
          handlerExecutions += 1;
        },
        policies: [concurrentPolicy],
      }),
      transport: transport(concurrentKey),
    };
    const concurrent = await Promise.all([
      Effect.runPromise(Effect.exit(runtime.runAction(concurrentInput))),
      Effect.runPromise(Effect.exit(runtime.runAction(concurrentInput))),
    ]);
    const [concurrentInvocation] = await database.executor
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.idempotencyKey, concurrentKey));
    assert.ok(concurrentInvocation);
    const concurrentAudits = await database.executor
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actionInvocationId, concurrentInvocation.actionInvocationId));

    assert.deepEqual(concurrent.map(failureTag), ['ActionPolicyDenied', 'ActionPolicyDenied']);
    assert.equal(concurrentEvaluations, 2);
    assert.equal(handlerExecutions, 0);
    assert.equal(concurrentInvocation.status, 'rejected');
    assert.equal(concurrentAudits.length, 2);
  });
});

void test('never lets a losing Policy denial replace a running or successful invocation', async () => {
  await databasePromise(async (database) => {
    const repository = makeActionRepository();
    const allowedRuntime = makeActionRuntime(
      database,
      repository,
      allowedPermission,
      testOperationalScopeResolver,
      openActionRuntimeOptions,
    );
    const deniedRuntime = makeActionRuntime(
      database,
      repository,
      allowedPermission,
      testOperationalScopeResolver,
      openActionRuntimeOptions,
    );
    const handlerStarted = await Effect.runPromise(Deferred.make<null>());
    const key = 'policy-loses-to-success';
    const moduleStateKey = `test.${key}.${tenantId}`;
    const actionKey = 'shell.test.policy-loses-to-success';
    const allowed = makeRegistration({
      actionKey,
      moduleStateKey,
      onExecute: () => {
        Effect.runSync(Deferred.succeed(handlerStarted, null));
      },
      pause: true,
    });
    const denial = defineGlobalPolicy<{ readonly value: string }>({
      evaluate: () => Effect.fail(denyPolicy('late_denial', 'This denial arrived too late')),
      policyKey: 'global.late-denial.v1',
    });
    const denied = makeRegistration({
      actionKey,
      moduleStateKey,
      policies: [denial],
    });
    const sharedInput = {
      payload: { value: 'same' },
      principal,
      transport: transport(key, moduleStateKey),
    };

    const success = Effect.runPromise(
      allowedRuntime.runAction({ ...sharedInput, registration: allowed }),
    );
    await Effect.runPromise(Deferred.await(handlerStarted));
    const rejected = Effect.runPromise(
      Effect.exit(deniedRuntime.runAction({ ...sharedInput, registration: denied })),
    );
    const [successResult, rejectedExit] = await Promise.all([success, rejected]);
    const [invocation] = await database.executor
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.idempotencyKey, key));
    assert.ok(invocation);
    const audits = await database.executor
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actionInvocationId, invocation.actionInvocationId));

    assert.equal(successResult.value, 'same');
    assert.equal(failureTag(rejectedExit), 'ActionInvocationPersistenceError');
    assert.equal(invocation.status, 'succeeded');
    assert.equal(audits.filter((row) => row.eventType === 'action.rejected').length, 0);
  });
});

void test('serializes concurrent requests and enforces committed, open-retry, and hash-conflict behavior', async () => {
  await Effect.runPromise(
    withDatabase((database) => {
      const runtime = makeActionRuntime(
        database,
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions,
      );
      let executions = 0;
      const concurrentKey = 'concurrent-once';
      const concurrentModule = `test.concurrent.${tenantId}`;
      const concurrentInput = {
        payload: { value: 'same' },
        principal,
        registration: makeRegistration({
          actionKey: 'shell.test.concurrent',
          moduleStateKey: concurrentModule,
          onExecute: () => {
            executions += 1;
          },
          pause: true,
        }),
        transport: transport(concurrentKey, concurrentModule),
      };

      return Effect.gen(function* concurrencyProof() {
        const concurrentResults = yield* Effect.all(
          [
            Effect.exit(runtime.runAction(concurrentInput)),
            Effect.exit(runtime.runAction(concurrentInput)),
          ],
          { concurrency: 'unbounded' },
        );

        assert.equal(executions, 1);
        assert.equal(concurrentResults.filter(Exit.isSuccess).length, 1);
        assert.deepEqual(concurrentResults.filter(Exit.isFailure).map(failureTag), [
          'ActionAlreadyCommitted',
        ]);

        const committedRetry = yield* Effect.exit(
          runtime.runAction({
            ...concurrentInput,
            transport: {
              ...concurrentInput.transport,
              correlationId: 'integration-concurrent-retry',
              traceId: 'retry-trace',
            },
          }),
        );
        assert.equal(failureTag(committedRetry), 'ActionAlreadyCommitted');
        assert.equal(executions, 1);

        const conflict = yield* Effect.exit(
          runtime.runAction({
            ...concurrentInput,
            payload: { value: 'different' },
          }),
        );
        assert.equal(failureTag(conflict), 'ActionRequestHashConflict');

        const openKey = 'open-retry';
        const openModule = `test.open-retry.${tenantId}`;
        const rejected = yield* Effect.exit(
          runtime.runAction({
            payload: { value: 'retryable' },
            principal,
            registration: makeRegistration({
              actionKey: 'shell.test.open-retry',
              mode: 'reject',
              moduleStateKey: openModule,
            }),
            transport: transport(openKey, openModule),
          }),
        );
        assert.equal(failureTag(rejected), 'TestDomainRejected');

        const retried = yield* runtime.runAction({
          payload: { value: 'retryable' },
          principal,
          registration: makeRegistration({
            actionKey: 'shell.test.open-retry',
            moduleStateKey: openModule,
          }),
          transport: transport(openKey, openModule),
        });
        assert.equal(retried.value, 'retryable');
      });
    }),
  );
});

void test('serializes Domain Event allocation by tenant commit order', async () => {
  await databasePromise(async (database) => {
    const firstCommitRelease = await Effect.runPromise(Deferred.make<null>());
    const firstFlushed = await Effect.runPromise(Deferred.make<null>());
    const delayedTransaction = {
      transaction: async (callback, configuration) =>
        await database.executor.transaction(async (transaction) => {
          const result = await callback(transaction);
          Effect.runSync(Deferred.succeed(firstFlushed, null));
          await Effect.runPromise(Deferred.await(firstCommitRelease));
          return result;
        }, configuration),
    } satisfies Pick<ContextServiceContract['executor'], 'transaction'>;
    const delayedExecutor: ContextServiceContract['executor'] = Object.assign(
      Object.create(database.executor),
      delayedTransaction,
    );
    const repository = makeActionRepository();
    const firstRuntime = makeActionRuntime(
      { executor: delayedExecutor },
      repository,
      allowedPermission,
      testOperationalScopeResolver,
      openActionRuntimeOptions,
    );
    const secondRuntime = makeActionRuntime(
      database,
      repository,
      allowedPermission,
      testOperationalScopeResolver,
      openActionRuntimeOptions,
    );
    const firstModule = `test.sequence.first.${tenantId}`;
    const secondModule = `test.sequence.second.${tenantId}`;

    const first = Effect.runPromise(
      firstRuntime.runAction({
        payload: { value: 'first' },
        principal,
        registration: makeRegistration({
          actionKey: 'shell.test.sequence-first',
          moduleStateKey: firstModule,
        }),
        transport: transport('sequence-first', firstModule),
      }),
    );
    await Effect.runPromise(Deferred.await(firstFlushed));

    let secondCompleted = false;
    const second = Effect.runPromise(
      secondRuntime.runAction({
        payload: { value: 'second' },
        principal,
        registration: makeRegistration({
          actionKey: 'shell.test.sequence-second',
          moduleStateKey: secondModule,
        }),
        transport: transport('sequence-second', secondModule),
      }),
    ).finally(() => {
      secondCompleted = true;
    });

    await Effect.runPromise(Effect.sleep('50 millis'));
    assert.equal(secondCompleted, false);

    Effect.runSync(Deferred.succeed(firstCommitRelease, null));
    await Promise.all([first, second]);

    const events = await database.executor
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.tenantId, tenantId));
    const firstEvent = events.find((event) => event.subjectResourceId === firstModule);
    const secondEvent = events.find((event) => event.subjectResourceId === secondModule);

    assert.ok(firstEvent);
    assert.ok(secondEvent);
    assert.ok(firstEvent.tenantSequenceNo < secondEvent.tenantSequenceNo);
  });
});

void test('resolves a lost commit acknowledgement from the durable succeeded marker', async () => {
  await databasePromise(async (database) => {
    const repository = makeActionRepository();
    const key = 'lost-acknowledgement';
    const moduleStateKey = `test.lost-ack.${tenantId}`;
    const actionRegistration = makeRegistration({
      actionKey: 'shell.test.lost-ack',
      moduleStateKey,
    });

    const uncertainTransaction = {
      transaction: async (callback, configuration) => {
        await database.executor.transaction(callback, configuration);
        throw { commitIndeterminate: true };
      },
    } satisfies Pick<ContextServiceContract['executor'], 'transaction'>;
    const uncertainExecutor: ContextServiceContract['executor'] = Object.assign(
      Object.create(database.executor),
      uncertainTransaction,
    );
    const uncertainRuntime = makeActionRuntime(
      { executor: uncertainExecutor },
      repository,
      allowedPermission,
      testOperationalScopeResolver,
      openActionRuntimeOptions,
    );
    const first = await Effect.runPromise(
      Effect.exit(
        uncertainRuntime.runAction({
          payload: { value: 'committed-with-lost-ack' },
          principal,
          registration: actionRegistration,
          transport: transport(key, moduleStateKey),
        }),
      ),
    );
    assert.equal(failureTag(first), 'ActionCommitIndeterminate');

    const resolvingRuntime = makeActionRuntime(
      database,
      repository,
      allowedPermission,
      testOperationalScopeResolver,
      openActionRuntimeOptions,
    );
    const invocations = await database.executor
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.idempotencyKey, key));
    const invocationId = invocations[0]?.actionInvocationId;
    assert.notEqual(invocationId, undefined);
    const unauthorizedResolution = await Effect.runPromise(
      Effect.exit(
        resolvingRuntime.resolveActionCommit({
          invocationId,
          principal: {
            ...principal,
            principalId: randomUUID(),
          },
        }),
      ),
    );
    const unavailableRuntime = makeActionRuntime(
      database,
      {
        ...repository,
        resolveInvocation: () =>
          Effect.fail(
            new ActionInvocationPersistenceError({
              code: 'action_invocation_persistence_failed',
              reason: 'test database unavailable',
            }),
          ),
      },
      allowedPermission,
      testOperationalScopeResolver,
      openActionRuntimeOptions,
    );
    const unavailableResolution = await Effect.runPromise(
      Effect.exit(
        unavailableRuntime.resolveActionCommit({
          invocationId,
          principal,
        }),
      ),
    );
    const committedResolution = await Effect.runPromise(
      Effect.exit(
        resolvingRuntime.resolveActionCommit({
          invocationId,
          principal,
        }),
      ),
    );
    const resolved = await Effect.runPromise(
      Effect.exit(
        resolvingRuntime.runAction({
          payload: { value: 'committed-with-lost-ack' },
          principal,
          registration: actionRegistration,
          transport: transport(key, moduleStateKey),
        }),
      ),
    );
    const states = await database.executor
      .select()
      .from(tenantModuleStates)
      .where(eq(tenantModuleStates.moduleKey, moduleStateKey));

    assert.equal(failureTag(committedResolution), 'ActionAlreadyCommitted');
    assert.equal(failureTag(unauthorizedResolution), 'ActionInvocationNotFound');
    assert.equal(failureTag(unavailableResolution), 'ActionCommitIndeterminate');
    assert.equal(failureTag(resolved), 'ActionAlreadyCommitted');
    assert.equal(invocations[0]?.status, 'succeeded');
    assert.equal(states.length, 1);

    const openKey = 'lost-acknowledgement-open';
    const openModuleStateKey = `test.lost-ack-open.${tenantId}`;
    const openRegistration = makeRegistration({
      actionKey: 'shell.test.lost-ack-open',
      moduleStateKey: openModuleStateKey,
    });
    const uncertainRollbackTransaction = {
      transaction: async (callback, configuration) => {
        try {
          return await database.executor.transaction(async (transaction) => {
            await callback(transaction);
            throw new Error('force rollback after the transaction body');
          }, configuration);
        } catch {
          throw Object.assign(new Error('commit acknowledgement lost'), {
            commitIndeterminate: true,
          });
        }
      },
    } satisfies Pick<ContextServiceContract['executor'], 'transaction'>;
    const uncertainRollbackExecutor: ContextServiceContract['executor'] = Object.assign(
      Object.create(database.executor),
      uncertainRollbackTransaction,
    );
    const uncertainOpenRuntime = makeActionRuntime(
      { executor: uncertainRollbackExecutor },
      repository,
      allowedPermission,
      testOperationalScopeResolver,
      openActionRuntimeOptions,
    );
    const openFirst = await Effect.runPromise(
      Effect.exit(
        uncertainOpenRuntime.runAction({
          payload: { value: 'rolled-back-with-lost-ack' },
          principal,
          registration: openRegistration,
          transport: transport(openKey, openModuleStateKey),
        }),
      ),
    );
    assert.equal(failureTag(openFirst), 'ActionCommitIndeterminate');

    const openInvocations = await database.executor
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.idempotencyKey, openKey));
    const openInvocationId = openInvocations[0]?.actionInvocationId;
    assert.notEqual(openInvocationId, undefined);
    const openResolution = await Effect.runPromise(
      resolvingRuntime.resolveActionCommit({
        invocationId: openInvocationId,
        principal,
      }),
    );
    const openResolved = await Effect.runPromise(
      resolvingRuntime.runAction({
        payload: { value: 'rolled-back-with-lost-ack' },
        principal,
        registration: openRegistration,
        transport: transport(openKey, openModuleStateKey),
      }),
    );
    const openStates = await database.executor
      .select()
      .from(tenantModuleStates)
      .where(eq(tenantModuleStates.moduleKey, openModuleStateKey));

    assert.equal(openResolution._tag, 'ActionCommitOpen');
    assert.equal(openResolved.value, 'rolled-back-with-lost-ack');
    assert.equal(openStates.length, 1);
  });
});

void test('persists no invocation or evidence for every non-writable business module state', async () => {
  await databasePromise(async (database) => {
    const moduleKey = 'inventory.state-matrix';
    await database.executor
      .insert(tenantModuleStates)
      .values({ moduleKey, state: 'active', tenantId })
      .onConflictDoNothing();
    let handlerExecutions = 0;
    const action = defineAction(
      {
        accessEvidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'inventory.state-matrix.write.v1',
        },
        actionKey: 'inventory.state-matrix.write',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
          entrypointKey: 'inventory.state-matrix.write',
          moduleKey,
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: moduleKey,
        payloadSchema: Schema.Void,
        policies: [],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () =>
        Effect.sync(() => {
          handlerExecutions += 1;
        }),
    );
    const runtime = makeActionRuntime(
      database,
      makeActionRepository(),
      allowedPermission,
      testOperationalScopeResolver,
      liveModuleStateOptions(database),
    );
    await Effect.runPromise(
      runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport('module-state-active'),
      }),
    );
    assert.equal(handlerExecutions, 1);

    for (const [index, state] of (
      ['inactive', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived'] as const
    ).entries()) {
      await database.executor
        .update(tenantModuleStates)
        .set({ state })
        .where(
          and(
            eq(tenantModuleStates.tenantId, tenantId),
            eq(tenantModuleStates.moduleKey, moduleKey),
          ),
        );
      const idempotencyKey = `module-state-denied-${index}`;
      const exit = await Effect.runPromise(
        Effect.exit(
          runtime.runAction({
            payload: undefined,
            principal,
            registration: action,
            transport: transport(idempotencyKey),
          }),
        ),
      );
      assert.equal(failureTag(exit), 'ModuleStateDeniedError', state);
      const invocations = await database.executor
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.idempotencyKey, idempotencyKey));
      assert.equal(invocations.length, 0, state);
    }

    await database.executor
      .delete(tenantModuleStates)
      .where(
        and(eq(tenantModuleStates.tenantId, tenantId), eq(tenantModuleStates.moduleKey, moduleKey)),
      );
    const missingExit = await Effect.runPromise(
      Effect.exit(
        runtime.runAction({
          payload: undefined,
          principal,
          registration: action,
          transport: transport('module-state-missing'),
        }),
      ),
    );
    assert.equal(failureTag(missingExit), 'ModuleStateDeniedError');
    assert.equal(handlerExecutions, 1);
  });
});
