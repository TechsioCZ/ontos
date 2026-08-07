/* eslint-disable no-await-in-loop, promise/prefer-await-to-callbacks -- Ordered transition and transaction assertions are deliberate. */
import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Cause, Effect, Exit } from 'effect';
import type { InstalledModuleCatalog, OntosModuleDeploymentContract } from '../../src/index.ts';
import { makeActionRepository } from '../../src/actions/repository.ts';
import { makeActionRuntime } from '../../src/actions/runtime.ts';
import { makeCoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import {
  actionInvocations,
  auditEvents,
  dataAccessEvents,
  principals,
  tenantModuleStateChanges,
  tenantModuleStates,
  tenants,
} from '../../src/db/schema.ts';
import { changeTenantModuleStateAction } from '../../src/modules/actions/change-tenant-module-state.action.ts';
import { InstalledModuleCatalogService } from '../../src/modules/catalog.ts';
import {
  TenantModuleStateService,
  makeTenantModuleStateService,
} from '../../src/modules/tenant-module-state-service.ts';

const tenantOne = randomUUID();
const tenantTwo = randomUUID();
const principalOne = randomUUID();
const principalTwo = randomUUID();
const tenantIds = [tenantOne, tenantTwo] as const;

type DatabaseShape = Parameters<typeof makeActionRuntime>[0];

const installedContract = (
  moduleId: string,
  dependencies: OntosModuleDeploymentContract['manifest']['dependencies']['modules'] = [],
): OntosModuleDeploymentContract => ({
  deployment: { appId: 'test-module', buildMarker: 'test-build' },
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
    dependencies: { core: [], externalSystems: [], modules: dependencies },
    module: {
      description: 'Integration test module',
      displayName: 'Integration test module',
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

const installedCatalog: InstalledModuleCatalog = Object.freeze({
  contracts: Object.freeze([]),
  deploymentAppIds: Object.freeze([]),
  getByDeploymentAppId: () => void 0,
  getByModuleId: (moduleId: string) => installedContract(moduleId),
  moduleIds: Object.freeze([]),
  outboxSubscriptions: Object.freeze([]),
});

const catalogFrom = (
  ...contracts: readonly OntosModuleDeploymentContract[]
): InstalledModuleCatalog => {
  const byModuleId = new Map(contracts.map((item) => [item.manifest.module.id, item]));
  return Object.freeze({
    contracts: Object.freeze([...contracts]),
    deploymentAppIds: Object.freeze(contracts.map(({ deployment }) => deployment.appId)),
    getByDeploymentAppId: (appId: string) =>
      contracts.find(({ deployment }) => deployment.appId === appId),
    getByModuleId: (moduleId: string) => byModuleId.get(moduleId),
    moduleIds: Object.freeze(contracts.map(({ manifest }) => manifest.module.id)),
    outboxSubscriptions: Object.freeze([]),
  });
};

const withDatabase = <Value, Error>(
  operation: (
    database: DatabaseShape,
  ) => Effect.Effect<Value, Error, InstalledModuleCatalogService | TenantModuleStateService>,
) =>
  Effect.scoped(
    Effect.gen(function* tenantModuleStateDatabaseScope() {
      const configuration = yield* loadDatabaseConfig();
      const database = yield* makeCoreDatabase(configuration);
      return yield* operation(database).pipe(
        Effect.provideService(InstalledModuleCatalogService, {
          load: Effect.succeed(installedCatalog),
        }),
        Effect.provideService(TenantModuleStateService, makeTenantModuleStateService(database)),
      );
    }),
  );

const databasePromise = <Value>(
  operation: (database: DatabaseShape) => PromiseLike<Value>,
): Promise<Value> =>
  Effect.runPromise(withDatabase((database) => Effect.promise(() => operation(database))));

const cleanup = () =>
  databasePromise(async (database) => {
    await database.executor
      .delete(dataAccessEvents)
      .where(inArray(dataAccessEvents.tenantId, tenantIds));
    await database.executor.delete(auditEvents).where(inArray(auditEvents.tenantId, tenantIds));
    await database.executor
      .delete(tenantModuleStateChanges)
      .where(inArray(tenantModuleStateChanges.tenantId, tenantIds));
    await database.executor
      .delete(tenantModuleStates)
      .where(inArray(tenantModuleStates.tenantId, tenantIds));
    await database.executor
      .delete(actionInvocations)
      .where(inArray(actionInvocations.tenantId, tenantIds));
    await database.executor.delete(principals).where(inArray(principals.tenantId, tenantIds));
    await database.executor.delete(tenants).where(inArray(tenants.tenantId, tenantIds));
  });

before(async () => {
  await cleanup();
  await databasePromise(async (database) => {
    await database.executor.insert(tenants).values([
      {
        defaultLocale: 'en',
        name: 'Tenant module state one',
        slug: `tenant-module-state-${tenantOne}`,
        status: 'active',
        tenantId: tenantOne,
      },
      {
        defaultLocale: 'en',
        name: 'Tenant module state two',
        slug: `tenant-module-state-${tenantTwo}`,
        status: 'active',
        tenantId: tenantTwo,
      },
    ]);
    await database.executor.insert(principals).values([
      {
        displayName: 'Tenant module state principal one',
        kind: 'human',
        principalId: principalOne,
        status: 'active',
        tenantId: tenantOne,
      },
      {
        displayName: 'Tenant module state principal two',
        kind: 'human',
        principalId: principalTwo,
        status: 'active',
        tenantId: tenantTwo,
      },
    ]);
  });
});

after(cleanup);

const unconfiguredPermission = {
  checkActionPermission: () => Effect.succeed('unconfigured' as const),
};

const principal = (tenantId = tenantOne, principalId = principalOne) => ({
  authMethod: 'session' as const,
  principalId,
  tenantId,
});

const testModuleKey = (prefix: string, tenantId: string): string => `${prefix}.id-${tenantId}`;

const actionInput = (
  moduleKey: string,
  newState: (typeof changeTenantModuleStateAction.descriptor.payloadSchema)['Type']['newState'],
  idempotencyKey: string,
  trustedPrincipal = principal(),
) => ({
  payload: {
    moduleKey,
    newState,
    reason: `Integration transition to ${newState}`,
  },
  principal: trustedPrincipal,
  registration: changeTenantModuleStateAction,
  transport: {
    correlationId: `tenant-module-state-${idempotencyKey}`,
    idempotencyKey,
    targetModuleKey: moduleKey,
    targetResourceId: moduleKey,
    targetResourceType: 'tenant-module-state',
  },
});

const failureTag = <Error>(exit: Exit.Exit<unknown, Error>): string | undefined => {
  if (Exit.isSuccess(exit)) {
    return undefined;
  }
  const failure = Cause.findErrorOption(exit.cause);
  return failure._tag === 'Some' &&
    typeof failure.value === 'object' &&
    failure.value !== null &&
    '_tag' in failure.value
    ? String(failure.value._tag)
    : undefined;
};

test('lists exact active rows and all states for one trusted tenant in module-key order', async () => {
  await databasePromise(async (database) => {
    await database.executor.insert(tenantModuleStates).values([
      { moduleKey: 'list.zeta', state: 'active', tenantId: tenantOne },
      { moduleKey: 'list.alpha', state: 'active', tenantId: tenantOne },
      { moduleKey: 'list.inactive', state: 'inactive', tenantId: tenantOne },
      { moduleKey: 'list.alpha', state: 'active', tenantId: tenantTwo },
    ]);

    const service = makeTenantModuleStateService(database);
    assert.deepEqual(await Effect.runPromise(service.listActiveTenantModules(tenantOne)), [
      { moduleKey: 'list.alpha', state: 'active' },
      { moduleKey: 'list.zeta', state: 'active' },
    ]);
    assert.deepEqual(await Effect.runPromise(service.listActiveTenantModules(tenantTwo)), [
      { moduleKey: 'list.alpha', state: 'active' },
    ]);
    assert.deepEqual(await Effect.runPromise(service.listTenantModuleStates(tenantOne)), [
      { moduleKey: 'list.alpha', state: 'active' },
      { moduleKey: 'list.inactive', state: 'inactive' },
      { moduleKey: 'list.zeta', state: 'active' },
    ]);
    assert.deepEqual(await Effect.runPromise(service.listTenantModuleStates(tenantTwo)), [
      { moduleKey: 'list.alpha', state: 'active' },
    ]);
  });
});

test('atomically creates and transitions state with truthful Action history and evidence', async () => {
  const moduleKey = testModuleKey('testing', tenantOne);

  await Effect.runPromise(
    withDatabase((database) => {
      const runtime = makeActionRuntime(database, makeActionRepository(), unconfiguredPermission);
      return Effect.gen(function* transitionSequence() {
        const created = yield* runtime.runAction(actionInput(moduleKey, 'active', 'create'));
        assert.deepEqual(created, { moduleKey, newState: 'active', previousState: null });
        const suspended = yield* runtime.runAction(actionInput(moduleKey, 'suspended', 'suspend'));
        assert.deepEqual(suspended, {
          moduleKey,
          newState: 'suspended',
          previousState: 'active',
        });
        const reactivated = yield* runtime.runAction(
          actionInput(moduleKey, 'active', 'reactivate'),
        );
        assert.deepEqual(reactivated, {
          moduleKey,
          newState: 'active',
          previousState: 'suspended',
        });
      });
    }),
  );

  await databasePromise(async (database) => {
    const [current] = await database.executor
      .select()
      .from(tenantModuleStates)
      .where(
        and(
          eq(tenantModuleStates.tenantId, tenantOne),
          eq(tenantModuleStates.moduleKey, moduleKey),
        ),
      );
    const history = await database.executor
      .select()
      .from(tenantModuleStateChanges)
      .where(
        and(
          eq(tenantModuleStateChanges.tenantId, tenantOne),
          eq(tenantModuleStateChanges.moduleKey, moduleKey),
        ),
      )
      .orderBy(asc(tenantModuleStateChanges.occurredAt));
    assert.equal(current?.state, 'active');
    assert.equal(history.length, 3);
    assert.deepEqual(
      history.map(({ changeSource, newState, previousState }) => ({
        changeSource,
        newState,
        previousState,
      })),
      [
        { changeSource: 'user', newState: 'active', previousState: null },
        { changeSource: 'user', newState: 'suspended', previousState: 'active' },
        { changeSource: 'user', newState: 'active', previousState: 'suspended' },
      ],
    );
    assert.equal(current?.lastChangeId, history.at(-1)?.moduleStateChangeId);
    assert.ok(history.every((row) => row.changedByPrincipalId === principalOne));
    assert.ok(history.every((row) => row.actionInvocationId !== null));
    assert.ok(history.every((row) => row.reason?.startsWith('Integration transition to ')));

    for (const row of history) {
      const [invocation] = await database.executor
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.actionInvocationId, row.actionInvocationId ?? ''));
      assert.equal(invocation?.principalId, principalOne);
      assert.equal(invocation?.status, 'succeeded');
      const audit = await database.executor
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.actionInvocationId, row.actionInvocationId ?? ''));
      const access = await database.executor
        .select()
        .from(dataAccessEvents)
        .where(eq(dataAccessEvents.actionInvocationId, row.actionInvocationId ?? ''));
      assert.ok(audit.some((event) => event.eventType === 'action.executed'));
      assert.equal(access.length, 2);
      assert.deepEqual(
        new Set(access.map((event) => event.targetResourceType)),
        new Set(['tenant-module-state', 'tenant-module-state-dependency-snapshot']),
      );
      assert.ok(access.every((event) => event.accessKind === 'read'));
    }
  });
});

