/* oxlint-disable typescript/return-await, unicorn/no-useless-promise-resolve-reject */
// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import test from 'node:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Cause, Context, Deferred, Effect, Exit, Fiber } from 'effect';
import { CoreTransactionBridgeFailure } from '../../src/db/transaction-bridge.ts';
import type { CoreTransaction } from '../../src/db/types.ts';
import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import {
  makeCoreSearchWorkerSnapshot,
  makePostgresCoreSearchSnapshotBackend,
  retryCoreSearchSnapshot,
} from '../../src/search/worker-snapshot.ts';
import type {
  CoreSearchSnapshotBackend,
  CoreSearchSnapshotReadExecutor,
  CoreSearchWorkerSnapshotView,
} from '../../src/search/worker-snapshot.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const context = {
  attemptNumber: 1,
  claimId: 'claim-1',
  correlationId: 'correlation-1',
  deliveryId: 'delivery-1',
  domainEventId: 'event-1',
  messageId: 'message-1',
  producerModuleKey: 'party.registry',
  tenantId,
  tenantSequenceNo: 2n,
  topic: 'party.registry.party-updated.v1',
  workerKey: 'party.registry.project-party-updated-to-search',
} as const;

const executor: CoreSearchSnapshotReadExecutor = {
  select: () => {
    throw new Error('This fixture observes the capability without querying.');
  },
};

test('worker snapshot rejects caller-created and unregistered contexts before opening persistence', async () => {
  let calls = 0;
  const backend: CoreSearchSnapshotBackend = {
    run: () =>
      Effect.sync(() => {
        calls += 1;
        throw new Error('unreachable');
      }),
  };
  const snapshot = makeCoreSearchWorkerSnapshot(backend);
  await Promise.all(
    [
      context,
      attestOutboxWorkerHandlerContext({
        ...context,
        workerKey: 'party.registry.unregistered',
      }),
      attestOutboxWorkerHandlerContext({ ...context, producerModuleKey: 'foreign.module' }),
    ].map(async (candidate) => {
      const failure = await Effect.runPromise(
        Effect.flip(snapshot.read(candidate, () => Effect.succeed('unreachable'))),
      );
      assert.equal(failure._tag, 'CoreSearchProjectionInvalid');
    }),
  );
  assert.equal(calls, 0);
});

test('identifier-update worker receives the verified Core snapshot capability', async () => {
  const reader = makeCoreSearchWorkerSnapshot({
    run: (_context, readSnapshot) =>
      readSnapshot(
        {
          eventWatermark: '3',
          legalEntityIds: [],
          projectionVersion: '1',
          tenantId,
        },
        executor,
        async () => Promise.resolve(),
      ),
  });
  const version = await Effect.runPromise(
    reader.read(
      attestOutboxWorkerHandlerContext({
        ...context,
        topic: 'party.registry.official-identifier-updated.v1',
        workerKey: 'party.registry.project-official-identifier-updated-to-search',
      }),
      (snapshot) => Effect.succeed(snapshot.projectionVersion),
    ),
  );
  assert.equal(version, '1');
});

const snapshotDatabase = (
  events: string[],
  beforeGeneration: () => void = () => undefined,
  beforeInstall: () => void = () => undefined,
) => {
  let selectCalls = 0;
  let executeCalls = 0;
  const transaction = {
    execute: async (statement: SQL) => {
      const query = new PgDialect().sqlToQuery(statement);
      if (executeCalls === 0) {
        assert.equal(query.sql, 'set transaction isolation level repeatable read');
      } else {
        assert.match(query.sql, /set_config/u);
        assert.equal(query.params[0], tenantId);
        beforeInstall();
      }
      executeCalls += 1;
      return { rows: [{ legal_entity_id: query.params[1], tenant_id: query.params[0] }] };
    },
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            beforeGeneration();
            return [{ version: 1n }];
          },
        }),
      }),
    }),
    select(this: CoreTransaction) {
      assert.equal(this, transaction);
      assert.equal(events.at(-1), 'begin');
      selectCalls += 1;
      return {
        from: () => ({
          where: async () => (selectCalls === 1 ? [{ version: '2' }] : [{ legalEntityId }]),
        }),
      };
    },
    update: () => ({
      set: () => ({
        where: async () => [],
      }),
    }),
  } as unknown as CoreTransaction;
  return {
    executor: {
      async transaction<Value>(body: (current: CoreTransaction) => Promise<Value>): Promise<Value> {
        events.push('begin');
        selectCalls = 0;
        executeCalls = 0;
        try {
          const value = await body(transaction);
          events.push('commit');
          return value;
        } catch (error) {
          events.push('rollback');
          throw error;
        }
      },
    },
  } as unknown as Parameters<typeof makePostgresCoreSearchSnapshotBackend>[0];
};

