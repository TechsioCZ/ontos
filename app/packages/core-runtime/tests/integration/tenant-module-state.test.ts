import { and, asc, eq, inArray } from 'drizzle-orm';
import { Cause, Effect, Exit, Match, Option, Schema, Layer } from 'effect';
import { expect, it } from 'effect-rstest';
import { SqlError, UnknownError } from 'effect/unstable/sql/SqlError';

import { makeActionRepository } from '../../src/actions/repository.ts';
import { makeActionRuntime } from '../../src/actions/runtime.ts';
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
import type {
  InstalledModuleCatalog,
  OntosModuleDeploymentContract,
} from '../../src/index.ts';
import { changeTenantModuleStateAction } from '../../src/modules/actions/change-tenant-module-state.action.ts';
import { InstalledModuleCatalogService } from '../../src/modules/catalog.ts';
import {
  TenantModuleStateService,
  makeTenantModuleStateService,
} from '../../src/modules/tenant-module-state-service.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../support/action-runtime-options.ts';
import {
  makeFaultInjectableCoreDatabase,
  TestQueryHook,
} from '../support/database-faults.ts';
import { makeInstalledCatalogFixture as catalogFrom } from '../support/installed-catalog.ts';

const tenantOne = '70000000-0000-4000-8000-000000000001';
const tenantTwo = '70000000-0000-4000-8000-000000000002';
const principalOne = '71000000-0000-4000-8000-000000000001';
const principalTwo = '71000000-0000-4000-8000-000000000002';
const bindingOne = '72000000-0000-4000-8000-000000000001';
const bindingTwo = '72000000-0000-4000-8000-000000000002';
const FailureTagSchema = Schema.Struct({ _tag: Schema.String });
const decodeFailureTag = Schema.decodeUnknownOption(FailureTagSchema);
const tenantIds = [tenantOne, tenantTwo] as const;

type DatabaseService = Parameters<typeof makeActionRuntime>[0];

const installedContract = (moduleId: string): OntosModuleDeploymentContract =>
  makeModuleContractFixture({
    appId: 'test-module',
    buildMarker: 'test-build',
    description: 'Integration test module',
    displayName: 'Integration test module',
    moduleId,
    supportedStates: [
      'inactive',
      'active',
      'read_only',
      'suspended',
      'quarantined',
      'deprecated',
      'archived',
    ],
  });

// State-transition tests deliberately accept arbitrary module IDs without discovery.
const installedCatalog: InstalledModuleCatalog = Object.freeze({
  ...catalogFrom(),
  getByModuleId: installedContract,
});

const withDatabase = <Value, Error>(
  operation: (
    database: DatabaseService
  ) => Effect.Effect<
    Value,
    Error,
    InstalledModuleCatalogService | TenantModuleStateService
  >
) =>
  Effect.scoped(
    Effect.gen(function* tenantModuleStateDatabaseScope() {
      const configuration = yield* loadDatabaseConfig();
      const database = yield* makeFaultInjectableCoreDatabase(configuration);
      return yield* operation(database).pipe(
        Effect.provideService(InstalledModuleCatalogService, {
          load: Effect.succeed(installedCatalog),
        }),
        Effect.provideService(
          TenantModuleStateService,
          makeTenantModuleStateService(database)
        )
      );
    })
  );

const cleanup = withDatabase((database) =>
  Effect.gen(function* cleanTenantModuleStateFixtures() {
    // Keep dependent evidence ahead of its referenced identity rows.
    for (const table of [
      dataAccessEvents,
      auditEvents,
      tenantModuleStateChanges,
      tenantModuleStates,
      actionInvocations,
      principalAuthBindings,
      principals,
      tenants,
    ]) {
      yield* database.executor
        .delete(table)
        .where(inArray(table.tenantId, tenantIds));
    }
  })
);

