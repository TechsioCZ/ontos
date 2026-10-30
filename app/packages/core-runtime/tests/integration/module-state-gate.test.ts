import { and, eq, inArray, sql } from 'drizzle-orm';
import { NodeCrypto } from '@effect/platform-node';
import { Cause, Crypto, Deferred, Effect, Exit, Fiber, Option, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import type { CoreDatabase } from '../../src/db/client.ts';
import { makeCoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import { SHARED_RUNTIME_IDENTITY } from '../../src/db/database-identities.ts';
import {
  actionInvocations,
  dataAccessEvents,
  principals,
  tenantModuleStateChanges,
  tenantModuleStates,
  tenants,
} from '../../src/db/schema.ts';
import { installOperationalScope } from '../../src/db/scoped-transaction.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { decideModuleStateAccess, makeModuleStateGate } from '../../src/modules/module-state-gate.ts';
import { TenantModuleStateReadUnavailableError } from '../../src/modules/tenant-module-state-errors.ts';
import type { TenantModuleStateServiceContract } from '../../src/modules/tenant-module-state-service.ts';
import {
  TENANT_MODULE_STATES,
  makeTenantModuleStateService,
  persistTenantModuleStateChange,
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

it.layer(NodeCrypto.layer, { excludeTestServices: true })('module state gate', (suite) => {
  suite.effect(
    'batches tenant-isolated states once, rejects malformed/unavailable reads, and rechecks transactionally',
    () =>
      Effect.gen(function* moduleStateGate1() {
        const crypto = yield* Crypto.Crypto;
        const tenantOne = yield* crypto.randomUUIDv4();
        const tenantTwo = yield* crypto.randomUUIDv4();
        const moduleKey = `gate.integration-${tenantOne}`;
        const stateModuleKey = (state: (typeof TENANT_MODULE_STATES)[number]): string =>
          `${moduleKey}.${state.replaceAll('_', '-')}`;
        const configuration = yield* loadDatabaseConfig({ identity: SHARED_RUNTIME_IDENTITY });
        const database = yield* makeCoreDatabase(configuration);
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            [tenantModuleStates, tenants],
            (table) => database.executor.delete(table).where(inArray(table.tenantId, [tenantOne, tenantTwo])),
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
});

const concurrentGateFixture = Effect.gen(function* concurrentGateFixtureEffect() {
  const crypto = yield* Crypto.Crypto;
  const tenantId = yield* crypto.randomUUIDv4();
  const principalId = yield* crypto.randomUUIDv4();
  const actionInvocationId = yield* crypto.randomUUIDv4();
  const moduleKey = `gate.concurrent-${tenantId}`;
  const configuration = yield* loadDatabaseConfig({ identity: SHARED_RUNTIME_IDENTITY });
  // Distinct one-connection pools make each transaction's physical connection explicit.
  const observer = yield* makeCoreDatabase({ ...configuration, maxConnections: 1 });
  const writer = yield* makeCoreDatabase({ ...configuration, maxConnections: 1 });
  const transition = yield* makeCoreDatabase({ ...configuration, maxConnections: 1 });
  const evidence = yield* makeCoreDatabase({ ...configuration, maxConnections: 1 });
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* cleanupConcurrentGateFixture() {
      for (const table of [
        dataAccessEvents,
        tenantModuleStateChanges,
        tenantModuleStates,
        actionInvocations,
        principals,
        tenants,
      ]) {
        yield* observer.executor.delete(table).where(eq(table.tenantId, tenantId));
      }
    }).pipe(Effect.orDie),
  );
  yield* observer.executor
    .insert(tenants)
    .values({ defaultLocale: 'en', name: 'Concurrent gate', slug: `gate-${tenantId}`, status: 'active', tenantId });
  yield* observer.executor
    .insert(principals)
    .values({ displayName: 'Gate principal', kind: 'human', principalId, status: 'active', tenantId });
  yield* observer.executor.insert(actionInvocations).values({
    actionInvocationId,
    actionKey: 'core.change-tenant-module-state',
    principalId,
    requestHash: 'gate-concurrency',
    status: 'received',
    tenantId,
  });
  yield* observer.executor.insert(tenantModuleStates).values({ moduleKey, state: 'active', tenantId });
  const gate = makeModuleStateGate(makeTenantModuleStateService(observer));
  const write = defineTenantModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
    entrypointKey: `${moduleKey}.write`,
    moduleKey,
    role: 'action',
  });
  const disable = (transaction: Parameters<Parameters<DatabaseService['executor']['transaction']>[0]>[0]) =>
    installOperationalScope(transaction, {
      authContextRef: 'better-auth-session:gate',
      authMethod: 'session',
      correlationId: 'gate-concurrency',
      principalId,
      tenantId,
    }).pipe(
      Effect.flatMap((scoped) =>
        persistTenantModuleStateChange(scoped, {
          actionInvocationId,
          authMethod: 'session',
          expectedState: 'active',
          moduleKey,
          newState: 'read_only',
          principalId,
          tenantId,
        }),
      ),
    );
  const insertEvidence = (targetResourceId: string, started?: Deferred.Deferred<number>) =>
    evidence.executor.transaction((transaction) =>
      Effect.gen(function* evidenceTransaction() {
        if (started !== undefined) {
          const [connection] = yield* transaction.execute<{ pid: number }>(
            sql`select pg_backend_pid() as pid`,
            'objects',
          );
          yield* Deferred.succeed(started, Option.getOrThrow(Option.fromUndefinedOr(connection)).pid);
        }
        yield* transaction.insert(dataAccessEvents).values({
          accessKind: 'read',
          authMethod: 'session',
          evidenceCaptureMode: 'metadata_only',
          evidencePolicyKey: 'gate-test',
          outcome: 'allowed',
          outcomeCode: 'allowed',
          outcomeStage: 'evidence',
          principalId,
          resultCount: 1,
          servingModuleKey: moduleKey,
          targetResourceId,
          tenantId,
        });
      }),
    );
  const waitForBlock = (blocker: number, waiter: number) =>
    Effect.gen(function* observeBlockedConnection() {
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        const rows = yield* observer.executor.execute<{ blocked: boolean }>(
          sql`select ${blocker}::integer = any(pg_blocking_pids(${waiter}::integer)) as blocked`,
          'objects',
        );
        if (rows[0]?.blocked === true) {
          return;
        }
        yield* Effect.yieldNow;
      }
      expect.fail('The competing transaction never waited on the expected tenant-lock holder');
    });
  return {
    disable,
    evidence,
    gate,
    insertEvidence,
    moduleKey,
    observer,
    tenantId,
    transition,
    waitForBlock,
    write,
    writer,
  };
});

it.layer(NodeCrypto.layer, { excludeTestServices: true })('module state gate concurrency', (suite) => {
  suite.effect('admits independent tenant-FK evidence while retaining the disabling fence through commit', () =>
    Effect.scoped(
      Effect.gen(function* writeWinsTenantLock() {
        const fixture = yield* concurrentGateFixture;
        const admitted = yield* Deferred.make<number>();
        const releaseWrite = yield* Deferred.make<boolean>();
        const transitionStarted = yield* Deferred.make<number>();
        const writer = yield* fixture.writer.executor
          .transaction((transaction) =>
            Effect.gen(function* admittedTransaction() {
              const [connection] = yield* transaction.execute<{ pid: number }>(
                sql`select pg_backend_pid() as pid`,
                'objects',
              );
              yield* fixture.gate.recheckWrite(transaction, fixture.tenantId, fixture.write);
              yield* Deferred.succeed(admitted, Option.getOrThrow(Option.fromUndefinedOr(connection)).pid);
              yield* Deferred.await(releaseWrite);
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseWrite, true));
        const writerPid = yield* Deferred.await(admitted);
        const evidenceStarted = yield* Deferred.make<number>();
        // Observe either its actual FK wait or its durable commit, without timing guesses.
        const evidence = yield* fixture.insertEvidence('nested-read', evidenceStarted).pipe(Effect.forkScoped);
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseWrite, true));
        const evidencePid = yield* Deferred.await(evidenceStarted);
        expect(evidencePid).not.toBe(writerPid);
        let observed = false;
        for (let attempt = 0; attempt < 1000; attempt += 1) {
          const [progress] = yield* fixture.observer.executor.execute<{ blocked: boolean; committed: boolean }>(
            sql`select ${writerPid}::integer = any(pg_blocking_pids(${evidencePid}::integer)) as blocked, exists(select 1 from core.data_access_events where tenant_id = ${fixture.tenantId}::uuid) as committed`,
            'objects',
          );
          if (progress?.blocked === true || progress?.committed === true) {
            observed = true;
            expect(progress.blocked).toBe(false);
            expect(progress.committed).toBe(true);
            break;
          }
          yield* Effect.yieldNow;
        }
        expect(observed).toBe(true);
        yield* Fiber.join(evidence);
        const transition = yield* fixture.transition.executor
          .transaction((transaction) =>
            Effect.gen(function* disablingTransaction() {
              const [connection] = yield* transaction.execute<{ pid: number }>(
                sql`select pg_backend_pid() as pid`,
                'objects',
              );
              yield* Deferred.succeed(transitionStarted, Option.getOrThrow(Option.fromUndefinedOr(connection)).pid);
              return yield* fixture.disable(transaction);
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseWrite, true));
        const transitionPid = yield* Deferred.await(transitionStarted);
        expect(transitionPid).not.toBe(writerPid);
        yield* fixture.waitForBlock(writerPid, transitionPid);
        const [before] = yield* fixture.observer.executor
          .select()
          .from(tenantModuleStates)
          .where(eq(tenantModuleStates.tenantId, fixture.tenantId));
        expect(before?.state).toBe('active');
        yield* Deferred.succeed(releaseWrite, true);
        yield* Fiber.join(writer);
        const changed = yield* Fiber.join(transition);
        expect(changed).toMatchObject({ newState: 'read_only', previousState: 'active' });
        const rows = yield* fixture.observer.executor
          .select()
          .from(dataAccessEvents)
          .where(eq(dataAccessEvents.tenantId, fixture.tenantId));
        expect(rows.map((row) => row.targetResourceId)).toEqual(['nested-read']);
        const [state] = yield* fixture.observer.executor
          .select()
          .from(tenantModuleStates)
          .where(eq(tenantModuleStates.tenantId, fixture.tenantId));
        const [history] = yield* fixture.observer.executor
          .select()
          .from(tenantModuleStateChanges)
          .where(eq(tenantModuleStateChanges.tenantId, fixture.tenantId));
        expect(state?.state).toBe('read_only');
        expect(state?.lastChangeId).toBe(history?.moduleStateChangeId);
      }),
    ),
  );
  suite.effect('denies a waiting write after disabling wins, despite an active preflight snapshot', () =>
    Effect.scoped(
      Effect.gen(function* disableWinsTenantLock() {
        const fixture = yield* concurrentGateFixture;
        const snapshot = yield* fixture.gate.prepareSnapshot(fixture.tenantId, [fixture.write]);
        yield* fixture.gate.check(snapshot, fixture.write);
        const disabled = yield* Deferred.make<number>();
        const releaseDisable = yield* Deferred.make<boolean>();
        const writerStarted = yield* Deferred.make<number>();
        const transition = yield* fixture.transition.executor
          .transaction((transaction) =>
            Effect.gen(function* heldDisablingTransaction() {
              const [connection] = yield* transaction.execute<{ pid: number }>(
                sql`select pg_backend_pid() as pid`,
                'objects',
              );
              yield* fixture.disable(transaction);
              yield* Deferred.succeed(disabled, Option.getOrThrow(Option.fromUndefinedOr(connection)).pid);
              yield* Deferred.await(releaseDisable);
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseDisable, true));
        const transitionPid = yield* Deferred.await(disabled);
        let handlerCalls = 0;
        const writer = yield* fixture.writer.executor
          .transaction((transaction) =>
            Effect.gen(function* waitingWriteTransaction() {
              const [connection] = yield* transaction.execute<{ pid: number }>(
                sql`select pg_backend_pid() as pid`,
                'objects',
              );
              yield* Deferred.succeed(writerStarted, Option.getOrThrow(Option.fromUndefinedOr(connection)).pid);
              yield* fixture.gate.recheckWrite(transaction, fixture.tenantId, fixture.write);
              handlerCalls += 1;
              yield* fixture.insertEvidence('forbidden-handler');
            }),
          )
          .pipe(Effect.exit, Effect.forkScoped);
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseDisable, true));
        const writerPid = yield* Deferred.await(writerStarted);
        expect(writerPid).not.toBe(transitionPid);
        yield* fixture.waitForBlock(transitionPid, writerPid);
        expect(handlerCalls).toBe(0);
        yield* Deferred.succeed(releaseDisable, true);
        yield* Fiber.join(transition);
        const result = yield* Fiber.join(writer);
        expect(Exit.isFailure(result)).toBe(true);
        const failure = Exit.isFailure(result) ? Option.getOrThrow(Cause.findErrorOption(result.cause)) : undefined;
        expect(Predicate.isTagged(failure, 'ModuleStateDeniedError')).toBe(true);
        expect(handlerCalls).toBe(0);
        const rows = yield* fixture.observer.executor
          .select()
          .from(dataAccessEvents)
          .where(eq(dataAccessEvents.tenantId, fixture.tenantId));
        expect(rows).toEqual([]);
      }),
    ),
  );
});