test('worker snapshot keeps typed owner failures inside transaction boundary', async () => {
  const events: string[] = [];
  const database = snapshotDatabase(events);
  const source = makeCoreSearchWorkerSnapshot(makePostgresCoreSearchSnapshotBackend(database));
  const verified = attestOutboxWorkerHandlerContext(context);
  const ownerFailure = { _tag: 'OwnerFailure' } as const;
  const failure = await Effect.runPromise(
    Effect.flip(source.read(verified, () => Effect.fail(ownerFailure))),
  );
  assert.equal(failure, ownerFailure);
  assert.deepEqual(events, ['begin', 'rollback']);
  events.length = 0;
  assert.equal(
    await Effect.runPromise(
      source.read(verified, (snapshot) => Effect.succeed(snapshot.projectionVersion)),
    ),
    '1',
  );
  assert.deepEqual(events, ['begin', 'commit']);
});

test('worker snapshot exposes select-only owner reads at one current watermark and restores scope', async () => {
  const installedScopes: (string | undefined)[] = [];
  const backend: CoreSearchSnapshotBackend = {
    run: (_context, readSnapshot) =>
      readSnapshot(
        {
          eventWatermark: '100',
          legalEntityIds: [legalEntityId],
          projectionVersion: '42',
          tenantId,
        },
        executor,
        async (scope) => {
          installedScopes.push(scope);
          return Promise.resolve();
        },
      ),
  };
  const snapshot = makeCoreSearchWorkerSnapshot(backend);
  const result = await Effect.runPromise(
    snapshot.read(attestOutboxWorkerHandlerContext(context), (view) =>
      Effect.gen(function* readOwnerProjection() {
        assert.equal(view.projectionVersion, '42');
        assert.equal(view.eventWatermark, '100');
        assert.equal(view.tenantId, tenantId);
        assert.deepEqual(view.legalEntityIds, [legalEntityId]);
        const party = yield* view.tenant((readExecutor) => {
          assert.deepEqual(Object.keys(readExecutor), ['select']);
          return Effect.succeed('party');
        });
        const counterparty = yield* view.forLegalEntity(legalEntityId, (readExecutor) => {
          assert.deepEqual(Object.keys(readExecutor), ['select']);
          return Effect.succeed('counterparty');
        });
        return { counterparty, party, projectionVersion: view.projectionVersion };
      }),
    ),
  );
  assert.deepEqual(result, {
    counterparty: 'counterparty',
    party: 'party',
    projectionVersion: '42',
  });
  assert.deepEqual(installedScopes, [undefined, undefined, legalEntityId, undefined]);
});

test('worker snapshot rejects a Legal Entity outside its tenant enumeration and preserves owner failures', async () => {
  const installedScopes: (string | undefined)[] = [];
  const backend: CoreSearchSnapshotBackend = {
    run: (_context, readSnapshot) =>
      readSnapshot(
        {
          eventWatermark: '100',
          legalEntityIds: [legalEntityId],
          projectionVersion: '42',
          tenantId,
        },
        executor,
        async (scope) => {
          installedScopes.push(scope);
          return Promise.resolve();
        },
      ),
  };
  const snapshot = makeCoreSearchWorkerSnapshot(backend);
  const verified = attestOutboxWorkerHandlerContext(context);
  const invalidScope = await Effect.runPromise(
    Effect.flip(
      snapshot.read(verified, (view) =>
        view.forLegalEntity('20000000-0000-4000-8000-000000000002', () => Effect.succeed('no')),
      ),
    ),
  );
  assert.equal(invalidScope._tag, 'CoreSearchProjectionInvalid');
  assert.deepEqual(installedScopes, []);
  const failure = await Effect.runPromise(
    Effect.flip(
      snapshot.read(verified, (view) =>
        view.forLegalEntity(legalEntityId, () => Effect.fail('owner-unavailable')),
      ),
    ),
  );
  assert.equal(failure, 'owner-unavailable');
  assert.deepEqual(installedScopes, [legalEntityId, undefined]);
});

test('worker snapshot maps persistence failure to a sanitized unavailable error', async () => {
  const snapshot = makeCoreSearchWorkerSnapshot({
    run: () => Effect.fail(new CoreTransactionBridgeFailure(new Error('private database details'))),
  });
  const failure = await Effect.runPromise(
    Effect.flip(
      snapshot.read(attestOutboxWorkerHandlerContext(context), () => Effect.succeed('no')),
    ),
  );
  assert.equal(failure._tag, 'CoreSearchProjectionUnavailable');
  assert.doesNotMatch(failure.reason, /private database/u);
});