const setup = Effect.gen(function* initializeTenantModuleStateFixtures() {
  yield* cleanup;
  yield* withDatabase((database) =>
    Effect.gen(function* insertTenantModuleStateFixtures() {
      yield* database.executor.insert(tenants).values([
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
      yield* database.executor.insert(principals).values([
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
      yield* database.executor.insert(principalAuthBindings).values([
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
    })
  );
});

const Fixtures = Layer.effectDiscard(
  Effect.acquireRelease(setup, () => cleanup.pipe(Effect.orDie))
);

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

const testModuleKey = (prefix: string, tenantId: string): string =>
  `${prefix}.id-${tenantId}`;

const actionInput = (
  moduleKey: string,
  newState: (typeof changeTenantModuleStateAction.descriptor.payloadSchema)['Type']['newState'],
  idempotencyKey: string,
  trustedPrincipal = principal()
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

const failureTag = <Error>(
  exit: Exit.Exit<unknown, Error>
): string | undefined => {
  const failure = Match.value(exit).pipe(
    Match.tag('Failure', ({ cause }) => Cause.findErrorOption(cause)),
    Match.tag('Success', () => Option.none<Error>()),
    Match.exhaustive
  );
  const tag = Option.match(failure, {
    onNone: () => Option.none<string>(),
    onSome: (error) =>
      decodeFailureTag(error).pipe(Option.map(({ _tag }) => _tag)),
  });
  return Option.getOrUndefined(tag);
};

const verifyHistoryEvidence = (
  database: DatabaseService,
  row: typeof tenantModuleStateChanges.$inferSelect
) =>
  Effect.gen(function* verifyHistoryEvidenceEffect() {
    const [invocation] = yield* database.executor
      .select()
      .from(actionInvocations)
      .where(
        eq(actionInvocations.actionInvocationId, row.actionInvocationId ?? '')
      );
    expect(invocation?.principalId).toBe(principalOne);
    expect(invocation?.status).toBe('succeeded');
    const audit = yield* database.executor
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actionInvocationId, row.actionInvocationId ?? ''));
    const access = yield* database.executor
      .select()
      .from(dataAccessEvents)
      .where(
        eq(dataAccessEvents.actionInvocationId, row.actionInvocationId ?? '')
      );
    expect(audit.some((event) => event.eventType === 'action.executed')).toBe(
      true
    );
    expect(access.length).toBe(1);
    expect(access.map((event) => event.targetResourceType)).toEqual([
      'tenant-module-state',
    ]);
    expect(access.every((event) => event.accessKind === 'read')).toBe(true);
  });

const tenantModuleStateTest1 = withDatabase((database) =>
  Effect.gen(function* listTenantModuleStates() {
    yield* database.executor.insert(tenantModuleStates).values([
      { moduleKey: 'list.zeta', state: 'active', tenantId: tenantOne },
      { moduleKey: 'list.alpha', state: 'active', tenantId: tenantOne },
      { moduleKey: 'list.inactive', state: 'inactive', tenantId: tenantOne },
      { moduleKey: 'list.alpha', state: 'active', tenantId: tenantTwo },
    ]);

    const service = makeTenantModuleStateService(database);
    expect(yield* service.listActiveTenantModules(tenantOne)).toEqual([
      { moduleKey: 'list.alpha', state: 'active' },
      { moduleKey: 'list.zeta', state: 'active' },
    ]);
    expect(yield* service.listActiveTenantModules(tenantTwo)).toEqual([
      { moduleKey: 'list.alpha', state: 'active' },
    ]);
    expect(yield* service.listTenantModuleStates(tenantOne)).toEqual([
      { moduleKey: 'list.alpha', state: 'active' },
      { moduleKey: 'list.inactive', state: 'inactive' },
      { moduleKey: 'list.zeta', state: 'active' },
    ]);
    expect(yield* service.listTenantModuleStates(tenantTwo)).toEqual([
      { moduleKey: 'list.alpha', state: 'active' },
    ]);
  })
);
const tenantModuleStateTest2 = Effect.gen(
  function* createAndTransitionTenantModuleState() {
    const moduleKey = testModuleKey('testing', tenantOne);

    yield* withDatabase((database) => {
      const runtime = makeActionRuntime(
        database,
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions
      );
      return Effect.gen(function* transitionSequence() {
        const created = yield* runtime.runAction(
          actionInput(moduleKey, 'active', 'create')
        );
        expect(created).toEqual({
          moduleKey,
          newState: 'active',
          previousState: null,
        });
        const suspended = yield* runtime.runAction(
          actionInput(moduleKey, 'suspended', 'suspend')
        );
        expect(suspended).toEqual({
          moduleKey,
          newState: 'suspended',
          previousState: 'active',
        });
        const reactivated = yield* runtime.runAction(
          actionInput(moduleKey, 'active', 'reactivate')
        );
        expect(reactivated).toEqual({
          moduleKey,
          newState: 'active',
          previousState: 'suspended',
        });
      });
    });

    yield* withDatabase((database) =>
      Effect.gen(function* verifyTenantModuleStateHistory() {
        const [current] = yield* database.executor
          .select()
          .from(tenantModuleStates)
          .where(
            and(
              eq(tenantModuleStates.tenantId, tenantOne),
              eq(tenantModuleStates.moduleKey, moduleKey)
            )
          );
        const history = yield* database.executor
          .select()
          .from(tenantModuleStateChanges)
          .where(
            and(
              eq(tenantModuleStateChanges.tenantId, tenantOne),
              eq(tenantModuleStateChanges.moduleKey, moduleKey)
            )
          )
          .orderBy(asc(tenantModuleStateChanges.occurredAt));
        expect(current?.state).toBe('active');
        expect(history.length).toBe(3);
        expect(
          history.map(({ changeSource, newState, previousState }) => ({
            changeSource,
            newState,
            previousState,
          }))
        ).toEqual([
          { changeSource: 'user', newState: 'active', previousState: null },
          {
            changeSource: 'user',
            newState: 'suspended',
            previousState: 'active',
          },
          {
            changeSource: 'user',
            newState: 'active',
            previousState: 'suspended',
          },
        ]);
        expect(current?.lastChangeId).toBe(history.at(-1)?.moduleStateChangeId);
        expect(
          history.every((row) => row.changedByPrincipalId === principalOne)
        ).toBe(true);
        expect(history.every((row) => row.actionInvocationId !== null)).toBe(
          true
        );
        expect(
          history.every(
            (row) =>
              row.reason?.startsWith('Integration transition to ') === true
          )
        ).toBe(true);

        yield* Effect.forEach(
          history,
          (row) => verifyHistoryEvidence(database, row),
          {
            concurrency: 1,
          }
        );
      })
    );
  }
);
const tenantModuleStateTest3 = Effect.gen(
  function* allDeclaredTenantModuleStates() {
    const otherModuleKey = testModuleKey('other', tenantOne);
    const targetModuleKey = testModuleKey('independent', tenantOne);
    const transitionCatalog = catalogFrom(
      installedContract(otherModuleKey),
      installedContract(targetModuleKey)
    );
    yield* withDatabase((database) =>
      database.executor.insert(tenantModuleStates).values({
        moduleKey: otherModuleKey,
        state: 'inactive',
        tenantId: tenantOne,
      })
    );

    yield* withDatabase((database) => {
      const runtime = makeActionRuntime(
        database,
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions
      );
      const withCatalog = <Value, Error, Requirements>(
        effect: Effect.Effect<
          Value,
          Error,
          Requirements | InstalledModuleCatalogService
        >
      ) =>
        effect.pipe(
          Effect.provideService(InstalledModuleCatalogService, {
            load: Effect.succeed(transitionCatalog),
          })
        );
      const states = [
        'active',
        'read_only',
        'suspended',
        'quarantined',
        'deprecated',
        'archived',
        'inactive',
      ] as const;
      return Effect.forEach(
        states,
        (state) =>
          withCatalog(
            runtime.runAction(
              actionInput(targetModuleKey, state, `independent-${state}`)
            )
          ),
        { concurrency: 1, discard: true }
      );
    });

    yield* withDatabase((database) =>
      Effect.gen(function* verifyAllDeclaredStates() {
        const stateRows = yield* database.executor
          .select({
            moduleKey: tenantModuleStates.moduleKey,
            state: tenantModuleStates.state,
          })
          .from(tenantModuleStates)
          .where(
            inArray(tenantModuleStates.moduleKey, [
              otherModuleKey,
              targetModuleKey,
            ])
          );
        const historyRows = yield* database.executor
          .select()
          .from(tenantModuleStateChanges)
          .where(eq(tenantModuleStateChanges.moduleKey, targetModuleKey));
        expect(
          Object.fromEntries(stateRows.map((row) => [row.moduleKey, row.state]))
        ).toEqual({
          [otherModuleKey]: 'inactive',
          [targetModuleKey]: 'inactive',
        });
        expect(historyRows.map(({ newState }) => newState).toSorted()).toEqual([
          'active',
          'archived',
          'deprecated',
          'inactive',
          'quarantined',
          'read_only',
          'suspended',
        ]);
      })
    );
  }
);
const tenantModuleStateTest4 = Effect.gen(
  function* idempotentReplayAndSameStateRejection() {
    const moduleKey = testModuleKey('idempotency', tenantOne);
    const input = actionInput(moduleKey, 'active', 'same-intent');

    yield* withDatabase((database) => {
      const runtime = makeActionRuntime(
        database,
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions
      );
      return runtime.runAction(input);
    });
    const replay = yield* withDatabase((database) => {
      const runtime = makeActionRuntime(
        database,
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions
      );
      return Effect.exit(runtime.runAction(input));
    });
    expect(failureTag(replay)).toBe('ActionAlreadyCommitted');

    const unchanged = yield* withDatabase((database) => {
      const runtime = makeActionRuntime(
        database,
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions
      );
      return Effect.exit(
        runtime.runAction(actionInput(moduleKey, 'active', 'same-state'))
      );
    });
    expect(failureTag(unchanged)).toBe('TenantModuleStateUnchangedError');

    yield* withDatabase((database) =>
      Effect.gen(function* verifyIdempotentEvidence() {
        const history = yield* database.executor
          .select()
          .from(tenantModuleStateChanges)
          .where(eq(tenantModuleStateChanges.moduleKey, moduleKey));
        expect(history.length).toBe(1);
        const unchangedInvocation = yield* database.executor
          .select()
          .from(actionInvocations)
          .where(eq(actionInvocations.idempotencyKey, 'same-state'));
        expect(unchangedInvocation.length).toBe(1);
        const invocationId = unchangedInvocation[0]?.actionInvocationId ?? '';
        const unchangedAudit = yield* database.executor
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.actionInvocationId, invocationId));
        expect(unchangedAudit.length).toBe(0);
        const unchangedAccess = yield* database.executor
          .select()
          .from(dataAccessEvents)
          .where(eq(dataAccessEvents.actionInvocationId, invocationId));
        expect(unchangedAccess.length).toBe(0);
      })
    );
  }
);
const withTenantStateWriteFailure = (
  database: DatabaseService
): DatabaseService => {
  const transaction: DatabaseService['executor']['transaction'] = (operation) =>
    database.executor.transaction((currentTransaction) =>
      operation(currentTransaction).pipe(
        Effect.provideService(TestQueryHook, (statement) =>
          statement.startsWith('insert into "core"."tenant_module_states"')
            ? Effect.fail(
                new SqlError({
                  reason: new UnknownError({
                    cause: new Error('Injected SQL failure'),
                    message: 'Injected current-state persistence failure',
                  }),
                })
              )
            : Effect.void
        )
      )
    );
  const transactionOverride = { transaction } satisfies Pick<
    DatabaseService['executor'],
    'transaction'
  >;
  const executor: DatabaseService['executor'] = Object.assign(
    Object.create(database.executor),
    transactionOverride
  );
  return { executor };
};
const tenantModuleStateTest5 = Effect.gen(
  function* rollbackFailedTenantModuleStateWrite() {
    const moduleKey = testModuleKey('rollback', tenantOne);
    const failure = yield* withDatabase((database) => {
      const runtime = makeActionRuntime(
        withTenantStateWriteFailure(database),
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions
      );
      return Effect.exit(
        runtime.runAction(actionInput(moduleKey, 'active', 'forced-failure'))
      );
    });
    expect(
      failureTag(failure),
      Exit.isFailure(failure) ? Cause.pretty(failure.cause) : 'success'
    ).toBe('TenantModuleStatePersistenceUnavailableError');

    yield* withDatabase((database) =>
      Effect.gen(function* verifyFailedWriteRollback() {
        const states = yield* database.executor
          .select()
          .from(tenantModuleStates)
          .where(eq(tenantModuleStates.moduleKey, moduleKey));
        expect(states.length).toBe(0);
        const history = yield* database.executor
          .select()
          .from(tenantModuleStateChanges)
          .where(eq(tenantModuleStateChanges.moduleKey, moduleKey));
        expect(history.length).toBe(0);
        const [invocation] = yield* database.executor
          .select()
          .from(actionInvocations)
          .where(eq(actionInvocations.idempotencyKey, 'forced-failure'));
        expect(invocation).toBeDefined();
        const audits = yield* database.executor
          .select()
          .from(auditEvents)
          .where(
            eq(
              auditEvents.actionInvocationId,
              invocation?.actionInvocationId ?? ''
            )
          );
        expect(audits.length).toBe(0);
      })
    );
  }
);
const tenantModuleStateTest6 = Effect.gen(
  function* serializeConcurrentTenantModuleStateTransitions() {
    const moduleKey = testModuleKey('concurrency', tenantOne);
    yield* withDatabase((database) => {
      const runtime = makeActionRuntime(
        database,
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        openActionRuntimeOptions
      );
      return runtime.runAction(
        actionInput(moduleKey, 'inactive', 'concurrent-initial')
      );
    });

    const exits = yield* Effect.forEach(
      [
        ['active', 'concurrent-active'],
        ['suspended', 'concurrent-suspended'],
      ] as const,
      ([state, key]) =>
        withDatabase((database) => {
          const runtime = makeActionRuntime(
            database,
            makeActionRepository(),
            allowedPermission,
            testOperationalScopeResolver,
            openActionRuntimeOptions
          );
          return Effect.exit(
            runtime.runAction(actionInput(moduleKey, state, key))
          );
        }),
      { concurrency: 'unbounded' }
    );
    expect(exits.every(Exit.isSuccess)).toBe(true);

    yield* withDatabase((database) =>
      Effect.gen(function* verifySerializedTransitions() {
        const [current] = yield* database.executor
          .select()
          .from(tenantModuleStates)
          .where(eq(tenantModuleStates.moduleKey, moduleKey));
        const history = yield* database.executor
          .select()
          .from(tenantModuleStateChanges)
          .where(eq(tenantModuleStateChanges.moduleKey, moduleKey));
        expect(history.length).toBe(3);
        const last = history.find(
          (row) => row.moduleStateChangeId === current?.lastChangeId
        );
        const concurrentFirst = history.find(
          (row) =>
            row.previousState === 'inactive' &&
            row.moduleStateChangeId !== last?.moduleStateChangeId
        );
        expect(last).toBeDefined();
        expect(concurrentFirst).toBeDefined();
        expect(last?.previousState).toBe(concurrentFirst?.newState);
        expect(current?.state).toBe(last?.newState);
      })
    );
  }
);
const tenantModuleStateTest7 = Effect.gen(function* deriveTrustedTenantScope() {
  const moduleKey = testModuleKey('isolation', tenantOne);
  yield* withDatabase((database) =>
    database.executor.insert(tenantModuleStates).values({
      moduleKey,
      state: 'active',
      tenantId: tenantTwo,
    })
  );

  yield* withDatabase((database) => {
    const runtime = makeActionRuntime(
      database,
      makeActionRepository(),
      allowedPermission,
      testOperationalScopeResolver,
      openActionRuntimeOptions
    );
    return runtime.runAction(
      actionInput(moduleKey, 'suspended', 'tenant-isolation')
    );
  });

  yield* withDatabase((database) =>
    Effect.gen(function* verifyTrustedTenantScope() {
      const rows = yield* database.executor
        .select({
          state: tenantModuleStates.state,
          tenantId: tenantModuleStates.tenantId,
        })
        .from(tenantModuleStates)
        .where(eq(tenantModuleStates.moduleKey, moduleKey))
        .orderBy(asc(tenantModuleStates.tenantId));
      expect(
        Object.fromEntries(rows.map((row) => [row.tenantId, row.state]))
      ).toEqual({
        [tenantOne]: 'suspended',
        [tenantTwo]: 'active',
      });
    })
  );
});
it.layer(Fixtures, { excludeTestServices: true })(
  'tenant module state',
  (suite) => {
    suite.effect(
      'lists exact active rows and all states for one trusted tenant in module-key order',
      () => tenantModuleStateTest1
    );

    suite.effect(
      'atomically creates and transitions state with truthful Action history and evidence',
      () => tenantModuleStateTest2
    );

    suite.effect(
      'supports every declared state independently of other installed module states',
      () => tenantModuleStateTest3
    );

    suite.effect(
      'idempotent replay and same-state rejection create no duplicate history or evidence',
      () => tenantModuleStateTest4
    );

    suite.effect(
      'rolls back history and Action evidence when current-state persistence fails',
      () => tenantModuleStateTest5
    );

    suite.effect(
      'serializes concurrent transitions into one truthful history chain',
      () => tenantModuleStateTest6
    );

    suite.effect(
      'derives tenant scope only from the trusted principal',
      () => tenantModuleStateTest7
    );
  }
);
