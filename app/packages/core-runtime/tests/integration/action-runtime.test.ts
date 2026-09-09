import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { Cause, Deferred, Effect, Layer, Exit, Fiber, Option, Schema, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';
import { ConnectionError, SqlError, UnknownError } from 'effect/unstable/sql/SqlError';

import type { ActionHandlerContext } from '../../src/actions/context.ts';
import { defineAction } from '../../src/actions/definition.ts';
import { ActionInvocationPersistenceError } from '../../src/actions/errors.ts';
import { createDomainEventReference } from '../../src/actions/events.ts';
import type { ActionPolicy } from '../../src/actions/policy.ts';
import { defineGlobalPolicy, defineMicroverticalPolicy, denyPolicy } from '../../src/actions/policy.ts';
import { makeActionRepository } from '../../src/actions/repository.ts';
import { makeActionRuntime } from '../../src/actions/runtime.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
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
import type { ScopedTransactionExecutor } from '../../src/db/scoped-transaction.ts';
import { changeTenantModuleStateAction } from '../../src/modules/actions/change-tenant-module-state.action.ts';
import type { InstalledModuleCatalog } from '../../src/modules/catalog.ts';
import { InstalledModuleCatalogService } from '../../src/modules/catalog.ts';
import type { OntosModuleDeploymentContract } from '../../src/modules/manifest.ts';
import { makeModuleEntrypointGateway } from '../../src/modules/module-entrypoint-gateway.ts';
import { defineSystemModuleEntrypoint, defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { makeModuleStateGate } from '../../src/modules/module-state-gate.ts';
import {
  TenantModuleStateService,
  makeTenantModuleStateService,
} from '../../src/modules/tenant-module-state-service.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../support/action-runtime-options.ts';
import { makeFaultInjectableCoreDatabase, TestQueryHook } from '../support/database-faults.ts';

const TestPersistenceErrorContract = Schema.TaggedStruct('TestPersistenceError', {
  reason: Schema.String,
});
type TestPersistenceErrorSelf = typeof TestPersistenceErrorContract.Type;
const TestPersistenceError = Schema.TaggedError<TestPersistenceErrorSelf>()('TestPersistenceError', {
  reason: Schema.String,
});

const TestDomainRejectedContract = Schema.TaggedStruct('TestDomainRejected', {
  reason: Schema.String,
});
type TestDomainRejectedSelf = typeof TestDomainRejectedContract.Type;
const TestDomainRejected = Schema.TaggedError<TestDomainRejectedSelf>()('TestDomainRejected', {
  reason: Schema.String,
});

const TestStateIdSchema = Schema.String.pipe(Schema.brand('TestStateId'));
const ActionPolicyDeniedFailureSchema = Schema.TaggedStruct('ActionPolicyDenied', {
  policyReasonCode: Schema.String,
  reason: Schema.String,
});
const decodeActionPolicyDeniedFailure = Schema.decodeUnknownOption(ActionPolicyDeniedFailureSchema);

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

const inventoryStockContract: OntosModuleDeploymentContract = makeModuleContractFixture({
  appId: 'inventory-stock',
  buildMarker: 'integration-test',
  description: 'Inventory integration fixture',
  displayName: 'Inventory',
  moduleId: 'inventory.stock',
  supportedStates: ['inactive', 'active', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived'],
});

const inventoryInstalledCatalog: InstalledModuleCatalog = Object.freeze({
  contracts: Object.freeze([inventoryStockContract]),
  deploymentAppIds: Object.freeze(['inventory-stock']),
  deploymentStatuses: Object.freeze([
    {
      appId: 'inventory-stock',
      moduleId: 'inventory.stock',
      status: 'available' as const,
    },
  ]),
  getByDeploymentAppId: (appId: string) => (appId === 'inventory-stock' ? inventoryStockContract : undefined),
  getByModuleId: (moduleId: string) => (moduleId === 'inventory.stock' ? inventoryStockContract : undefined),
  moduleIds: Object.freeze(['inventory.stock']),
  outboxSubscriptions: Object.freeze([]),
});

const allowedPermission = {
  checkActionPermission: () => Effect.succeed('allowed' as const),
};

const withDatabase = <Value, Error, Requirements>(
  execute: (database: ContextServiceContract) => Effect.Effect<Value, Error, Requirements>,
) =>
  Effect.scoped(
    Effect.gen(function* databaseScope() {
      const configuration = yield* loadDatabaseConfig();
      const database = yield* makeFaultInjectableCoreDatabase(configuration);
      return yield* execute(database);
    }),
  );

type ContextServiceContract = Parameters<typeof makeActionRuntime>[0];

const withTransactionOverride = (
  database: ContextServiceContract,
  override: Pick<ContextServiceContract['executor'], 'transaction'>,
): ContextServiceContract => ({
  executor: Object.assign(Object.create(database.executor), override),
});

const invocationEvidence = (database: ContextServiceContract, key: string) =>
  Effect.gen(function* readInvocationEvidence() {
    const [invocation] = yield* database.executor
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.idempotencyKey, key));
    expect(invocation).toBeDefined();
    if (invocation === undefined) {
      throw new Error('Expected invocation');
    }
    const audits = yield* database.executor
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actionInvocationId, invocation.actionInvocationId));
    return { audits, invocation };
  });

