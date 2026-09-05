// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { and, eq } from 'drizzle-orm';
import { Effect, Exit } from 'effect';
import type { CoreDatabase } from '../../src/db/client.ts';
import { makeCoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import { tenantModuleStates, tenants } from '../../src/db/schema.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import {
  decideModuleStateAccess,
  makeModuleStateGate,
} from '../../src/modules/module-state-gate.ts';
import {
  TENANT_MODULE_STATES,
  makeTenantModuleStateService,
} from '../../src/modules/tenant-module-state-service.ts';
import { TenantModuleStateReadUnavailableError } from '../../src/modules/tenant-module-state-errors.ts';
import type { TenantModuleStateServiceContract } from '../../src/modules/tenant-module-state-service.ts';

type DatabaseService = (typeof CoreDatabase)['Service'];

const withDatabase = <Value, Error>(
  operation: (database: DatabaseService) => Effect.Effect<Value, Error>,
) =>
  Effect.scoped(
    Effect.gen(function* moduleStateGateDatabaseScope() {
      const configuration = yield* loadDatabaseConfig();
      const database = yield* makeCoreDatabase(configuration);
      return yield* operation(database);
    }),
  );

const databasePromise = async <Value>(
  operation: (database: DatabaseService) => PromiseLike<Value>,
): Promise<Value> =>
  await Effect.runPromise(withDatabase((database) => Effect.promise(() => operation(database))));

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

void test('batches tenant-isolated states once, rejects malformed/unavailable reads, and rechecks transactionally', async () => {
  const tenantOne = randomUUID();
  const tenantTwo = randomUUID();
  const moduleKey = `gate.integration-${tenantOne}`;
  const stateModuleKey = (state: (typeof TENANT_MODULE_STATES)[number]): string =>
    `${moduleKey}.${state.replaceAll('_', '-')}`;
  await databasePromise(async (database) => {
    await database.executor.insert(tenants).values([
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
    await database.executor.insert(tenantModuleStates).values([
      { moduleKey, state: 'active', tenantId: tenantOne },
      { moduleKey, state: 'quarantined', tenantId: tenantTwo },
      ...TENANT_MODULE_STATES.map((state) => ({
        moduleKey: stateModuleKey(state),
        state,
        tenantId: tenantOne,
      })),
    ]);

    try {
      let selects = 0;
      const countingExecutor: DatabaseService['executor'] = Object.create(database.executor);
      Object.defineProperty(countingExecutor, 'select', {
        configurable: true,
        get: () => {
          selects += 1;
          return database.executor.select;
        },
      });
      const gate = makeModuleStateGate(
        makeTenantModuleStateService({ executor: countingExecutor }),
      );
      const read = defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: `${moduleKey}.page`,
        moduleKey,
        role: 'page',
      });
      const write = defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: `${moduleKey}.write`,
        moduleKey,
        role: 'action',
      });
      const snapshot = await Effect.runPromise(
        gate.prepareSnapshot(tenantOne, [read, read, write]),
      );
      await Effect.runPromise(gate.check(snapshot, read));
      await Effect.runPromise(gate.check(snapshot, read));
      assert.equal(selects, 1);

      const persistedStateDescriptors = TENANT_MODULE_STATES.map((state) =>
        defineTenantModuleEntrypoint({
          access: 'read',
          authorization: { kind: 'context_permission', permission: 'module.access' },
          entrypointKey: `${stateModuleKey(state)}.page`,
          moduleKey: stateModuleKey(state),
          role: 'page',
        }),
      );
      selects = 0;
      const [firstPersistedDescriptor] = persistedStateDescriptors;
      assert.ok(firstPersistedDescriptor);
      const persistedStateSnapshot = await Effect.runPromise(
        gate.prepareSnapshot(tenantOne, [...persistedStateDescriptors, firstPersistedDescriptor]),
      );
      assert.equal(selects, 1);
      const persistedStateExits = await Promise.all(
        TENANT_MODULE_STATES.map(async (_, index) => {
          const descriptor = persistedStateDescriptors[index];
          assert.ok(descriptor);
          return await Effect.runPromise(
            Effect.exit(gate.check(persistedStateSnapshot, descriptor)),
          );
        }),
      );
      for (const [index, state] of TENANT_MODULE_STATES.entries()) {
        const descriptor = persistedStateDescriptors[index];
        assert.ok(descriptor);
        const exit = persistedStateExits[index];
        assert.ok(exit);
        assert.equal(
          Exit.isSuccess(exit),
          decideModuleStateAccess(state, 'read') === 'allow',
          state,
        );
      }

      const tenantTwoSnapshot = await Effect.runPromise(gate.prepareSnapshot(tenantTwo, [read]));
      const quarantined = await Effect.runPromise(Effect.flip(gate.check(tenantTwoSnapshot, read)));
      assert.equal(quarantined._tag, 'ModuleStateDeniedError');

      const missingDescriptor = defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: `${moduleKey}.missing`,
        moduleKey: `${moduleKey}.missing-module`,
        role: 'page',
      });
      const missingSnapshot = await Effect.runPromise(
        gate.prepareSnapshot(tenantOne, [missingDescriptor]),
      );
      const missing = await Effect.runPromise(
        Effect.flip(gate.check(missingSnapshot, missingDescriptor)),
      );
      assert.equal(missing._tag, 'ModuleStateDeniedError');

      await database.executor.transaction(
        async (transaction) =>
          await Effect.runPromise(gate.recheckWrite(transaction, tenantOne, write)),
      );
      await database.executor
        .update(tenantModuleStates)
        .set({ state: 'read_only' })
        .where(
          and(
            eq(tenantModuleStates.tenantId, tenantOne),
            eq(tenantModuleStates.moduleKey, moduleKey),
          ),
        );
      const lockedDenial = await database.executor.transaction(
        async (transaction) =>
          await Effect.runPromise(Effect.flip(gate.recheckWrite(transaction, tenantOne, write))),
      );
      assert.equal(lockedDenial._tag, 'ModuleStateDeniedError');

      const unavailable = await Effect.runPromise(
        Effect.flip(
          makeModuleStateGate(unavailableStateService('secret db failure')).prepareSnapshot(
            tenantOne,
            [read],
          ),
        ),
      );
      assert.equal(unavailable._tag, 'ModuleStateCheckUnavailableError');
      assert.doesNotMatch(unavailable.reason, /secret|db failure/u);

      const malformed = await Effect.runPromise(
        Effect.flip(
          makeModuleStateGate(unavailableStateService('corrupt-storage-value')).prepareSnapshot(
            tenantOne,
            [read],
          ),
        ),
      );
      assert.equal(malformed._tag, 'ModuleStateCheckUnavailableError');
      assert.doesNotMatch(malformed.reason, /corrupt|storage/u);
    } finally {
      await database.executor
        .delete(tenantModuleStates)
        .where(eq(tenantModuleStates.tenantId, tenantOne));
      await database.executor
        .delete(tenantModuleStates)
        .where(eq(tenantModuleStates.tenantId, tenantTwo));
      await database.executor.delete(tenants).where(eq(tenants.tenantId, tenantOne));
      await database.executor.delete(tenants).where(eq(tenants.tenantId, tenantTwo));
    }
  });
});
