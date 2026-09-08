import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Cause, Effect, Exit, Match, Option, Schema, flow } from 'effect';
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

const effectCallback = <Value, Error>(effect: Effect.Effect<Value, Error>) =>
  flow(() => Effect.asVoid(effect), runEffectTestPromise);

const effectTest = <Value, Error>(
  name: string,
  effect: Effect.Effect<Value, Error>
): void => {
  test(name, effectCallback(effect));
};

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

before(
  Effect.gen(function* initializeTenantModuleStateFixtures() {
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
  }).pipe(effectCallback)
);

after(cleanup.pipe(effectCallback));

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
    assert.equal(invocation?.principalId, principalOne);
    assert.equal(invocation?.status, 'succeeded');
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
    assert.ok(audit.some((event) => event.eventType === 'action.executed'));
    assert.equal(access.length, 1);
    assert.deepEqual(
      access.map((event) => event.targetResourceType),
      ['tenant-module-state']
    );
    assert.ok(access.every((event) => event.accessKind === 'read'));
  });

effectTest(
  'lists exact active rows and all states for one trusted tenant in module-key order',
  withDatabase((database) =>
    Effect.gen(function* listTenantModuleStates() {
      yield* database.executor.insert(tenantModuleStates).values([
        { moduleKey: 'list.zeta', state: 'active', tenantId: tenantOne },
        { moduleKey: 'list.alpha', state: 'active', tenantId: tenantOne },
        { moduleKey: 'list.inactive', state: 'inactive', tenantId: tenantOne },
        { moduleKey: 'list.alpha', state: 'active', tenantId: tenantTwo },
      ]);

      const service = makeTenantModuleStateService(database);
      assert.deepEqual(yield* service.listActiveTenantModules(tenantOne), [
        { moduleKey: 'list.alpha', state: 'active' },
        { moduleKey: 'list.zeta', state: 'active' },
      ]);
      assert.deepEqual(yield* service.listActiveTenantModules(tenantTwo), [
        { moduleKey: 'list.alpha', state: 'active' },
      ]);
      assert.deepEqual(yield* service.listTenantModuleStates(tenantOne), [
        { moduleKey: 'list.alpha', state: 'active' },
        { moduleKey: 'list.inactive', state: 'inactive' },
        { moduleKey: 'list.zeta', state: 'active' },
      ]);
      assert.deepEqual(yield* service.listTenantModuleStates(tenantTwo), [
        { moduleKey: 'list.alpha', state: 'active' },
      ]);
    })
  )
);

effectTest(
  'atomically creates and transitions state with truthful Action history and evidence',
  Effect.gen(function* createAndTransitionTenantModuleState() {
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
        assert.deepEqual(created, {
          moduleKey,
          newState: 'active',
          previousState: null,
        });
        const suspended = yield* runtime.runAction(
          actionInput(moduleKey, 'suspended', 'suspend')
        );
        assert.deepEqual(suspended, {
          moduleKey,
          newState: 'suspended',
          previousState: 'active',
        });
        const reactivated = yield* runtime.runAction(
          actionInput(moduleKey, 'active', 'reactivate')
        );
        assert.deepEqual(reactivated, {
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
          ]
        );
        assert.equal(
          current?.lastChangeId,
          history.at(-1)?.moduleStateChangeId
        );
        assert.ok(
          history.every((row) => row.changedByPrincipalId === principalOne)
        );
        assert.ok(history.every((row) => row.actionInvocationId !== null));
        assert.ok(
          history.every(
            (row) =>
              row.reason?.startsWith('Integration transition to ') === true
          )
        );

        yield* Effect.forEach(
          history,
          (row) => verifyHistoryEvidence(database, row),
          {
            concurrency: 1,
          }
        );
      })
    );
  })
);