const EvidencePersistenceStageSchema = Schema.Literals([
  'audit',
  'data-access',
  'domain-event',
  'invocation-success',
  'outbox',
]);
type EvidencePersistenceStage = typeof EvidencePersistenceStageSchema.Type;

const withEvidencePersistenceFailure = (
  database: ContextServiceContract,
  stage: EvidencePersistenceStage,
): ContextServiceContract => {
  const transactionOverride = {
    transaction: (transactionBody) =>
      database.executor.transaction((transaction) => {
        const table = {
          audit: 'audit_events',
          'data-access': 'data_access_events',
          'domain-event': 'domain_events',
          'invocation-success': 'action_invocations',
          outbox: 'outbox_messages',
        }[stage];
        const operation = stage === 'invocation-success' ? 'update' : 'insert into';
        return transactionBody(transaction).pipe(
          Effect.provideService(TestQueryHook, (statement) =>
            statement.startsWith(`${operation} "core"."${table}"`)
              ? Effect.fail(
                  new SqlError({
                    reason: new UnknownError({
                      cause: new Error('Injected SQL failure'),
                      message: `Injected ${stage} persistence failure`,
                    }),
                  }),
                )
              : Effect.void,
          ),
        );
      }),
  } satisfies Pick<ContextServiceContract['executor'], 'transaction'>;
  return withTransactionOverride(database, transactionOverride);
};

const liveModuleStateOptions = (database: ContextServiceContract) => {
  const moduleStateGate = makeModuleStateGate(makeTenantModuleStateService(database));
  return {
    ...openActionRuntimeOptions,
    moduleEntrypointGateway: makeModuleEntrypointGateway(moduleStateGate),
    moduleStateGate,
  };
};

const prepare = (() =>
  withDatabase(
    Effect.fn(function* integrationProgram1(database) {
      yield* database.executor.insert(tenants).values({
        defaultLocale: 'en',
        name: 'Action Runtime Integration',
        slug: `action-runtime-${tenantId}`,
        status: 'active',
        tenantId,
      });
      yield* database.executor.insert(legalEntities).values({
        legalEntityId,
        legalName: 'Action Runtime Integration',
        registrationCountry: 'CZ',
        registrationNumber: tenantId,
        status: 'active',
        tenantId,
      });
      yield* database.executor.insert(principals).values({
        displayName: 'Action Runtime Integration',
        kind: 'human',
        principalId,
        status: 'active',
        tenantId,
      });
      yield* database.executor.insert(principalAuthBindings).values({
        principalAuthBindingId: authBindingId,
        principalId,
        provider: 'better_auth',
        providerSubjectId: `action-runtime-${principalId}`,
        status: 'active',
        subjectType: 'user',
        tenantId,
      });
      yield* database.executor.insert(tenantModuleStates).values({
        moduleKey: 'inventory.stock',
        state: 'active',
        tenantId,
      });
    }),
  ))();

const cleanup = (() =>
  withDatabase(
    Effect.fn(function* integrationProgram2(database) {
      yield* Effect.forEach(
        [
          outboxMessages,
          domainEvents,
          dataAccessEvents,
          auditEvents,
          tenantModuleStateChanges,
          tenantModuleStates,
          actionInvocations,
          principalAuthBindings,
          principals,
          legalEntities,
          tenants,
        ],
        (table) => database.executor.delete(table).where(eq(table.tenantId, tenantId)),
        { discard: true },
      );
    }),
  ))();

const TestDomainEvents = {
  'test-state.changed': Schema.Struct({ value: Schema.String }),
};

interface TestActionServices {
  readonly transaction: ScopedTransactionExecutor;
}
type TestActionContext = ActionHandlerContext<typeof TestDomainEvents, TestActionServices>;

interface RegistrationOptions {
  readonly actionKey: string;
  readonly completionGate?: Deferred.Deferred<null>;
  readonly mode?: 'orphan-outbox' | 'reject' | 'success';
  readonly moduleStateKey: string;
  readonly onExecute?: () => void;
  readonly onExecuteEffect?: Effect.Effect<unknown>;
  readonly policies?: readonly ActionPolicy<{ readonly value: string }, 'core.shell'>[];
}

const makeRegistration = ({
  actionKey,
  completionGate,
  mode = 'success',
  moduleStateKey,
  onExecute,
  onExecuteEffect,
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
        authorization: {
          kind: 'action_execution',
          provisioning: 'tenant_membership_default',
        },
        entrypointKey: actionKey,
        moduleKey: 'core.shell',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'core.shell',
      payloadSchema: Schema.Struct({ value: Schema.String }),
      policies,
      resultSchema: Schema.Struct({
        stateId: TestStateIdSchema,
        value: Schema.String,
      }),
      schemaVersion: '1',
    },
    Effect.fn(function* integrationHandler(payload, context: TestActionContext) {
      onExecute?.();
      if (onExecuteEffect !== undefined) {
        yield* onExecuteEffect;
      }
      const inserted = yield* context.services.transaction
        .insert(tenantModuleStates)
        .values({
          moduleKey: moduleStateKey,
          state: 'active',
          tenantId: context.scope.tenantId,
        })
        .returning({
          tenantModuleStateId: tenantModuleStates.tenantModuleStateId,
        })
        .pipe(Effect.mapError(() => new TestPersistenceError({ reason: 'test business write failed' })));

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

      if (completionGate !== undefined) {
        yield* Deferred.await(completionGate);
      }
      if (mode === 'reject') {
        return yield* new TestDomainRejected({
          reason: 'test domain rejection',
        });
      }

      const [row] = inserted;
      if (row === undefined) {
        return yield* new TestPersistenceError({
          reason: 'test write returned no row',
        });
      }
      return {
        stateId: TestStateIdSchema.make(row.tenantModuleStateId),
        value: payload.value,
      };
    }),
    (transaction) => Effect.succeed({ transaction }),
  );

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const hasFailure = <Error>(exit: Exit.Exit<unknown, Error>, tag: string): boolean =>
  Exit.isFailure(exit) && Option.exists(Cause.findErrorOption(exit.cause), Predicate.isTagged(tag));

