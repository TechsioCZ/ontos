import { runEffectTestSync } from '@app/core-runtime/testing/effect-runtime';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import { CoreSearchProjectionUnavailable } from '../../src/search/projection.ts';
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

class SnapshotRetryFailure extends Schema.TaggedError<SnapshotRetryFailure>()(
  'SnapshotRetryFailure',
  {
    cause: Schema.optional(Schema.Unknown),
    code: Schema.optional(Schema.String),
    message: Schema.String,
  },
) {}

const effectTest = <Value, Failure>(
  name: string,
  body: () => Effect.Effect<Value, Failure>,
): void => {
  void test(name, () => {
    runEffectTestSync(body());
  });
};

const readParty = (readExecutor: CoreSearchSnapshotReadExecutor) => {
  assert.deepEqual(Object.keys(readExecutor), ['select']);
  return Effect.succeed('party');
};

const readCounterparty = (readExecutor: CoreSearchSnapshotReadExecutor) => {
  assert.deepEqual(Object.keys(readExecutor), ['select']);
  return Effect.succeed('counterparty');
};

const readInvalid = () => Effect.succeed('invalid');
const readStillInvalid = () => Effect.succeed('still invalid');

effectTest(
  'worker snapshot rejects caller-created and unregistered contexts before opening persistence',
  () => {
    let calls = 0;
    const backend: CoreSearchSnapshotBackend = {
      run: () => {
        calls += 1;
        return Effect.die(new Error('unreachable'));
      },
    };
    const snapshot = makeCoreSearchWorkerSnapshot(backend);
    return Effect.gen(function* rejectInvalidWorkerContexts() {
      const failures = yield* Effect.forEach(
        [
          context,
          attestOutboxWorkerHandlerContext({
            ...context,
            workerKey: 'party.registry.unregistered',
          }),
          attestOutboxWorkerHandlerContext({ ...context, producerModuleKey: 'foreign.module' }),
        ],
        (candidate) => Effect.flip(snapshot.read(candidate, () => Effect.succeed('unreachable'))),
        { concurrency: 'unbounded' },
      );
      assert.deepEqual(
        failures.map(({ _tag }) => _tag),
        [
          'CoreSearchProjectionInvalid',
          'CoreSearchProjectionInvalid',
          'CoreSearchProjectionInvalid',
        ],
      );
      assert.equal(calls, 0);
    });
  },
);

effectTest('identifier-update worker receives the verified Core snapshot capability', () => {
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
        () => Effect.void,
      ),
  });
  return Effect.gen(function* readVerifiedWorkerSnapshot() {
    const version = yield* reader.read(
      attestOutboxWorkerHandlerContext({
        ...context,
        topic: 'party.registry.official-identifier-updated.v1',
        workerKey: 'party.registry.project-official-identifier-updated-to-search',
      }),
      (snapshot) => Effect.succeed(snapshot.projectionVersion),
    );
    assert.equal(version, '1');
  });
});

effectTest(
  'worker snapshot exposes select-only owner reads at one current watermark and restores scope',
  () => {
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
          (scope) => {
            installedScopes.push(scope);
            return Effect.void;
          },
        ),
    };
    const snapshot = makeCoreSearchWorkerSnapshot(backend);
    return Effect.gen(function* readCurrentOwnerSnapshot() {
      const result = yield* snapshot.read(attestOutboxWorkerHandlerContext(context), (view) =>
        Effect.gen(function* readOwnerProjection() {
          assert.equal(view.projectionVersion, '42');
          assert.equal(view.eventWatermark, '100');
          assert.equal(view.tenantId, tenantId);
          assert.deepEqual(view.legalEntityIds, [legalEntityId]);
          const party = yield* view.tenant(readParty);
          const counterparty = yield* view.forLegalEntity(legalEntityId, readCounterparty);
          return { counterparty, party, projectionVersion: view.projectionVersion };
        }),
      );
      assert.deepEqual(result, {
        counterparty: 'counterparty',
        party: 'party',
        projectionVersion: '42',
      });
      assert.deepEqual(installedScopes, [undefined, undefined, legalEntityId, undefined]);
    });
  },
);