test('rejects unknown modules and inactive mandatory dependencies before module-state writes', async () => {
  const unknownModuleKey = testModuleKey('unknown', tenantOne);
  const dependencyModuleKey = testModuleKey('dependency', tenantOne);
  const targetModuleKey = testModuleKey('dependent', tenantOne);
  const transitionCatalog = catalogFrom(
    installedContract(dependencyModuleKey),
    installedContract(targetModuleKey, [
      {
        activation: 'must_be_active_first',
        id: dependencyModuleKey,
        reason: 'Dependency must be active first',
        required: true,
      },
    ]),
  );

  await Effect.runPromise(
    withDatabase((database) => {
      const runtime = makeActionRuntime(database, makeActionRepository(), unconfiguredPermission);
      const withCatalog = <Value, Error, Requirements>(
        effect: Effect.Effect<Value, Error, Requirements | InstalledModuleCatalogService>,
      ) =>
        effect.pipe(
          Effect.provideService(InstalledModuleCatalogService, {
            load: Effect.succeed(transitionCatalog),
          }),
        );
      return Effect.gen(function* rejectInvalidTransitions() {
        const unknown = yield* Effect.exit(
          withCatalog(runtime.runAction(actionInput(unknownModuleKey, 'active', 'unknown-module'))),
        );
        assert.equal(failureTag(unknown), 'TenantModuleStateUnknownModuleError');
        const inactiveDependency = yield* Effect.exit(
          withCatalog(
            runtime.runAction(actionInput(targetModuleKey, 'active', 'inactive-dependency')),
          ),
        );
        assert.equal(failureTag(inactiveDependency), 'TenantModuleStateDependencyInactiveError');
      });
    }),
  );

  await databasePromise(async (database) => {
    const stateRows = await database.executor
      .select()
      .from(tenantModuleStates)
      .where(inArray(tenantModuleStates.moduleKey, [unknownModuleKey, targetModuleKey]));
    const historyRows = await database.executor
      .select()
      .from(tenantModuleStateChanges)
      .where(inArray(tenantModuleStateChanges.moduleKey, [unknownModuleKey, targetModuleKey]));
    assert.deepEqual(stateRows, []);
    assert.deepEqual(historyRows, []);
  });
});