const testProgram1 = () =>
  withDatabase(
    Effect.fn(function* integrationProgram3(database) {
      yield* database.executor
        .update(tenantModuleStates)
        .set({ state: 'active' })
        .where(eq(tenantModuleStates.moduleKey, 'inventory.stock'));

      const policyReached = yield* Deferred.make<null>();
      const continuePolicy = yield* Deferred.make<null>();
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
            authorization: {
              kind: 'action_execution',
              provisioning: 'tenant_membership_default',
            },
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
              evaluate: Effect.fn(function* pauseBetweenGates() {
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
      const firstAttempt = yield* Effect.forkScoped(
        Effect.exit(
          runtime.runAction({
            payload: undefined,
            principal,
            registration: action,
            transport: transport('business-module-concurrent-gate'),
          }),
        ),
      );
      yield* Deferred.await(policyReached);
      yield* runtime
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
        );
      yield* Deferred.succeed(continuePolicy, null);
      const denied = yield* Fiber.join(firstAttempt);
      expect(hasFailure(denied, 'ModuleStateDeniedError')).toBe(true);
      expect(handlerExecutions).toBe(0);

      const [openInvocation] = yield* database.executor
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.idempotencyKey, 'business-module-concurrent-gate'));
      expect(openInvocation).toBeDefined();
      if (openInvocation === undefined) {
        throw new Error('Expected openInvocation');
      }
      expect(openInvocation.completedAt).toBe(null);
      const deniedEvidence = yield* database.executor
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.actionInvocationId, openInvocation.actionInvocationId));
      expect(deniedEvidence.length).toBe(0);

      yield* runtime
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
        );
      yield* runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport('business-module-concurrent-gate'),
      });
      expect(handlerExecutions).toBe(1);
    }),
  );

const testProgram2 = Effect.fn(function* integrationProgram4() {
  const key = 'atomic-success';
  const moduleStateKey = `test.${key}.${tenantId}`;

  yield* withDatabase(
    Effect.fn(function* integrationProgram5(database) {
      const runtime = makeActionRuntime(
        database,
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions,
      );
      const result = yield* runtime.runAction({
        payload: { value: 'committed' },
        principal,
        registration: makeRegistration({
          actionKey: 'shell.test.atomic-success',
          moduleStateKey,
        }),
        transport: transport(key, moduleStateKey),
      });

      const [states, invocations, audits, accesses, events, messages] = yield* Effect.all([
        database.executor.select().from(tenantModuleStates).where(eq(tenantModuleStates.moduleKey, moduleStateKey)),
        database.executor.select().from(actionInvocations).where(eq(actionInvocations.idempotencyKey, key)),
        database.executor.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantId)),
        database.executor.select().from(dataAccessEvents).where(eq(dataAccessEvents.tenantId, tenantId)),
        database.executor.select().from(domainEvents).where(eq(domainEvents.subjectResourceId, moduleStateKey)),
        database.executor.select().from(outboxMessages).where(eq(outboxMessages.tenantId, tenantId)),
      ]);

      expect(result.value).toBe('committed');
      expect(states.length).toBe(1);
      expect(invocations[0]?.status).toBe('succeeded');
      expect(invocations[0]?.completedAt).toBeTruthy();
      expect(audits.filter((row) => row.actionInvocationId === invocations[0]?.actionInvocationId).length).toBe(1);
      expect(accesses.filter((row) => row.actionInvocationId === invocations[0]?.actionInvocationId).length).toBe(1);
      expect(events.length).toBe(1);
      expect(messages.filter((row) => row.domainEventId === events[0]?.domainEventId).length).toBe(1);
      expect((events[0]?.tenantSequenceNo ?? 0) > 0).toBe(true);
    }),
  );
});

const testProgram3 = Effect.fn(function* integrationProgram6() {
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

  yield* withDatabase(
    Effect.fn(function* integrationProgram7(database) {
      const runtime = makeActionRuntime(
        database,
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions,
      );
      yield* runtime.runAction({
        payload: { value: 'committed' },
        principal,
        registration: makeRegistration({
          actionKey: 'shell.test.policy-allowed',
          moduleStateKey,
          onExecute: () => observed.push('handler'),
          policies: [policy],
        }),
        transport: transport(key, moduleStateKey),
      });

      const { audits, invocation } = yield* invocationEvidence(database, key);

      expect(observed).toEqual(['policy', 'handler']);
      expect(invocation.status).toBe('succeeded');
      expect(audits.length).toBe(2);
      const policyAudit = audits.find((row) => row.eventType === 'action.policy_checked');
      const executionAudit = audits.find((row) => row.eventType === 'action.executed');
      expect(policyAudit?.outcome).toBe('allowed');
      expect(policyAudit?.outcomeStage).toBe('policy');
      expect(executionAudit?.outcome).toBe('succeeded');
      expect(executionAudit?.outcomeStage).toBe('execution');
      expect(encodeJson(policyAudit?.evidenceJson).includes('committed')).toBe(false);
      expect(encodeJson(policyAudit?.evidenceJson).includes(policy.policyKey)).toBe(true);
    }),
  );
});