effectTest(
  'worker snapshot rejects a Legal Entity outside its tenant enumeration and preserves owner failures',
  () => {
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
          (scope) => {
            installedScopes.push(scope);
            return Effect.void;
          },
        ),
    };
    const snapshot = makeCoreSearchWorkerSnapshot(backend);
    const verified = attestOutboxWorkerHandlerContext(context);
    return Effect.gen(function* rejectInvalidAndPreserveOwnerFailure() {
      const invalidScope = yield* Effect.flip(
        snapshot.read(verified, (view) =>
          view.forLegalEntity('20000000-0000-4000-8000-000000000002', () => Effect.succeed('no')),
        ),
      );
      assert.equal(invalidScope._tag, 'CoreSearchProjectionInvalid');
      assert.deepEqual(installedScopes, []);
      const failure = yield* Effect.flip(
        snapshot.read(verified, (view) =>
          view.forLegalEntity(legalEntityId, () => Effect.fail('owner-unavailable')),
        ),
      );
      assert.equal(failure, 'owner-unavailable');
      assert.deepEqual(installedScopes, [legalEntityId, undefined]);
    });
  },
);

effectTest('worker snapshot maps persistence failure to a sanitized unavailable error', () => {
  const snapshot = makeCoreSearchWorkerSnapshot({
    run: () =>
      Effect.fail(
        new CoreSearchProjectionUnavailable({
          cause: new Error('private database details'),
          code: 'core_search_projection_unavailable',
          reason: 'Core Search worker snapshot is temporarily unavailable',
        }),
      ),
  });
  return Effect.gen(function* mapPersistenceFailure() {
    const failure = yield* Effect.flip(
      snapshot.read(attestOutboxWorkerHandlerContext(context), () => Effect.succeed('no')),
    );
    assert.equal(failure._tag, 'CoreSearchProjectionUnavailable');
    assert.doesNotMatch(failure.reason, /private database/u);
  });
});

effectTest(
  'snapshot generation retries serialization conflicts only and bounds repeated contention',
  () => {
    let attempts = 0;
    return Effect.gen(function* retrySerializationFailures() {
      const snapshot = yield* Effect.suspend(() => {
        attempts += 1;
        return attempts < 3
          ? Effect.fail(
              new SnapshotRetryFailure({
                cause: { code: '40001' },
                message: 'wrapped serialization',
              }),
            )
          : Effect.succeed('fresh snapshot');
      }).pipe(retryCoreSearchSnapshot);
      assert.equal(snapshot, 'fresh snapshot');
      assert.equal(attempts, 3);

      attempts = 0;
      const contention = yield* Effect.flip(
        Effect.suspend(() => {
          attempts += 1;
          return Effect.fail(new SnapshotRetryFailure({ code: '40001', message: 'contention' }));
        }).pipe(retryCoreSearchSnapshot),
      );
      assert.match(contention.message, /contention/u);
      assert.equal(attempts, 4);

      attempts = 0;
      const nonSerialization = yield* Effect.flip(
        Effect.suspend(() => {
          attempts += 1;
          return Effect.fail(new SnapshotRetryFailure({ message: 'not serialization' }));
        }).pipe(retryCoreSearchSnapshot),
      );
      assert.match(nonSerialization.message, /not serialization/u);
      assert.equal(attempts, 1);
    });
  },
);

effectTest('snapshot revokes escaped scope capabilities when the owner callback finishes', () => {
  const reader = makeCoreSearchWorkerSnapshot({
    run: (_context, readSnapshot) =>
      readSnapshot(
        { eventWatermark: '3', legalEntityIds: [legalEntityId], projectionVersion: '1', tenantId },
        executor,
        () => Effect.void,
      ),
  });
  return Effect.gen(function* rejectEscapedCapability() {
    const escaped: CoreSearchWorkerSnapshotView = yield* reader.read(
      attestOutboxWorkerHandlerContext(context),
      Effect.succeed,
    );
    const failure = yield* Effect.flip(escaped.tenant(() => Effect.succeed('stale')));
    assert.equal(failure._tag, 'CoreSearchProjectionInvalid');
  });
});

effectTest('nested scope rejection does not unlock the active owner read', () => {
  const reader = makeCoreSearchWorkerSnapshot({
    run: (_context, readSnapshot) =>
      readSnapshot(
        { eventWatermark: '3', legalEntityIds: [legalEntityId], projectionVersion: '1', tenantId },
        executor,
        () => Effect.void,
      ),
  });
  return reader.read(attestOutboxWorkerHandlerContext(context), (snapshot) =>
    snapshot.tenant(() =>
      Effect.gen(function* nestedReads() {
        const first = yield* Effect.flip(snapshot.forLegalEntity(legalEntityId, readInvalid));
        const second = yield* Effect.flip(snapshot.tenant(readStillInvalid));
        assert.equal(first._tag, 'CoreSearchProjectionInvalid');
        assert.equal(second._tag, 'CoreSearchProjectionInvalid');
      }),
    ),
  );
});