effectTest(
  'supports every declared state independently of other installed module states',
  Effect.gen(function* allDeclaredTenantModuleStates() {
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
        assert.deepEqual(
          Object.fromEntries(
            stateRows.map((row) => [row.moduleKey, row.state])
          ),
          {
            [otherModuleKey]: 'inactive',
            [targetModuleKey]: 'inactive',
          }
        );
        assert.deepEqual(
          historyRows.map(({ newState }) => newState).toSorted(),
          [
            'active',
            'archived',
            'deprecated',
            'inactive',
            'quarantined',
            'read_only',
            'suspended',
          ]
        );
      })
    );
  })
);

effectTest(
  'idempotent replay and same-state rejection create no duplicate history or evidence',
  Effect.gen(function* idempotentReplayAndSameStateRejection() {
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
    assert.equal(failureTag(replay), 'ActionAlreadyCommitted');

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
    assert.equal(failureTag(unchanged), 'TenantModuleStateUnchangedError');

    yield* withDatabase((database) =>
      Effect.gen(function* verifyIdempotentEvidence() {
        const history = yield* database.executor
          .select()
          .from(tenantModuleStateChanges)
          .where(eq(tenantModuleStateChanges.moduleKey, moduleKey));
        assert.equal(history.length, 1);
        const unchangedInvocation = yield* database.executor
          .select()
          .from(actionInvocations)
          .where(eq(actionInvocations.idempotencyKey, 'same-state'));
        assert.equal(unchangedInvocation.length, 1);
        const invocationId = unchangedInvocation[0]?.actionInvocationId ?? '';
        const unchangedAudit = yield* database.executor
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.actionInvocationId, invocationId));
        assert.equal(unchangedAudit.length, 0);
        const unchangedAccess = yield* database.executor
          .select()
          .from(dataAccessEvents)
          .where(eq(dataAccessEvents.actionInvocationId, invocationId));
        assert.equal(unchangedAccess.length, 0);
      })
    );
  })
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

effectTest(
  'rolls back history and Action evidence when current-state persistence fails',
  Effect.gen(function* rollbackFailedTenantModuleStateWrite() {
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
    assert.equal(
      failureTag(failure),
      'TenantModuleStatePersistenceUnavailableError',
      Exit.isFailure(failure) ? Cause.pretty(failure.cause) : 'success'
    );

    yield* withDatabase((database) =>
      Effect.gen(function* verifyFailedWriteRollback() {
        const states = yield* database.executor
          .select()
          .from(tenantModuleStates)
          .where(eq(tenantModuleStates.moduleKey, moduleKey));
        assert.equal(states.length, 0);
        const history = yield* database.executor
          .select()
          .from(tenantModuleStateChanges)
          .where(eq(tenantModuleStateChanges.moduleKey, moduleKey));
        assert.equal(history.length, 0);
        const [invocation] = yield* database.executor
          .select()
          .from(actionInvocations)
          .where(eq(actionInvocations.idempotencyKey, 'forced-failure'));
        assert.ok(invocation);
        const audits = yield* database.executor
          .select()
          .from(auditEvents)
          .where(
            eq(auditEvents.actionInvocationId, invocation.actionInvocationId)
          );
        assert.equal(audits.length, 0);
      })
    );
  })
);

effectTest(
  'serializes concurrent transitions into one truthful history chain',
  Effect.gen(function* serializeConcurrentTenantModuleStateTransitions() {
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
    assert.ok(exits.every(Exit.isSuccess));

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
        assert.equal(history.length, 3);
        const last = history.find(
          (row) => row.moduleStateChangeId === current?.lastChangeId
        );
        const concurrentFirst = history.find(
          (row) =>
            row.previousState === 'inactive' &&
            row.moduleStateChangeId !== last?.moduleStateChangeId
        );
        assert.ok(last);
        assert.ok(concurrentFirst);
        assert.equal(last.previousState, concurrentFirst.newState);
        assert.equal(current?.state, last.newState);
      })
    );
  })
);

effectTest(
  'derives tenant scope only from the trusted principal',
  Effect.gen(function* deriveTrustedTenantScope() {
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
        assert.deepEqual(
          Object.fromEntries(rows.map((row) => [row.tenantId, row.state])),
          {
            [tenantOne]: 'suspended',
            [tenantTwo]: 'active',
          }
        );
      })
    );
  })
);