const testProgram4 = Effect.fn(function* integrationProgram8() {
  const scenarios = [
    {
      actionKey: 'shell.test.policy-denied-global',
      key: 'policy-denied-global',
      makeRegistration(handler: () => void) {
        const policy = defineGlobalPolicy<{ readonly value: string }>({
          evaluate: () => Effect.fail(denyPolicy('tenant_suspended', 'This tenant is suspended — contact support')),
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
          evaluate: () => Effect.fail(denyPolicy('stock_locked', 'Stock is locked for reconciliation')),
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
            resultSchema: Schema.Struct({
              stateId: TestStateIdSchema,
              value: Schema.String,
            }),
            schemaVersion: '1',
          },
          (payload, _context: TestActionContext) => {
            handler();
            return Effect.succeed({
              stateId: TestStateIdSchema.make('unreachable'),
              value: payload.value,
            });
          },
          (transaction) => Effect.succeed({ transaction }),
        );
      },
      reason: 'Stock is locked for reconciliation',
      reasonCode: 'stock_locked',
    },
  ] as const;

  yield* withDatabase(
    Effect.fn(function* integrationProgram9(database) {
      const runtime = makeActionRuntime(
        database,
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions,
      );
      yield* Effect.forEach(
        scenarios,
        Effect.fn(function* integrationProgram10(scenario) {
          let handlerExecutions = 0;
          const beforeMessages = yield* database.executor
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
          const exit = yield* Effect.exit(actionEffect);
          const failure = Exit.isFailure(exit)
            ? Option.flatMap(Cause.findErrorOption(exit.cause), decodeActionPolicyDeniedFailure)
            : Option.none();
          expect(hasFailure(exit, 'ActionPolicyDenied')).toBe(true);
          if (Option.isSome(failure)) {
            expect(failure.value.reason).toBe(scenario.reason);
            expect(failure.value.policyReasonCode).toBe(scenario.reasonCode);
          }
          expect(handlerExecutions).toBe(0);

          const [invocation] = yield* database.executor
            .select()
            .from(actionInvocations)
            .where(eq(actionInvocations.idempotencyKey, scenario.key));
          expect(invocation).toBeDefined();
          if (invocation === undefined) {
            throw new Error('Expected invocation');
          }
          const [audits, accesses, events, states] = yield* Effect.all([
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
          const messages = yield* database.executor
            .select()
            .from(outboxMessages)
            .where(eq(outboxMessages.tenantId, tenantId));

          expect(invocation.status).toBe('rejected');
          expect(invocation.completedAt).toBeTruthy();
          expect(audits.length).toBe(2);
          for (const eventType of ['action.policy_checked', 'action.rejected']) {
            const audit = audits.find((row) => row.eventType === eventType);
            expect(audit?.outcome).toBe('denied');
            expect(audit?.outcomeStage).toBe('policy');
            expect(audit?.outcomeCode).toBe(scenario.reasonCode);
          }
          expect(encodeJson(audits).includes(scenario.reason)).toBe(false);
          expect(accesses.length).toBe(0);
          expect(events.length).toBe(0);
          expect(states.length).toBe(0);
          expect(messages.length).toBe(beforeMessages.length);
        }),
        { discard: true },
      );
    }),
  );
});

const testProgram5 = Effect.fn(function* integrationProgram11() {
  const policy = defineGlobalPolicy<{ readonly value: string }>({
    evaluate: () => Effect.fail(denyPolicy('blocked', 'This operation is blocked')),
    policyKey: 'global.blocked.v1',
  });

  yield* withDatabase(
    Effect.fn(function* integrationProgram12(database) {
      const stages = ['audit', 'invocation-success'] as const;
      yield* Effect.forEach(
        stages,
        Effect.fn(function* integrationProgram13(stage) {
          const key = `policy-finalization-${stage}`;
          let handlerExecutions = 0;
          const runtime = makeActionRuntime(
            withEvidencePersistenceFailure(database, stage),
            makeActionRepository(),
            allowedPermission,
            testOperationalScopeResolver,
            openActionRuntimeOptions,
          );
          const exit = yield* Effect.exit(
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
          );
          const { audits, invocation } = yield* invocationEvidence(database, key);

          expect(
            hasFailure(exit, 'ActionInvocationPersistenceError'),
            Exit.isFailure(exit) ? Cause.pretty(exit.cause) : 'success',
          ).toBeTruthy();
          expect(handlerExecutions).toBe(0);
          expect(invocation.status).toBe('received');
          expect(invocation.completedAt).toBe(null);
          expect(audits.length).toBe(0);
        }),
        { discard: true },
      );
    }),
  );
});

const testProgram6 = Effect.fn(function* integrationProgram14() {
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

  yield* withDatabase((database) =>
    Effect.forEach(
      scenarios,
      Effect.fn(function* integrationProgram15(scenario) {
        const moduleStateKey = `test.${scenario.key}.${tenantId}`;
        const runtime = makeActionRuntime(
          scenario.key === 'evidence-failure' ? withEvidencePersistenceFailure(database, 'audit') : database,
          makeActionRepository(),
          allowedPermission,
          testOperationalScopeResolver,
          openActionRuntimeOptions,
        );
        const exit = yield* Effect.exit(
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
        );

        const states = yield* database.executor
          .select()
          .from(tenantModuleStates)
          .where(eq(tenantModuleStates.moduleKey, moduleStateKey));
        const invocations = yield* database.executor
          .select()
          .from(actionInvocations)
          .where(eq(actionInvocations.idempotencyKey, scenario.key));
        const invocationId = invocations[0]?.actionInvocationId;
        const committedEvidence =
          invocationId === undefined
            ? []
            : yield* database.executor
                .select()
                .from(auditEvents)
                .where(eq(auditEvents.actionInvocationId, invocationId));
        const committedAccesses =
          invocationId === undefined
            ? []
            : yield* database.executor
                .select()
                .from(dataAccessEvents)
                .where(eq(dataAccessEvents.actionInvocationId, invocationId));
        const committedEvents =
          invocationId === undefined
            ? []
            : yield* database.executor
                .select()
                .from(domainEvents)
                .where(eq(domainEvents.actionInvocationId, invocationId));

        expect(hasFailure(exit, scenario.expectedTag)).toBe(true);
        expect(states.length).toBe(0);
        expect(invocations[0]?.status).toBe('running');
        expect(invocations[0]?.completedAt).toBe(null);
        expect(committedEvidence.length).toBe(0);
        expect(committedAccesses.length).toBe(0);
        expect(committedEvents.length).toBe(0);
      }),
      { discard: true },
    ),
  );
});

const testProgram7 = Effect.fn(function* integrationProgram16() {
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

  yield* withDatabase((database) =>
    Effect.forEach(
      stages,
      Effect.fn(function* integrationProgram17(stage) {
        const key = `evidence-${stage}`;
        const moduleStateKey = `test.${key}.${tenantId}`;
        const beforeOutbox = yield* database.executor
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
        const exit = yield* Effect.exit(
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
        );

        const states = yield* database.executor
          .select()
          .from(tenantModuleStates)
          .where(eq(tenantModuleStates.moduleKey, moduleStateKey));
        const [invocation] = yield* database.executor
          .select()
          .from(actionInvocations)
          .where(eq(actionInvocations.idempotencyKey, key));
        expect(invocation).not.toBe(undefined);
        const invocationId = invocation?.actionInvocationId ?? '';
        const [audits, accesses, events, afterOutbox] = yield* Effect.all([
          database.executor.select().from(auditEvents).where(eq(auditEvents.actionInvocationId, invocationId)),
          database.executor
            .select()
            .from(dataAccessEvents)
            .where(eq(dataAccessEvents.actionInvocationId, invocationId)),
          database.executor.select().from(domainEvents).where(eq(domainEvents.actionInvocationId, invocationId)),
          database.executor.select().from(outboxMessages).where(eq(outboxMessages.tenantId, tenantId)),
        ]);

        expect(hasFailure(exit, 'ActionTransactionError'), stage).toBe(true);
        expect(states.length, stage).toBe(0);
        expect(invocation?.status, stage).toBe('running');
        expect(invocation?.completedAt, stage).toBe(null);
        expect(audits.length, stage).toBe(0);
        expect(accesses.length, stage).toBe(0);
        expect(events.length, stage).toBe(0);
        expect(afterOutbox.length, stage).toBe(beforeOutbox.length);
      }),
      { discard: true },
    ),
  );
});

const testProgram8 = () =>
  withDatabase(
    Effect.fn(function* integrationProgram18(database) {
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
      const first = yield* Effect.exit(runtime.runAction(input));
      const retry = yield* Effect.exit(runtime.runAction(input));
      const { audits, invocation } = yield* invocationEvidence(database, key);

      expect(hasFailure(first, 'ActionPolicyDenied')).toBe(true);
      expect(hasFailure(retry, 'ActionInvocationStateError')).toBe(true);
      expect(evaluations).toBe(1);
      expect(handlerExecutions).toBe(0);
      expect(invocation.status).toBe('rejected');
      expect(audits.length).toBe(2);

      let concurrentEvaluations = 0;
      const concurrentKey = 'policy-terminal-concurrent';
      const concurrentPoliciesReached = yield* Deferred.make<null>();
      const concurrentPolicy = defineGlobalPolicy<{ readonly value: string }>({
        evaluate: Effect.fn(function* delayedDenial() {
          concurrentEvaluations += 1;
          if (concurrentEvaluations === 2) {
            yield* Deferred.succeed(concurrentPoliciesReached, null);
          }
          yield* Deferred.await(concurrentPoliciesReached);
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
      const concurrent = yield* Effect.all(
        [Effect.exit(runtime.runAction(concurrentInput)), Effect.exit(runtime.runAction(concurrentInput))],
        { concurrency: 'unbounded' },
      );
      const [concurrentInvocation] = yield* database.executor
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.idempotencyKey, concurrentKey));
      expect(concurrentInvocation).toBeDefined();
      if (concurrentInvocation === undefined) {
        throw new Error('Expected concurrentInvocation');
      }
      const concurrentAudits = yield* database.executor
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.actionInvocationId, concurrentInvocation.actionInvocationId));

      expect(concurrent.length).toBe(2);
      for (const outcome of concurrent) {
        expect(hasFailure(outcome, 'ActionPolicyDenied')).toBe(true);
      }
      expect(concurrentEvaluations).toBe(2);
      expect(handlerExecutions).toBe(0);
      expect(concurrentInvocation.status).toBe('rejected');
      expect(concurrentAudits.length).toBe(2);
    }),
  );

const testProgram9 = () =>
  withDatabase(
    Effect.fn(function* integrationProgram19(database) {
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
      const handlerStarted = yield* Deferred.make<null>();
      const denialEvaluated = yield* Deferred.make<null>();
      const key = 'policy-loses-to-success';
      const moduleStateKey = `test.${key}.${tenantId}`;
      const actionKey = 'shell.test.policy-loses-to-success';
      const allowed = makeRegistration({
        actionKey,
        completionGate: denialEvaluated,
        moduleStateKey,
        onExecuteEffect: Deferred.succeed(handlerStarted, null),
      });
      const denial = defineGlobalPolicy<{ readonly value: string }>({
        evaluate: () =>
          Deferred.succeed(denialEvaluated, null).pipe(
            Effect.andThen(Effect.fail(denyPolicy('late_denial', 'This denial arrived too late'))),
          ),
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

      const success = yield* Effect.forkScoped(allowedRuntime.runAction({ ...sharedInput, registration: allowed }));
      yield* Deferred.await(handlerStarted);
      const rejected = yield* Effect.forkScoped(
        Effect.exit(deniedRuntime.runAction({ ...sharedInput, registration: denied })),
      );
      const [successResult, rejectedExit] = yield* Effect.all([Fiber.join(success), Fiber.join(rejected)], {
        concurrency: 'unbounded',
      });
      const { audits, invocation } = yield* invocationEvidence(database, key);

      expect(successResult.value).toBe('same');
      expect(hasFailure(rejectedExit, 'ActionInvocationPersistenceError')).toBe(true);
      expect(invocation.status).toBe('succeeded');
      expect(audits.filter((row) => row.eventType === 'action.rejected').length).toBe(0);
    }),
  );

const testProgram10 = () =>
  withDatabase(
    Effect.fn(function* concurrencyProof(database) {
      const handlerStarted = yield* Deferred.make<null>();
      const handlerRelease = yield* Deferred.make<null>();
      const secondPermissionChecked = yield* Deferred.make<null>();
      let permissionChecks = 0;
      const concurrentAllowedPermission = {
        checkActionPermission: Effect.fn(function* recordPermissionCheck() {
          permissionChecks += 1;
          if (permissionChecks === 2) {
            yield* Deferred.succeed(secondPermissionChecked, null);
          }
          return 'allowed' as const;
        }),
      };
      const runtime = makeActionRuntime(
        database,
        makeActionRepository(),
        concurrentAllowedPermission,
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
          completionGate: handlerRelease,
          moduleStateKey: concurrentModule,
          onExecute: () => {
            executions += 1;
          },
          onExecuteEffect: Deferred.succeed(handlerStarted, null),
        }),
        transport: transport(concurrentKey, concurrentModule),
      };
      const firstAttempt = yield* Effect.exit(runtime.runAction(concurrentInput)).pipe(Effect.forkChild);
      yield* Deferred.await(handlerStarted);
      const secondAttempt = yield* Effect.exit(runtime.runAction(concurrentInput)).pipe(Effect.forkChild);
      yield* Deferred.await(secondPermissionChecked);
      yield* Deferred.succeed(handlerRelease, null);
      const concurrentResults = yield* Effect.all([Fiber.join(firstAttempt), Fiber.join(secondAttempt)]);

      expect(executions).toBe(1);
      expect(concurrentResults.filter(Exit.isSuccess).length).toBe(1);
      const failedResults = concurrentResults.filter(Exit.isFailure);
      expect(failedResults.length).toBe(1);
      for (const outcome of failedResults) {
        expect(hasFailure(outcome, 'ActionAlreadyCommitted')).toBe(true);
      }

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
      expect(hasFailure(committedRetry, 'ActionAlreadyCommitted')).toBe(true);
      expect(executions).toBe(1);

      const conflict = yield* Effect.exit(
        runtime.runAction({
          ...concurrentInput,
          payload: { value: 'different' },
        }),
      );
      expect(hasFailure(conflict, 'ActionRequestHashConflict')).toBe(true);

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
      expect(hasFailure(rejected, 'TestDomainRejected')).toBe(true);

      const retried = yield* runtime.runAction({
        payload: { value: 'retryable' },
        principal,
        registration: makeRegistration({
          actionKey: 'shell.test.open-retry',
          moduleStateKey: openModule,
        }),
        transport: transport(openKey, openModule),
      });
      expect(retried.value).toBe('retryable');
    }),
  );

const testProgram11 = () =>
  withDatabase(
    Effect.fn(function* integrationProgram20(database) {
      const firstCommitRelease = yield* Deferred.make<null>();
      const firstFlushed = yield* Deferred.make<null>();
      const secondInsertStarted = yield* Deferred.make<null>();
      const delayedTransaction = {
        transaction: (transactionBody) =>
          database.executor.transaction(
            Effect.fn(function* delayCommit(transaction) {
              const result = yield* transactionBody(transaction);
              yield* Deferred.succeed(firstFlushed, null);
              yield* Deferred.await(firstCommitRelease);
              return result;
            }),
          ),
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

      const first = yield* Effect.forkScoped(
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
      yield* Deferred.await(firstFlushed);

      let secondCompleted = false;
      const second = yield* Effect.forkScoped(
        secondRuntime
          .runAction({
            payload: { value: 'second' },
            principal,
            registration: makeRegistration({
              actionKey: 'shell.test.sequence-second',
              moduleStateKey: secondModule,
            }),
            transport: transport('sequence-second', secondModule),
          })
          .pipe(
            Effect.provideService(TestQueryHook, () => Deferred.succeed(secondInsertStarted, null).pipe(Effect.asVoid)),
            Effect.ensuring(
              Effect.sync(() => {
                secondCompleted = true;
              }),
            ),
          ),
      );

      yield* Deferred.await(secondInsertStarted);
      expect(secondCompleted).toBe(false);

      yield* Deferred.succeed(firstCommitRelease, null);
      yield* Effect.forEach([first, second], Fiber.join, {
        concurrency: 'unbounded',
      });

      const events = yield* database.executor.select().from(domainEvents).where(eq(domainEvents.tenantId, tenantId));
      const firstEvent = events.find((event) => event.subjectResourceId === firstModule);
      const secondEvent = events.find((event) => event.subjectResourceId === secondModule);

      expect(firstEvent).toBeDefined();
      if (firstEvent === undefined) {
        throw new Error('Expected firstEvent');
      }
      expect(secondEvent).toBeDefined();
      if (secondEvent === undefined) {
        throw new Error('Expected secondEvent');
      }
      expect(firstEvent.tenantSequenceNo < secondEvent.tenantSequenceNo).toBeTruthy();
    }),
  );

const testProgram12 = () =>
  withDatabase(
    Effect.fn(function* integrationProgram21(database) {
      const repository = makeActionRepository();
      const key = 'lost-acknowledgement';
      const moduleStateKey = `test.lost-ack.${tenantId}`;
      const actionRegistration = makeRegistration({
        actionKey: 'shell.test.lost-ack',
        moduleStateKey,
      });

      const acknowledgementLost = new SqlError({
        reason: new ConnectionError({ cause: { code: '08007' } }),
      });
      const uncertainTransaction = {
        transaction: (transactionBody) =>
          database.executor.transaction(transactionBody).pipe(Effect.andThen(Effect.die(acknowledgementLost))),
      } satisfies Pick<ContextServiceContract['executor'], 'transaction'>;

      const uncertainRuntime = makeActionRuntime(
        withTransactionOverride(database, uncertainTransaction),
        repository,
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions,
      );
      const first = yield* Effect.exit(
        uncertainRuntime.runAction({
          payload: { value: 'committed-with-lost-ack' },
          principal,
          registration: actionRegistration,
          transport: transport(key, moduleStateKey),
        }),
      );
      expect(hasFailure(first, 'ActionCommitIndeterminate')).toBe(true);

      const resolvingRuntime = makeActionRuntime(
        database,
        repository,
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions,
      );
      const invocations = yield* database.executor
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.idempotencyKey, key));
      const invocationId = invocations[0]?.actionInvocationId;
      expect(invocationId).not.toBe(undefined);
      const unauthorizedResolution = yield* Effect.exit(
        resolvingRuntime.resolveActionCommit({
          invocationId,
          principal: {
            ...principal,
            principalId: randomUUID(),
          },
        }),
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
      const unavailableResolution = yield* Effect.exit(
        unavailableRuntime.resolveActionCommit({
          invocationId,
          principal,
        }),
      );
      const committedResolution = yield* Effect.exit(
        resolvingRuntime.resolveActionCommit({
          invocationId,
          principal,
        }),
      );
      const resolved = yield* Effect.exit(
        resolvingRuntime.runAction({
          payload: { value: 'committed-with-lost-ack' },
          principal,
          registration: actionRegistration,
          transport: transport(key, moduleStateKey),
        }),
      );
      const states = yield* database.executor
        .select()
        .from(tenantModuleStates)
        .where(eq(tenantModuleStates.moduleKey, moduleStateKey));

      expect(hasFailure(committedResolution, 'ActionAlreadyCommitted')).toBe(true);
      expect(hasFailure(unauthorizedResolution, 'ActionInvocationNotFound')).toBe(true);
      expect(hasFailure(unavailableResolution, 'ActionCommitIndeterminate')).toBe(true);
      expect(hasFailure(resolved, 'ActionAlreadyCommitted')).toBe(true);
      expect(invocations[0]?.status).toBe('succeeded');
      expect(states.length).toBe(1);

      const openKey = 'lost-acknowledgement-open';
      const openModuleStateKey = `test.lost-ack-open.${tenantId}`;
      const openRegistration = makeRegistration({
        actionKey: 'shell.test.lost-ack-open',
        moduleStateKey: openModuleStateKey,
      });
      const uncertainRollbackTransaction = {
        transaction: (transactionBody) =>
          database.executor
            .transaction((transaction) =>
              transactionBody(transaction).pipe(
                Effect.andThen(Effect.die(new Error('force rollback after the transaction body'))),
              ),
            )
            .pipe(Effect.catchCause(() => Effect.die(acknowledgementLost))),
      } satisfies Pick<ContextServiceContract['executor'], 'transaction'>;

      const uncertainOpenRuntime = makeActionRuntime(
        withTransactionOverride(database, uncertainRollbackTransaction),
        repository,
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions,
      );
      const openFirst = yield* Effect.exit(
        uncertainOpenRuntime.runAction({
          payload: { value: 'rolled-back-with-lost-ack' },
          principal,
          registration: openRegistration,
          transport: transport(openKey, openModuleStateKey),
        }),
      );
      expect(hasFailure(openFirst, 'ActionCommitIndeterminate')).toBe(true);

      const openInvocations = yield* database.executor
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.idempotencyKey, openKey));
      const openInvocationId = openInvocations[0]?.actionInvocationId;
      expect(openInvocationId).not.toBe(undefined);
      const openResolution = yield* resolvingRuntime.resolveActionCommit({
        invocationId: openInvocationId,
        principal,
      });
      const openResolved = yield* resolvingRuntime.runAction({
        payload: { value: 'rolled-back-with-lost-ack' },
        principal,
        registration: openRegistration,
        transport: transport(openKey, openModuleStateKey),
      });
      const openStates = yield* database.executor
        .select()
        .from(tenantModuleStates)
        .where(eq(tenantModuleStates.moduleKey, openModuleStateKey));

      expect(Predicate.isTagged(openResolution, 'ActionCommitOpen')).toBe(true);
      expect(openResolved.value).toBe('rolled-back-with-lost-ack');
      expect(openStates.length).toBe(1);
    }),
  );

const testProgram13 = () =>
  withDatabase(
    Effect.fn(function* integrationProgram22(database) {
      const moduleKey = 'inventory.state-matrix';
      yield* database.executor
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
            authorization: {
              kind: 'action_execution',
              provisioning: 'tenant_membership_default',
            },
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
      yield* runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport('module-state-active'),
      });
      expect(handlerExecutions).toBe(1);

      const deniedStates = ['inactive', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived'] as const;
      yield* Effect.forEach(
        deniedStates,
        Effect.fn(function* integrationProgram23(state, index) {
          yield* database.executor
            .update(tenantModuleStates)
            .set({ state })
            .where(and(eq(tenantModuleStates.tenantId, tenantId), eq(tenantModuleStates.moduleKey, moduleKey)));
          const idempotencyKey = `module-state-denied-${index}`;
          const exit = yield* Effect.exit(
            runtime.runAction({
              payload: undefined,
              principal,
              registration: action,
              transport: transport(idempotencyKey),
            }),
          );
          expect(hasFailure(exit, 'ModuleStateDeniedError'), state).toBe(true);
          const invocations = yield* database.executor
            .select()
            .from(actionInvocations)
            .where(eq(actionInvocations.idempotencyKey, idempotencyKey));
          expect(invocations.length, state).toBe(0);
        }),
        { discard: true },
      );

      yield* database.executor
        .delete(tenantModuleStates)
        .where(and(eq(tenantModuleStates.tenantId, tenantId), eq(tenantModuleStates.moduleKey, moduleKey)));
      const missingExit = yield* Effect.exit(
        runtime.runAction({
          payload: undefined,
          principal,
          registration: action,
          transport: transport('module-state-missing'),
        }),
      );
      expect(hasFailure(missingExit, 'ModuleStateDeniedError')).toBe(true);
      expect(handlerExecutions).toBe(1);
    }),
  );