test('idempotent replay and same-state rejection create no duplicate history or evidence', async () => {
  const moduleKey = testModuleKey('idempotency', tenantOne);
  const input = actionInput(moduleKey, 'active', 'same-intent');

  await Effect.runPromise(
    withDatabase((database) => {
      const runtime = makeActionRuntime(database, makeActionRepository(), unconfiguredPermission);
      return runtime.runAction(input);
    }),
  );
  const replay = await Effect.runPromise(
    withDatabase((database) => {
      const runtime = makeActionRuntime(database, makeActionRepository(), unconfiguredPermission);
      return Effect.exit(runtime.runAction(input));
    }),
  );
  assert.equal(failureTag(replay), 'ActionAlreadyCommitted');

  const unchanged = await Effect.runPromise(
    withDatabase((database) => {
      const runtime = makeActionRuntime(database, makeActionRepository(), unconfiguredPermission);
      return Effect.exit(runtime.runAction(actionInput(moduleKey, 'active', 'same-state')));
    }),
  );
  assert.equal(failureTag(unchanged), 'TenantModuleStateUnchangedError');

  await databasePromise(async (database) => {
    const history = await database.executor
      .select()
      .from(tenantModuleStateChanges)
      .where(eq(tenantModuleStateChanges.moduleKey, moduleKey));
    assert.equal(history.length, 1);
    const unchangedInvocation = await database.executor
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.idempotencyKey, 'same-state'));
    assert.equal(unchangedInvocation.length, 1);
    const invocationId = unchangedInvocation[0]?.actionInvocationId ?? '';
    const unchangedAudit = await database.executor
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actionInvocationId, invocationId));
    assert.equal(unchangedAudit.length, 0);
    const unchangedAccess = await database.executor
      .select()
      .from(dataAccessEvents)
      .where(eq(dataAccessEvents.actionInvocationId, invocationId));
    assert.equal(unchangedAccess.length, 0);
  });
});

