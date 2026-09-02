/* eslint-disable no-await-in-loop, promise/prefer-await-to-callbacks -- Ordered transition and transaction assertions are deliberate. */
import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Cause, Effect, Exit, Predicate } from 'effect';
import type { InstalledModuleCatalog, OntosModuleDeploymentContract } from '../../src/index.ts';
import { makeActionRepository } from '../../src/actions/repository.ts';
import { makeActionRuntime } from '../../src/actions/runtime.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../support/action-runtime-options.ts';
import { makeCoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import {
  actionInvocations,
  auditEvents,
  dataAccessEvents,
  principalAuthBindings,
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
const bindingOne = randomUUID();
const bindingTwo = randomUUID();
const tenantIds = [tenantOne, tenantTwo] as const;

type DatabaseService = Parameters<typeof makeActionRuntime>[0];

const installedContract = (moduleId: string): OntosModuleDeploymentContract => ({
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

const noInstalledContracts: readonly OntosModuleDeploymentContract[] = Object.freeze([]);

const installedCatalog: InstalledModuleCatalog = Object.freeze({
  contracts: noInstalledContracts,
  deploymentAppIds: Object.freeze([]),
  getByDeploymentAppId: (appId: string) =>
    noInstalledContracts.find(({ deployment }) => deployment.appId === appId),
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
    database: DatabaseService,
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
  operation: (database: DatabaseService) => PromiseLike<Value>,
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
    await database.executor
      .delete(principalAuthBindings)
      .where(inArray(principalAuthBindings.tenantId, tenantIds));
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
    await database.executor.insert(principalAuthBindings).values([
      {
        principalAuthBindingId: bindingOne,
        principalId: principalOne,
        provider: 'better_auth',
        providerSubjectId: `tenant-module-state-user-${principalOne}`,
        status: 'active',
        subjectType: 'user',
        tenantId: tenantOne,
      },
      {
        principalAuthBindingId: bindingTwo,
        principalId: principalTwo,
        provider: 'better_auth',
        providerSubjectId: `tenant-module-state-user-${principalTwo}`,
        status: 'active',
        subjectType: 'user',
        tenantId: tenantTwo,
      },
    ]);
  });
});

after(cleanup);

const allowedPermission = {
  checkActionPermission: () => Effect.succeed('allowed' as const),
};

const principal = (tenantId = tenantOne, principalId = principalOne) => ({
  authBindingId: tenantId === tenantOne ? bindingOne : bindingTwo,
  authContextRef: `better-auth-session:tenant-module-state-${principalId}`,
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
    Predicate.isObjectKeyword(failure.value) &&
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
      const runtime = makeActionRuntime(
        database,
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions,
      );
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
      assert.equal(access.length, 1);
      assert.deepEqual(
        access.map((event) => event.targetResourceType),
        ['tenant-module-state'],
      );
      assert.ok(access.every((event) => event.accessKind === 'read'));
    }
  });
});

