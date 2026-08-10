// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { and, eq } from 'drizzle-orm';
import { Effect, Exit } from 'effect';
import type { Context } from 'effect';
import type { CoreDatabase } from '../../src/db/client.ts';
import { makeCoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import { tenantModuleStates, tenants } from '../../src/db/schema.ts';
import type { CoreTransaction } from '../../src/db/types.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import {
  decideModuleStateAccess,
  makeModuleStateGate,
} from '../../src/modules/module-state-gate.ts';
import {
  TENANT_MODULE_STATES,
  makeTenantModuleStateService,
} from '../../src/modules/tenant-module-state-service.ts';

type DatabaseShape = Context.Service.Shape<typeof CoreDatabase>;

const withDatabase = <Value, Error>(
  operation: (database: DatabaseShape) => Effect.Effect<Value, Error>,
) =>
  Effect.scoped(
    Effect.gen(function* moduleStateGateDatabaseScope() {
      const configuration = yield* loadDatabaseConfig();
      const database = yield* makeCoreDatabase(configuration);
      return yield* operation(database);
    }),
  );

const databasePromise = <Value>(
  operation: (database: DatabaseShape) => PromiseLike<Value>,
): Promise<Value> =>
  Effect.runPromise(withDatabase((database) => Effect.promise(() => operation(database))));

test('batches tenant-isolated states once, rejects malformed/unavailable reads, and rechecks transactionally', async () => {
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
      const countingDatabase = {
        executor: new Proxy(database.executor, {
          get(target, property) {
            const value = Reflect.get(target, property, target) as unknown;
            if (property === 'select' && typeof value === 'function') {
              return (...arguments_: readonly unknown[]) => {
                selects += 1;
                return Reflect.apply(value as (...input: unknown[]) => unknown, target, [
                  ...arguments_,
                ]);
              };
            }
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      } as never;
      const gate = makeModuleStateGate(makeTenantModuleStateService(countingDatabase));
      const read = defineTenantModuleEntrypoint({
        access: 'read',
        entrypointKey: `${moduleKey}.page`,
        moduleKey,
        role: 'page',
      });
      const write = defineTenantModuleEntrypoint({
        access: 'write',
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
        TENANT_MODULE_STATES.map((_, index) => {
          const descriptor = persistedStateDescriptors[index];
          assert.ok(descriptor);
          return Effect.runPromise(Effect.exit(gate.check(persistedStateSnapshot, descriptor)));
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

      await database.executor.transaction((transaction) =>
        Effect.runPromise(gate.recheckWrite(transaction as CoreTransaction, tenantOne, write)),
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
      const lockedDenial = await database.executor.transaction((transaction) =>
        Effect.runPromise(
          Effect.flip(gate.recheckWrite(transaction as CoreTransaction, tenantOne, write)),
        ),
      );
      assert.equal(lockedDenial._tag, 'ModuleStateDeniedError');

      const unavailableDatabase = {
        executor: {
          select: () => ({
            from: () => ({
              where: () => ({
                orderBy: () => Promise.reject(new Error('secret db failure')),
              }),
            }),
          }),
        },
      } as never;
      const unavailable = await Effect.runPromise(
        Effect.flip(
          makeModuleStateGate(makeTenantModuleStateService(unavailableDatabase)).prepareSnapshot(
            tenantOne,
            [read],
          ),
        ),
      );
      assert.equal(unavailable._tag, 'ModuleStateCheckUnavailableError');
      assert.doesNotMatch(unavailable.reason, /secret|db failure/u);

      const malformedDatabase = {
        executor: {
          select: () => ({
            from: () => ({
              where: () => ({
                orderBy: () => Promise.resolve([{ moduleKey, state: 'corrupt-storage-value' }]),
              }),
            }),
          }),
        },
      } as never;
      const malformed = await Effect.runPromise(
        Effect.flip(
          makeModuleStateGate(makeTenantModuleStateService(malformedDatabase)).prepareSnapshot(
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