const withTenantStateWriteFailure = (database: DatabaseShape): DatabaseShape => ({
  executor: new Proxy(database.executor, {
    get(target, property) {
      if (property !== 'transaction') {
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const transaction = target.transaction as unknown as (
        callback: (executor: object) => PromiseLike<unknown>,
      ) => Promise<unknown>;
      return (callback: (executor: object) => PromiseLike<unknown>) =>
        transaction.call(target, (executor) =>
          callback(
            new Proxy(executor, {
              get(transactionTarget, operation) {
                const value = Reflect.get(
                  transactionTarget,
                  operation,
                  transactionTarget,
                ) as unknown;
                if (operation === 'insert' && typeof value === 'function') {
                  return (table: unknown) => {
                    if (table === tenantModuleStates) {
                      throw new Error('Injected current-state persistence failure');
                    }
                    return (value as (targetTable: unknown) => unknown).call(
                      transactionTarget,
                      table,
                    );
                  };
                }
                return typeof value === 'function' ? value.bind(transactionTarget) : value;
              },
            }),
          ),
        );
    },
  }),
});

test('rolls back history and Action evidence when current-state persistence fails', async () => {
  const moduleKey = testModuleKey('rollback', tenantOne);
  const failure = await Effect.runPromise(
    withDatabase((database) => {
      const runtime = makeActionRuntime(
        withTenantStateWriteFailure(database),
        makeActionRepository(),
        unconfiguredPermission,
      );
      return Effect.exit(runtime.runAction(actionInput(moduleKey, 'active', 'forced-failure')));
    }),
  );
  assert.equal(failureTag(failure), 'TenantModuleStatePersistenceUnavailableError');

  await databasePromise(async (database) => {
    const states = await database.executor
      .select()
      .from(tenantModuleStates)
      .where(eq(tenantModuleStates.moduleKey, moduleKey));
    assert.equal(states.length, 0);
    const history = await database.executor
      .select()
      .from(tenantModuleStateChanges)
      .where(eq(tenantModuleStateChanges.moduleKey, moduleKey));
    assert.equal(history.length, 0);
    const [invocation] = await database.executor
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.idempotencyKey, 'forced-failure'));
    assert.ok(invocation);
    const audits = await database.executor
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actionInvocationId, invocation.actionInvocationId));
    assert.equal(audits.length, 0);
  });
});

