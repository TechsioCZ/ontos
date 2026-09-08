import { expect, it } from 'effect-rstest';
import { and, eq } from 'drizzle-orm';
import { Effect, Exit, Option, Predicate } from 'effect';
import { randomUUID } from 'node:crypto';
import type { CoreDatabase } from '../../src/db/client.ts';
import { makeCoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import { tenantModuleStates, tenants } from '../../src/db/schema.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import {
  decideModuleStateAccess,
  makeModuleStateGate,
} from '../../src/modules/module-state-gate.ts';
import { TenantModuleStateReadUnavailableError } from '../../src/modules/tenant-module-state-errors.ts';
import type { TenantModuleStateServiceContract } from '../../src/modules/tenant-module-state-service.ts';
import {
  TENANT_MODULE_STATES,
  makeTenantModuleStateService,
} from '../../src/modules/tenant-module-state-service.ts';

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

it.live(
  'batches tenant-isolated states once, rejects malformed/unavailable reads, and rechecks transactionally',
  () =>
    Effect.gen(function* moduleStateGate1() {
      const tenantOne = randomUUID();
      const tenantTwo = randomUUID();
      const moduleKey = `gate.integration-${tenantOne}`;
      const stateModuleKey = (state: (typeof TENANT_MODULE_STATES)[number]): string =>
        `${moduleKey}.${state.replaceAll('_', '-')}`;
      const configuration = yield* loadDatabaseConfig();
      const database = yield* makeCoreDatabase(configuration);
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* moduleStateGate2() {
          yield* database.executor
            .delete(tenantModuleStates)
            .where(eq(tenantModuleStates.tenantId, tenantOne));
          yield* database.executor
            .delete(tenantModuleStates)
            .where(eq(tenantModuleStates.tenantId, tenantTwo));
          yield* database.executor.delete(tenants).where(eq(tenants.tenantId, tenantOne));
          yield* database.executor.delete(tenants).where(eq(tenants.tenantId, tenantTwo));
        }).pipe(Effect.orDie),
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
      const snapshot = yield* gate.prepareSnapshot(tenantOne, [read, read, write]);
      yield* gate.check(snapshot, read);
      yield* gate.check(snapshot, read);
      expect(selects).toBe(1);

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
      const firstPersistedDescriptor = Option.getOrThrow(
        Option.fromNullishOr(persistedStateDescriptors[0]),
      );
      expect(firstPersistedDescriptor).toBeDefined();
      const persistedStateSnapshot = yield* gate.prepareSnapshot(tenantOne, [
        ...persistedStateDescriptors,
        firstPersistedDescriptor,
      ]);
      expect(selects).toBe(1);
      const persistedStateExits = yield* Effect.forEach(
        TENANT_MODULE_STATES,
        (_, index) => {
          const descriptor = Option.getOrThrow(
            Option.fromNullishOr(persistedStateDescriptors[index]),
          );
          expect(descriptor).toBeDefined();
          return Effect.exit(gate.check(persistedStateSnapshot, descriptor));
        },
        { concurrency: 'unbounded' },
      );
      for (const [index, state] of TENANT_MODULE_STATES.entries()) {
        const descriptor = Option.getOrThrow(
          Option.fromNullishOr(persistedStateDescriptors[index]),
        );
        expect(descriptor).toBeDefined();
        const exit = Option.getOrThrow(Option.fromNullishOr(persistedStateExits[index]));
        expect(exit).toBeDefined();
        expect(Exit.isSuccess(exit), state).toBe(
          decideModuleStateAccess(state, 'read') === 'allow',
        );
      }

      const tenantTwoSnapshot = yield* gate.prepareSnapshot(tenantTwo, [read]);
      const quarantined = yield* Effect.flip(gate.check(tenantTwoSnapshot, read));
      expect(Predicate.isTagged(quarantined, 'ModuleStateDeniedError')).toBe(true);

      const missingDescriptor = defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: `${moduleKey}.missing`,
        moduleKey: `${moduleKey}.missing-module`,
        role: 'page',
      });
      const missingSnapshot = yield* gate.prepareSnapshot(tenantOne, [missingDescriptor]);
      const missing = yield* Effect.flip(gate.check(missingSnapshot, missingDescriptor));
      expect(Predicate.isTagged(missing, 'ModuleStateDeniedError')).toBe(true);

      yield* database.executor.transaction((transaction) =>
        gate.recheckWrite(transaction, tenantOne, write),
      );
      yield* database.executor
        .update(tenantModuleStates)
        .set({ state: 'read_only' })
        .where(
          and(
            eq(tenantModuleStates.tenantId, tenantOne),
            eq(tenantModuleStates.moduleKey, moduleKey),
          ),
        );
      const lockedDenial = yield* database.executor.transaction((transaction) =>
        Effect.flip(gate.recheckWrite(transaction, tenantOne, write)),
      );
      expect(Predicate.isTagged(lockedDenial, 'ModuleStateDeniedError')).toBe(true);

      const unavailable = yield* Effect.flip(
        makeModuleStateGate(unavailableStateService('secret db failure')).prepareSnapshot(
          tenantOne,
          [read],
        ),
      );
      expect(Predicate.isTagged(unavailable, 'ModuleStateCheckUnavailableError')).toBe(true);
      expect(unavailable.reason).not.toMatch(/secret|db failure/u);

      const malformed = yield* Effect.flip(
        makeModuleStateGate(unavailableStateService('corrupt-storage-value')).prepareSnapshot(
          tenantOne,
          [read],
        ),
      );
      expect(Predicate.isTagged(malformed, 'ModuleStateCheckUnavailableError')).toBe(true);
      expect(malformed.reason).not.toMatch(/corrupt|storage/u);
    }),
);
