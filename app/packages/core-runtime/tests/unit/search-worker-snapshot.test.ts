/* oxlint-disable typescript/return-await, unicorn/no-useless-promise-resolve-reject */
// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import {
  makeCoreSearchWorkerSnapshot,
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
    run: async () => {
      calls += 1;
      return Promise.reject(new Error('unreachable'));
    },
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
    run: async (_context, readSnapshot) =>
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

test('worker snapshot exposes select-only owner reads at one current watermark and restores scope', async () => {
  const installedScopes: (string | undefined)[] = [];
  const backend: CoreSearchSnapshotBackend = {
    run: async (_context, readSnapshot) =>
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
    run: async (_context, readSnapshot) =>
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
    run: async () => Promise.reject(new Error('private database details')),
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
    await retryCoreSearchSnapshot(async () => {
      attempts += 1;
      if (attempts < 3) {
        return Promise.reject(new Error('wrapped serialization', { cause: { code: '40001' } }));
      }
      return Promise.resolve('fresh snapshot');
    }),
    'fresh snapshot',
  );
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(
    retryCoreSearchSnapshot(async () => {
      attempts += 1;
      return Promise.reject(Object.assign(new Error('contention'), { code: '40001' }));
    }),
    /contention/u,
  );
  assert.equal(attempts, 4);
  attempts = 0;
  await assert.rejects(
    retryCoreSearchSnapshot(async () => {
      attempts += 1;
      return Promise.reject(new Error('not serialization'));
    }),
    /not serialization/u,
  );
  assert.equal(attempts, 1);
});

test('snapshot revokes escaped scope capabilities when the owner callback finishes', async () => {
  const reader = makeCoreSearchWorkerSnapshot({
    run: async (_context, readSnapshot) =>
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
    run: async (_context, readSnapshot) =>
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