test('serializes concurrent transitions into one truthful history chain', async () => {
  const moduleKey = testModuleKey('concurrency', tenantOne);
  await Effect.runPromise(
    withDatabase((database) => {
      const runtime = makeActionRuntime(database, makeActionRepository(), unconfiguredPermission);
      return runtime.runAction(actionInput(moduleKey, 'inactive', 'concurrent-initial'));
    }),
  );

  const exits = await Promise.all(
    [
      ['active', 'concurrent-active'],
      ['suspended', 'concurrent-suspended'],
    ].map(([state, key]) =>
      Effect.runPromise(
        withDatabase((database) => {
          const runtime = makeActionRuntime(
            database,
            makeActionRepository(),
            unconfiguredPermission,
          );
          return Effect.exit(
            runtime.runAction(
              actionInput(moduleKey, state as 'active' | 'suspended', key ?? 'missing-key'),
            ),
          );
        }),
      ),
    ),
  );
  assert.ok(exits.every(Exit.isSuccess));

  await databasePromise(async (database) => {
    const [current] = await database.executor
      .select()
      .from(tenantModuleStates)
      .where(eq(tenantModuleStates.moduleKey, moduleKey));
    const history = await database.executor
      .select()
      .from(tenantModuleStateChanges)
      .where(eq(tenantModuleStateChanges.moduleKey, moduleKey));
    assert.equal(history.length, 3);
    const last = history.find((row) => row.moduleStateChangeId === current?.lastChangeId);
    const concurrentFirst = history.find(
      (row) =>
        row.previousState === 'inactive' && row.moduleStateChangeId !== last?.moduleStateChangeId,
    );
    assert.ok(last);
    assert.ok(concurrentFirst);
    assert.equal(last.previousState, concurrentFirst.newState);
    assert.equal(current?.state, last.newState);
  });
});

test('derives tenant scope only from the trusted principal', async () => {
  const moduleKey = testModuleKey('isolation', tenantOne);
  await databasePromise(async (database) => {
    await database.executor.insert(tenantModuleStates).values({
      moduleKey,
      state: 'active',
      tenantId: tenantTwo,
    });
  });

  await Effect.runPromise(
    withDatabase((database) => {
      const runtime = makeActionRuntime(database, makeActionRepository(), unconfiguredPermission);
      return runtime.runAction(actionInput(moduleKey, 'suspended', 'tenant-isolation'));
    }),
  );

  await databasePromise(async (database) => {
    const rows = await database.executor
      .select({ state: tenantModuleStates.state, tenantId: tenantModuleStates.tenantId })
      .from(tenantModuleStates)
      .where(eq(tenantModuleStates.moduleKey, moduleKey))
      .orderBy(asc(tenantModuleStates.tenantId));
    assert.deepEqual(Object.fromEntries(rows.map((row) => [row.tenantId, row.state])), {
      [tenantOne]: 'suspended',
      [tenantTwo]: 'active',
    });
  });
});