test('snapshot generation retries serialization conflicts only and bounds repeated contention', async () => {
  let attempts = 0;
  assert.equal(
    await Effect.runPromise(
      retryCoreSearchSnapshot(() => {
        attempts += 1;
        return attempts < 3
          ? Effect.fail(
              new CoreTransactionBridgeFailure(
                new Error('wrapped serialization', { cause: { code: '40001' } }),
              ),
            )
          : Effect.succeed('fresh snapshot');
      }),
    ),
    'fresh snapshot',
  );
  assert.equal(attempts, 3);
  attempts = 0;
  const contention = new CoreTransactionBridgeFailure(
    Object.assign(new Error('contention'), { code: '40001' }),
  );
  assert.equal(
    await Effect.runPromise(
      Effect.flip(
        retryCoreSearchSnapshot(() => {
          attempts += 1;
          return Effect.fail(contention);
        }),
      ),
    ),
    contention,
  );
  assert.equal(attempts, 4);
  attempts = 0;
  const other = new CoreTransactionBridgeFailure(new Error('not serialization'));
  assert.equal(
    await Effect.runPromise(
      Effect.flip(
        retryCoreSearchSnapshot(() => {
          attempts += 1;
          return Effect.fail(other);
        }),
      ),
    ),
    other,
  );
  assert.equal(attempts, 1);
});

test('snapshot retries preparation serialization failures in fresh complete transactions', async () => {
  const events: string[] = [];
  let attempts = 0;
  const database = snapshotDatabase(events, () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('generation contention'), { code: '40001' });
  });
  const source = makeCoreSearchWorkerSnapshot(makePostgresCoreSearchSnapshotBackend(database));
  const result = await Effect.runPromise(
    source.read(attestOutboxWorkerHandlerContext(context), (snapshot) =>
      Effect.succeed(snapshot.projectionVersion),
    ),
  );
  assert.equal(result, '1');
  assert.equal(attempts, 3);
  assert.deepEqual(events, ['begin', 'rollback', 'begin', 'rollback', 'begin', 'commit']);
});

test('snapshot retry preserves mixed persistence Causes and never retries defects or interruption', async () => {
  const serialization = new CoreTransactionBridgeFailure({ code: '40001' });
  const defect = new Error('defect');
  const causes = [
    Cause.die(defect),
    Cause.interrupt(),
    Cause.fromReasons([Cause.makeFailReason(serialization), Cause.makeDieReason(defect)]),
    Cause.fromReasons([Cause.makeFailReason(serialization), Cause.makeInterruptReason()]),
  ];
  for (const cause of causes) {
    let attempts = 0;
    const exit = await Effect.runPromiseExit(
      retryCoreSearchSnapshot(() => {
        attempts += 1;
        return Effect.failCause(cause);
      }),
    );
    assert(Exit.isFailure(exit));
    assert.equal(exit.cause, cause);
    assert.equal(attempts, 1);
  }
});

class SnapshotCaller extends Context.Service<SnapshotCaller, { readonly value: string }>()(
  '@app/core-runtime/tests/unit/search-worker-snapshot.test/SnapshotCaller',
) {}

test('snapshot propagates caller services through the transaction and scoped read', async () => {
  const events: string[] = [];
  const source = makeCoreSearchWorkerSnapshot(
    makePostgresCoreSearchSnapshotBackend(snapshotDatabase(events)),
  );
  const program = source.read(attestOutboxWorkerHandlerContext(context), (snapshot) =>
    Effect.gen(function* readWithCallerService() {
      const caller = yield* SnapshotCaller;
      const entityCaller = yield* snapshot.forLegalEntity(legalEntityId, () => SnapshotCaller);
      assert.equal(entityCaller, caller);
      return yield* snapshot.tenant((readExecutor) =>
        Effect.gen(function* readInTransaction() {
          assert.deepEqual(Object.keys(readExecutor), ['select']);
          assert.deepEqual(events, ['begin']);
          assert.equal(typeof readExecutor.select().from, 'function');
          const scopedCaller = yield* SnapshotCaller;
          assert.equal(scopedCaller, caller);
          return scopedCaller.value;
        }),
      );
    }),
  );
  assert.equal(
    await Effect.runPromise(
      program.pipe(Effect.provideService(SnapshotCaller, { value: 'caller context' })),
    ),
    'caller context',
  );
  assert.deepEqual(events, ['begin', 'commit']);
});

