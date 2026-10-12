import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { Deferred, Effect, Exit, Fiber, Option, Predicate, Schema, Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import type { CoreDatabase } from '../../src/db/client.ts';
import { makeCoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConfig, loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations, dataAccessEvents, tenantModuleStates, tenants } from '../../src/db/schema.ts';
import { defineSystemModuleEntrypoint, defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { makeSystemPrincipalContextResolver, registerSystemWorkload } from '../../src/auth/system-principal-context.ts';
import { makeOperationalScopeRepository, makeOperationalScopeResolver } from '../../src/operations/context.ts';
import { defineRead } from '../../src/reads/definition.ts';
import { makeReadRuntime } from '../../src/reads/runtime.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { openModuleEntrypointGateway } from '../support/open-module-entrypoint-gateway.ts';
import { decideModuleStateAccess, makeModuleStateGate } from '../../src/modules/module-state-gate.ts';
import { TenantModuleStateReadUnavailableError } from '../../src/modules/tenant-module-state-errors.ts';
import { ModuleStateDeniedError } from '../../src/modules/module-state-gate-errors.ts';
import type { TenantModuleStateServiceContract } from '../../src/modules/tenant-module-state-service.ts';
import { TENANT_MODULE_STATES, makeTenantModuleStateService } from '../../src/modules/tenant-module-state-service.ts';

type DatabaseService = (typeof CoreDatabase)['Service'];

const unavailableStateService = (reason: string): TenantModuleStateServiceContract => {
  const failure = new TenantModuleStateReadUnavailableError({
    code: 'tenant_module_state_read_unavailable',
    reason,
  });
  return {
    getTenantModuleStates: () => Effect.fail(failure),
    listActiveTenantModules: () => Effect.fail(failure),
    listTenantModuleStates: () => Effect.fail(failure),
  };
};

it.live('batches tenant-isolated states once, rejects malformed/unavailable reads, and rechecks transactionally', () =>
  Effect.gen(function* moduleStateGate1() {
    const tenantOne = randomUUID();
    const tenantTwo = randomUUID();
    const moduleKey = `gate.integration-${tenantOne}`;
    const stateModuleKey = (state: (typeof TENANT_MODULE_STATES)[number]): string =>
      `${moduleKey}.${state.replaceAll('_', '-')}`;
    const configuration = yield* loadDatabaseConfig();
    const database = yield* makeCoreDatabase(configuration);
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [tenantModuleStates, tenants],
        (table) =>
          Effect.forEach(
            [tenantOne, tenantTwo],
            (tenantId) => database.executor.delete(table).where(eq(table.tenantId, tenantId)),
            { discard: true },
          ),
        { discard: true },
      ).pipe(Effect.orDie),
    );
    yield* database.executor.insert(tenants).values([
      {
        defaultLocale: 'en',
        name: 'Gate Integration One',
        slug: `gate-one-${tenantOne}`,
        status: 'active',
        tenantId: tenantOne,
      },
      {
        defaultLocale: 'en',
        name: 'Gate Integration Two',
        slug: `gate-two-${tenantTwo}`,
        status: 'active',
        tenantId: tenantTwo,
      },
    ]);
    yield* database.executor.insert(tenantModuleStates).values([
      { moduleKey, state: 'active', tenantId: tenantOne },
      { moduleKey, state: 'quarantined', tenantId: tenantTwo },
      ...TENANT_MODULE_STATES.map((state) => ({
        moduleKey: stateModuleKey(state),
        state,
        tenantId: tenantOne,
      })),
    ]);

    let selects = 0;
    const countingExecutor: DatabaseService['executor'] = Object.create(database.executor);
    Object.defineProperty(countingExecutor, 'select', {
      configurable: true,
      get: () => {
        selects += 1;
        return database.executor.select;
      },
    });
    const gate = makeModuleStateGate(makeTenantModuleStateService({ executor: countingExecutor }));
    const read = defineTenantModuleEntrypoint({
      access: 'read',
      authorization: {
        kind: 'context_permission',
        permission: 'module.access',
      },
      entrypointKey: `${moduleKey}.page`,
      moduleKey,
      role: 'page',
    });
    const write = defineTenantModuleEntrypoint({
      access: 'write',
      authorization: {
        kind: 'action_execution',
        provisioning: 'tenant_membership_default',
      },
      entrypointKey: `${moduleKey}.write`,
      moduleKey,
      role: 'action',
    });
    const snapshot = yield* gate.prepareSnapshot(tenantOne, [read, read, write]);
    yield* gate.check(snapshot, read);
    yield* gate.check(snapshot, read);
    expect(selects).toBe(1);

    const persistedStateDescriptors = TENANT_MODULE_STATES.map((state) =>
      defineTenantModuleEntrypoint({
        access: 'read',
        authorization: {
          kind: 'context_permission',
          permission: 'module.access',
        },
        entrypointKey: `${stateModuleKey(state)}.page`,
        moduleKey: stateModuleKey(state),
        role: 'page',
      }),
    );
    selects = 0;
    const firstPersistedDescriptor = Option.getOrThrow(Option.fromNullishOr(persistedStateDescriptors[0]));
    expect(firstPersistedDescriptor).toBeDefined();
    const persistedStateSnapshot = yield* gate.prepareSnapshot(tenantOne, [
      ...persistedStateDescriptors,
      firstPersistedDescriptor,
    ]);
    expect(selects).toBe(1);
    const persistedStateExits = yield* Effect.forEach(
      TENANT_MODULE_STATES,
      (_, index) => {
        const descriptor = Option.getOrThrow(Option.fromNullishOr(persistedStateDescriptors[index]));
        expect(descriptor).toBeDefined();
        return Effect.exit(gate.check(persistedStateSnapshot, descriptor));
      },
      { concurrency: 'unbounded' },
    );
    for (const [index, state] of TENANT_MODULE_STATES.entries()) {
      const descriptor = Option.getOrThrow(Option.fromNullishOr(persistedStateDescriptors[index]));
      expect(descriptor).toBeDefined();
      const exit = Option.getOrThrow(Option.fromNullishOr(persistedStateExits[index]));
      expect(exit).toBeDefined();
      expect(Exit.isSuccess(exit), state).toBe(decideModuleStateAccess(state, 'read') === 'allow');
    }

    const tenantTwoSnapshot = yield* gate.prepareSnapshot(tenantTwo, [read]);
    const quarantined = yield* Effect.flip(gate.check(tenantTwoSnapshot, read));
    expect(Predicate.isTagged(quarantined, 'ModuleStateDeniedError')).toBe(true);

    const missingDescriptor = defineTenantModuleEntrypoint({
      access: 'read',
      authorization: {
        kind: 'context_permission',
        permission: 'module.access',
      },
      entrypointKey: `${moduleKey}.missing`,
      moduleKey: `${moduleKey}.missing-module`,
      role: 'page',
    });
    const missingSnapshot = yield* gate.prepareSnapshot(tenantOne, [missingDescriptor]);
    const missing = yield* Effect.flip(gate.check(missingSnapshot, missingDescriptor));
    expect(Predicate.isTagged(missing, 'ModuleStateDeniedError')).toBe(true);

    yield* database.executor.transaction((transaction) => gate.recheckWrite(transaction, tenantOne, write));
    yield* database.executor
      .update(tenantModuleStates)
      .set({ state: 'read_only' })
      .where(and(eq(tenantModuleStates.tenantId, tenantOne), eq(tenantModuleStates.moduleKey, moduleKey)));
    const lockedDenial = yield* database.executor.transaction((transaction) =>
      Effect.flip(gate.recheckWrite(transaction, tenantOne, write)),
    );
    expect(Predicate.isTagged(lockedDenial, 'ModuleStateDeniedError')).toBe(true);

    const unavailable = yield* Effect.flip(
      makeModuleStateGate(unavailableStateService('secret db failure')).prepareSnapshot(tenantOne, [read]),
    );
    expect(Predicate.isTagged(unavailable, 'ModuleStateCheckUnavailableError')).toBe(true);
    expect(unavailable.reason).not.toMatch(/secret|db failure/u);

    const malformed = yield* Effect.flip(
      makeModuleStateGate(unavailableStateService('corrupt-storage-value')).prepareSnapshot(tenantOne, [read]),
    );
    expect(Predicate.isTagged(malformed, 'ModuleStateCheckUnavailableError')).toBe(true);
    expect(malformed.reason).not.toMatch(/corrupt|storage/u);
  }),
);