it.layer(Layer.effectDiscard(Effect.acquireRelease(prepare, () => cleanup.pipe(Effect.orDie))), {
  excludeTestServices: true,
})('Action runtime', (suite) => {
  suite.effect('rechecks business module state under the tenant lock and retries after Core recovery', testProgram1);

  suite.effect('atomically commits business state, all success evidence, and the succeeded marker', testProgram2);

  suite.effect('commits allowed Policy checkpoints atomically before handler success evidence', testProgram3);

  suite.effect(
    'atomically rejects denied global and same-owner MicroVertical Policies without handler evidence',
    testProgram4,
  );

  suite.effect('rolls back every denied-Policy finalization persistence failure', testProgram5);

  suite.effect('rolls back domain rejection, evidence persistence failure, and orphan outbox attempts', testProgram6);

  suite.effect('rolls back every individual success-evidence persistence failure', testProgram7);

  suite.effect('keeps Policy rejection terminal and deduplicates repeated and concurrent evidence', testProgram8);

  suite.effect('never lets a losing Policy denial replace a running or successful invocation', testProgram9);

  suite.effect(
    'serializes concurrent requests and enforces committed, open-retry, and hash-conflict behavior',
    testProgram10,
  );

  suite.effect('serializes Domain Event allocation by tenant commit order', testProgram11);

  suite.effect('resolves a lost commit acknowledgement from the durable succeeded marker', testProgram12);

  suite.effect('persists no invocation or evidence for every non-writable business module state', testProgram13);
});