test('snapshot preserves domain failures and defects in mixed Causes without retrying', async () => {
  const ownerFailure = { _tag: 'OwnerFailure', code: '40001' } as const;
  const defect = new Error('owner defect');
  const causes = [
    Cause.fail(ownerFailure),
    Cause.die(defect),
    Cause.fromReasons([Cause.makeFailReason(ownerFailure), Cause.makeDieReason(defect)]),
  ];
  for (const cause of causes) {
    const events: string[] = [];
    const backend = makePostgresCoreSearchSnapshotBackend(snapshotDatabase(events));
    const backendExit = await Effect.runPromiseExit(
      backend.run(attestOutboxWorkerHandlerContext(context), () => Effect.failCause(cause)),
    );
    assert.ok(Exit.isFailure(backendExit));
    assert.equal(backendExit.cause, cause);
    assert.deepEqual(events, ['begin', 'rollback']);
    events.length = 0;
    const source = makeCoreSearchWorkerSnapshot(backend);
    const exit = await Effect.runPromiseExit(
      source.read(attestOutboxWorkerHandlerContext(context), (snapshot) =>
        snapshot.tenant(() => Effect.failCause(cause)),
      ),
    );
    assert(Exit.isFailure(exit));
    // The service span adds trace annotations, but must retain every reason and payload identity.
    assert.deepEqual(
      exit.cause.reasons.map((reason) => reason._tag),
      cause.reasons.map((reason) => reason._tag),
    );
    for (const reason of exit.cause.reasons) {
      if (Cause.isFailReason(reason)) assert.equal(reason.error, ownerFailure);
      if (Cause.isDieReason(reason)) assert.equal(reason.defect, defect);
    }
    assert.deepEqual(events, ['begin', 'rollback']);
  }
});

for (const [label, cause] of [
  ['domain failure', Cause.fail({ _tag: 'OwnerFailure', code: '40001' } as const)],
  ['defect', Cause.die(new Error('owner defect'))],
  ['interruption', Cause.interrupt(123)],
] as const) {
  test(`snapshot preserves ${label} together with restore rejection and rolls back once`, async () => {
    const events: string[] = [];
    let installs = 0;
    const database = snapshotDatabase(events, undefined, () => {
      installs += 1;
      if (installs === 3) {
        throw Object.assign(new Error('private restore failure'), { code: '40001' });
      }
    });
    const source = makeCoreSearchWorkerSnapshot(makePostgresCoreSearchSnapshotBackend(database));
    let escaped: CoreSearchWorkerSnapshotView | undefined;
    const exit = await Effect.runPromiseExit(
      source.read(attestOutboxWorkerHandlerContext(context), (snapshot) => {
        escaped = snapshot;
        return snapshot.forLegalEntity(legalEntityId, () => Effect.failCause(cause));
      }),
    );
    assert(Exit.isFailure(exit));
    assert.deepEqual(events, ['begin', 'rollback']);
    assert.equal(installs, 3);
    assert.equal(exit.cause.reasons.length, 2);
    const [owner, restore] = exit.cause.reasons;
    const [original] = cause.reasons;
    assert(owner !== undefined && original !== undefined);
    assert.equal(owner._tag, original._tag);
    if (Cause.isFailReason(owner) && Cause.isFailReason(original)) {
      assert.equal(owner.error, original.error);
    }
    if (Cause.isDieReason(owner) && Cause.isDieReason(original)) {
      assert.equal(owner.defect, original.defect);
    }
    if (Cause.isInterruptReason(owner) && Cause.isInterruptReason(original)) {
      assert.equal(owner.fiberId, original.fiberId);
    }
    assert(restore !== undefined && Cause.isFailReason(restore));
    assert.equal(restore.error._tag, 'CoreSearchProjectionUnavailable');
    assert('reason' in restore.error);
    assert.doesNotMatch(restore.error.reason, /private|restore failure/u);
    assert(escaped !== undefined);
    const closed = await Effect.runPromise(
      Effect.flip(escaped.tenant(() => Effect.succeed('stale'))),
    );
    assert.equal(closed._tag, 'CoreSearchProjectionInvalid');
    assert.equal(installs, 3);
  });
}