it.live('allows nested governed-read evidence under the write fence while serializing module-state changes', () =>
  Effect.gen(function* compatibleTenantWriteFence() {
    const lifetime = yield* Scope.Scope;
    const connections = yield* loadDatabaseConnectionPair();
    const parentClient = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
    const childClient = yield* makeTestPgClient(connections.runtime.connectionString, { maxConnections: 1 });
    const parentDatabase = yield* makeTestDatabaseFromClient(parentClient, coreRelations);
    const childDatabase = yield* makeTestDatabaseFromClient(childClient, coreRelations);
    const tenantId = randomUUID();
    const principalId = randomUUID();
    const moduleKey = `gate.nested-read-${tenantId}`;
    const readKey = `${moduleKey}.read`;
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* cleanupFenceFixture() {
        yield* parentClient.unsafe('delete from core.data_access_events where tenant_id = $1', [tenantId]);
        yield* parentClient.unsafe('delete from core.tenant_module_states where tenant_id = $1', [tenantId]);
        yield* parentClient.unsafe('delete from core.principals where tenant_id = $1', [tenantId]);
        yield* parentClient.unsafe('delete from core.tenants where tenant_id = $1', [tenantId]);
      }).pipe(Effect.orDie),
    );
    yield* parentClient.unsafe(
      "insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $2, 'Nested Read fence', 'active', 'en')",
      [tenantId, `nested-read-${tenantId}`],
    );
    yield* parentClient.unsafe(
      "insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $2, 'system', 'Fence principal', 'active')",
      [principalId, tenantId],
    );
    yield* parentClient.unsafe(
      "insert into core.tenant_module_states (tenant_id, module_key, state) values ($1, $2, 'active')",
      [tenantId, moduleKey],
    );
    const access = {
      legalEntities: () => Effect.succeed([]),
      modules: () => Effect.succeed([]),
      resources: () => Effect.succeed([]),
      tenants: () => Effect.succeed([]),
    };
    const principal = yield* makeSystemPrincipalContextResolver({ executor: childDatabase }).resolve({
      principalId,
      registration: registerSystemWorkload({ jobKey: 'nested-read-fence-integration' }),
      runReference: readKey,
      tenantId,
    });
    const read = defineRead(
      {
        accessKind: 'detail',
        entrypoint: defineSystemModuleEntrypoint({
          access: 'read',
          authorization: { kind: 'context_permission', permission: 'module.access' },
          entrypointKey: readKey,
          moduleKey: 'core.shell',
          role: 'api',
        }),
        evidencePolicy: { captureMode: 'metadata_only', policyKey: `${readKey}.v1` },
        inputSchema: Schema.Struct({}),
        legalEntityScope: 'forbidden',
        owningModuleKey: 'core.shell',
        permissionTarget: 'module',
        policies: [],
        readKey,
        resultSchema: Schema.Array(Schema.String),
        schemaVersion: '1',
      },
      () => Effect.succeed({ evidence: { resultCount: 1 }, result: ['visible'] }),
      () => Effect.succeed({}),
      () => ({ kind: 'module', moduleId: 'core.shell' }),
    );
    const readRuntime = makeReadRuntime(
      { executor: childDatabase },
      openModuleEntrypointGateway,
      makeOperationalScopeResolver(makeOperationalScopeRepository({ executor: childDatabase }), access),
      access,
    );
    const gate = makeModuleStateGate(makeTenantModuleStateService({ executor: parentDatabase }));
    const write = defineTenantModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'action_execution', provisioning: 'explicit' },
      entrypointKey: `${moduleKey}.write`,
      moduleKey,
      role: 'action',
    });
    const [childBackend] = yield* childClient.unsafe<{ readonly pid: number }>('select pg_backend_pid() as pid');
    const childPid = Option.getOrThrow(Option.fromNullishOr(childBackend)).pid;
    const writeAcquired = yield* Deferred.make<boolean>();
    const writer = yield* parentDatabase.transaction(
      Effect.fn(function* holdParentFence(transaction) {
        yield* gate.recheckWrite(transaction, tenantId, write);
        const [parentBackend] = yield* transaction.execute<{ readonly pid: number }>(
          sql`select pg_backend_pid() as pid`,
          'objects',
        );
        const parentPid = Option.getOrThrow(Option.fromNullishOr(parentBackend)).pid;
        expect(parentPid).not.toBe(childPid);
        expect(
          yield* readRuntime.runRead({
            input: {},
            principal,
            registration: read,
            transport: { correlationId: randomUUID() },
          }),
        ).toEqual(['visible']);
        const evidence = yield* transaction
          .select({ id: dataAccessEvents.dataAccessEventId })
          .from(dataAccessEvents)
          .where(eq(dataAccessEvents.tenantId, tenantId));
        expect(evidence).toHaveLength(1);
        const competingWrite = yield* Effect.forkIn(
          childClient.withTransaction(
            Effect.gen(function* changeModuleState() {
              yield* childClient.unsafe("select set_config('ontos.tenant_id', $1, true)", [tenantId]);
              yield* childClient.unsafe('select tenant_id from core.tenants where tenant_id = $1 for update', [
                tenantId,
              ]);
              yield* Deferred.succeed(writeAcquired, true);
              yield* childClient.unsafe(
                "update core.tenant_module_states set state = 'read_only' where tenant_id = $1 and module_key = $2",
                [tenantId, moduleKey],
              );
            }),
          ),
          lifetime,
        );
        let blocked = false;
        for (let observation = 0; observation < 100 && !blocked; observation += 1) {
          const rows = yield* transaction.execute<{ readonly blocked: boolean }>(
            sql`select ${parentPid} = any(pg_blocking_pids(${childPid})) as blocked`,
            'objects',
          );
          blocked = rows[0]?.blocked === true;
          yield* Effect.yieldNow;
        }
        expect(blocked).toBe(true);
        expect(yield* Deferred.isDone(writeAcquired)).toBe(false);
        return competingWrite;
      }),
    );
    yield* Fiber.join(writer);
    expect(yield* Deferred.isDone(writeAcquired)).toBe(true);
    const state = yield* parentDatabase
      .select({ state: tenantModuleStates.state })
      .from(tenantModuleStates)
      .where(and(eq(tenantModuleStates.tenantId, tenantId), eq(tenantModuleStates.moduleKey, moduleKey)));
    expect(state[0]?.state).toBe('read_only');
    const denied = yield* parentDatabase.transaction((transaction) =>
      Effect.flip(gate.recheckWrite(transaction, tenantId, write)),
    );
    expect(Schema.is(ModuleStateDeniedError)(denied)).toBe(true);
  }).pipe(Effect.timeout('5 seconds')),
);