test('supports every declared state independently of other installed module states', async () => {
  const otherModuleKey = testModuleKey('other', tenantOne);
  const targetModuleKey = testModuleKey('independent', tenantOne);
  const transitionCatalog = catalogFrom(
    installedContract(otherModuleKey),
    installedContract(targetModuleKey),
  );
  await databasePromise((database) =>
    database.executor.insert(tenantModuleStates).values({
      moduleKey: otherModuleKey,
      state: 'inactive',
      tenantId: tenantOne,
    }),
  );

  await Effect.runPromise(
    withDatabase((database) => {
      const runtime = makeActionRuntime(
        database,
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions,
      );
      const withCatalog = <Value, Error, Requirements>(
        effect: Effect.Effect<Value, Error, Requirements | InstalledModuleCatalogService>,
      ) =>
        effect.pipe(
          Effect.provideService(InstalledModuleCatalogService, {
            load: Effect.succeed(transitionCatalog),
          }),
        );
      return Effect.gen(function* transitionAcrossAllStates() {
        for (const state of [
          'active',
          'read_only',
          'suspended',
          'quarantined',
          'deprecated',
          'archived',
          'inactive',
        ] as const) {
          yield* withCatalog(
            runtime.runAction(actionInput(targetModuleKey, state, `independent-${state}`)),
          );
        }
      });
    }),
  );

  await databasePromise(async (database) => {
    const stateRows = await database.executor
      .select({ moduleKey: tenantModuleStates.moduleKey, state: tenantModuleStates.state })
      .from(tenantModuleStates)
      .where(inArray(tenantModuleStates.moduleKey, [otherModuleKey, targetModuleKey]));
    const historyRows = await database.executor
      .select()
      .from(tenantModuleStateChanges)
      .where(eq(tenantModuleStateChanges.moduleKey, targetModuleKey));
    assert.deepEqual(Object.fromEntries(stateRows.map((row) => [row.moduleKey, row.state])), {
      [otherModuleKey]: 'inactive',
      [targetModuleKey]: 'inactive',
    });
    assert.deepEqual(historyRows.map(({ newState }) => newState).toSorted(), [
      'active',
      'archived',
      'deprecated',
      'inactive',
      'quarantined',
      'read_only',
      'suspended',
    ]);
  });
});

test('idempotent replay and same-state rejection create no duplicate history or evidence', async () => {
  const moduleKey = testModuleKey('idempotency', tenantOne);
  const input = actionInput(moduleKey, 'active', 'same-intent');

  await Effect.runPromise(
    withDatabase((database) => {
      const runtime = makeActionRuntime(
        database,
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions,
      );
      return runtime.runAction(input);
    }),
  );
  const replay = await Effect.runPromise(
    withDatabase((database) => {
      const runtime = makeActionRuntime(
        database,
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions,
      );
      return Effect.exit(runtime.runAction(input));
    }),
  );
  assert.equal(failureTag(replay), 'ActionAlreadyCommitted');

  const unchanged = await Effect.runPromise(
    withDatabase((database) => {
      const runtime = makeActionRuntime(
        database,
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions,
      );
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

const withTenantStateWriteFailure = (database: DatabaseService): DatabaseService => {
  const transactionOverride = {
    transaction: (callback, configuration) =>
      database.executor.transaction((transaction) => {
        const insert: typeof transaction.insert = (table) => {
          if (Object.is(table, tenantModuleStates)) {
            throw new Error('Injected current-state persistence failure');
          }
          return transaction.insert(table);
        };
        const faultingTransaction: typeof transaction = Object.assign(Object.create(transaction), {
          insert,
        });
        return callback(faultingTransaction);
      }, configuration),
  } satisfies Pick<DatabaseService['executor'], 'transaction'>;
  const executor: DatabaseService['executor'] = Object.assign(
    Object.create(database.executor),
    transactionOverride,
  );
  return { executor };
};

test('rolls back history and Action evidence when current-state persistence fails', async () => {
  const moduleKey = testModuleKey('rollback', tenantOne);
  const failure = await Effect.runPromise(
    withDatabase((database) => {
      const runtime = makeActionRuntime(
        withTenantStateWriteFailure(database),
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions,
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
      const runtime = makeActionRuntime(
        database,
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions,
      );
      return runtime.runAction(actionInput(moduleKey, 'inactive', 'concurrent-initial'));
    }),
  );

  const exits = await Promise.all(
    (
      [
        ['active', 'concurrent-active'],
        ['suspended', 'concurrent-suspended'],
      ] as const
    ).map(([state, key]) =>
      Effect.runPromise(
        withDatabase((database) => {
          const runtime = makeActionRuntime(
            database,
            makeActionRepository(),
            allowedPermission,
            testOperationalScopeResolver,
            openActionRuntimeOptions,
          );
          return Effect.exit(runtime.runAction(actionInput(moduleKey, state, key)));
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
      const runtime = makeActionRuntime(
        database,
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions,
      );
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