test('snapshot releases scoped reads after restore rejection and preserves successful value identity', async () => {
  const events: string[] = [];
  let installs = 0;
  const database = snapshotDatabase(events, undefined, () => {
    installs += 1;
    if (installs === 3) throw new Error('restore failure');
  });
  const source = makeCoreSearchWorkerSnapshot(makePostgresCoreSearchSnapshotBackend(database));
  const value = { owner: 'result' };
  const result = await Effect.runPromise(
    source.read(attestOutboxWorkerHandlerContext(context), (snapshot) =>
      Effect.gen(function* recoverScopedRead() {
        const failed = yield* Effect.flip(
          snapshot.forLegalEntity(legalEntityId, () => Effect.succeed(value)),
        );
        assert.equal(failed._tag, 'CoreSearchProjectionUnavailable');
        return yield* snapshot.tenant(() => Effect.succeed(value));
      }),
    ),
  );
  assert.equal(result, value);
  assert.equal(installs, 5);
  assert.deepEqual(events, ['begin', 'commit']);
});

test('snapshot reports uncertain transaction completion without replaying owner work', async () => {
  const events: string[] = [];
  const database = snapshotDatabase(events);
  const transaction = database.executor.transaction.bind(database.executor);
  database.executor.transaction = async <Value>(
    body: (current: CoreTransaction) => Promise<Value>,
  ): Promise<Value> => {
    await transaction(body);
    throw new Error('private connection lost after commit');
  };
  let reads = 0;
  const source = makeCoreSearchWorkerSnapshot(makePostgresCoreSearchSnapshotBackend(database));
  const failure = await Effect.runPromise(
    Effect.flip(
      source.read(attestOutboxWorkerHandlerContext(context), () =>
        Effect.sync(() => {
          reads += 1;
          return 'read';
        }),
      ),
    ),
  );
  assert.equal(failure._tag, 'CoreSearchProjectionUnavailable');
  assert.doesNotMatch(failure.reason, /private|connection|commit/u);
  assert.equal(reads, 1);
  assert.deepEqual(events, ['begin', 'commit']);
});

test('snapshot rejects overlapping reads until the active scope restores', async () => {
  const installedScopes: (string | undefined)[] = [];
  const reader = makeCoreSearchWorkerSnapshot({
    run: (_context, readSnapshot) =>
      readSnapshot(
        { eventWatermark: '3', legalEntityIds: [legalEntityId], projectionVersion: '1', tenantId },
        executor,
        async (scope) => {
          installedScopes.push(scope);
        },
      ),
  });
  await Effect.runPromise(
    reader.read(attestOutboxWorkerHandlerContext(context), (snapshot) =>
      Effect.gen(function* overlappingReads() {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const active = yield* snapshot
          .forLegalEntity(legalEntityId, () =>
            Effect.gen(function* activeRead() {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const failure = yield* Effect.flip(snapshot.tenant(() => Effect.succeed('overlap')));
        assert.equal(failure._tag, 'CoreSearchProjectionInvalid');
        assert.deepEqual(installedScopes, [legalEntityId]);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(active);
        yield* snapshot.tenant(() => Effect.void);
      }),
    ),
  );
  assert.deepEqual(installedScopes, [legalEntityId, undefined, undefined, undefined]);
});

test('snapshot revokes escaped scope capabilities when the owner callback finishes', async () => {
  const reader = makeCoreSearchWorkerSnapshot({
    run: (_context, readSnapshot) =>
      readSnapshot(
        { eventWatermark: '3', legalEntityIds: [legalEntityId], projectionVersion: '1', tenantId },
        executor,
        async () => Promise.resolve(),
      ),
  });
  const escaped: CoreSearchWorkerSnapshotView = await Effect.runPromise(
    reader.read(attestOutboxWorkerHandlerContext(context), Effect.succeed),
  );
  const failure = await Effect.runPromise(
    Effect.flip(escaped.tenant(() => Effect.succeed('stale'))),
  );
  assert.equal(failure._tag, 'CoreSearchProjectionInvalid');
});

test('nested scope rejection does not unlock the active owner read', async () => {
  const reader = makeCoreSearchWorkerSnapshot({
    run: (_context, readSnapshot) =>
      readSnapshot(
        { eventWatermark: '3', legalEntityIds: [legalEntityId], projectionVersion: '1', tenantId },
        executor,
        async () => Promise.resolve(),
      ),
  });
  await Effect.runPromise(
    reader.read(attestOutboxWorkerHandlerContext(context), (snapshot) =>
      snapshot.tenant(() =>
        Effect.gen(function* nestedReads() {
          const first = yield* Effect.flip(
            snapshot.forLegalEntity(legalEntityId, () => Effect.succeed('invalid')),
          );
          const second = yield* Effect.flip(snapshot.tenant(() => Effect.succeed('still invalid')));
          assert.equal(first._tag, 'CoreSearchProjectionInvalid');
          assert.equal(second._tag, 'CoreSearchProjectionInvalid');
        }),
      ),
    ),
  );
});
