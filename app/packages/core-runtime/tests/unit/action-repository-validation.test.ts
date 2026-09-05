// @effect-diagnostics asyncFunction:off globalDate:off missingEffectError:off unsafeEffectTypeAssertion:off -- Controlled Promise-based Drizzle fake and deterministic timestamp fixtures; remove-when: the foreign repository contract is replaced.
/* eslint-disable no-await-in-loop, unicorn/no-thenable -- Sequential assertions use a controlled thenable matching Drizzle's query contract. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Cause, Effect, Option, Result } from 'effect';
import type { CoreDatabaseExecutor, CoreTransaction } from '../../src/db/types.ts';
import {
  getActionInvocationPersistenceFailureCause,
  getActionTransactionFailureCause,
  makeActionRepository,
} from '../../src/actions/repository.ts';
import type {
  ActionInvocationRecord,
  FlushActionSuccessInput,
} from '../../src/actions/repository.ts';

interface QueryStep {
  readonly kind: 'insert' | 'select' | 'update';
  readonly rows?: readonly unknown[];
  readonly failure?: Error;
}

// Only the foreign Promise boundary is simulated. No Pool, environment, or DB access.
const makeExecutor = (steps: readonly QueryStep[], commitFailure?: Error) => {
  const pending = [...steps];
  const calls: string[] = [];
  const values: unknown[] = [];
  const query = (kind: QueryStep['kind']) => {
    const chain = {
      for: (mode: string) => {
        assert.equal(mode, 'update');
        calls.push('lock');
        return chain;
      },
      from: () => chain,
      limit: () => chain,
      onConflictDoNothing: () => chain,
      returning: () => chain,
      set: () => chain,
      values: (value: unknown) => {
        values.push(value);
        return chain;
      },
      where: () => chain,
      then: (resolve: (rows: readonly unknown[]) => unknown, reject: (cause: unknown) => unknown) =>
        Promise.resolve()
          .then(() => {
            calls.push(kind);
            const step = pending.shift();
            assert.ok(step, `Unexpected ${kind} query`);
            assert.equal(kind, step.kind);
            if (step.failure !== undefined) {
              throw step.failure;
            }
            return step.rows ?? [];
          })
          .then(resolve, reject),
    };
    return chain;
  };
  const executor = {
    insert: () => query('insert'),
    select: () => query('select'),
    update: () => query('update'),
    transaction: async <Value>(run: (transaction: CoreTransaction) => Promise<Value>) => {
      calls.push('begin');
      try {
        const value = await run(executor as unknown as CoreTransaction);
        if (commitFailure !== undefined) {
          throw commitFailure;
        }
        calls.push('commit');
        return value;
      } catch (cause) {
        calls.push('rollback');
        throw cause;
      }
    },
  };
  return {
    calls,
    executor: executor as unknown as CoreDatabaseExecutor,
    transaction: executor as unknown as CoreTransaction,
    values,
    assertConsumed: () => assert.equal(pending.length, 0),
  };
};

const principal = {
  authContextRef: 'test:repository',
  authMethod: 'session',
  principalId: 'principal-1',
  tenantId: 'tenant-1',
} as const;
const input = {
  actionInvocationId: 'invocation-1',
  actionKey: 'test.action',
  auditProfile: 'standard',
  principal,
  transport: { correlationId: 'correlation-1' },
} as const;
const prepare = { ...input, idempotencyKey: 'intent-1', requestHash: 'hash-1' };
const received: ActionInvocationRecord = {
  actionInvocationId: input.actionInvocationId,
  completedAt: null,
  requestHash: prepare.requestHash,
  status: 'received',
};
const completed: ActionInvocationRecord = {
  ...received,
  completedAt: new Date(0),
  status: 'rejected',
};
const policyInput = {
  ...input,
  policy: { policyKey: 'test.policy', scope: 'global' },
  reasonCode: 'policy_denied',
} as const;
const successInput: FlushActionSuccessInput = {
  ...input,
  allowedPolicies: [],
  evidence: { auditEvidence: {}, dataAccessEvents: [], domainEvents: [], outboxMessages: [] },
  resultHash: 'result-1',
};
const repository = makeActionRepository();
const defect = (cause: Cause.Cause<never> | undefined): unknown => {
  assert.ok(cause);
  return Option.getOrThrow(Result.getSuccess(Cause.findDie(cause))).defect;
};
const assertDefectMessage = (cause: Cause.Cause<never> | undefined, message: string) => {
  const error = defect(cause);
  assert.ok(error instanceof Error);
  assert.equal(error.message, message);
};

const assertFields = (value: unknown, fields: Readonly<Record<string, string>>) => {
  assert.ok(value !== null && typeof value === 'object');
  assert.deepEqual(
    Object.fromEntries(Object.entries(value).filter(([key]) => key in fields)),
    fields,
  );
};

void test('a non-idempotent conflict is a persistence failure without a resolution query', async () => {
  const db = makeExecutor([{ kind: 'insert' }]);
  const error = await Effect.runPromise(
    Effect.flip(
      repository.createOrResolveInvocation(db.executor, {
        ...prepare,
        idempotencyKey: undefined,
      }),
    ),
  );
  assert.equal(error._tag, 'ActionInvocationPersistenceError');
  assert.equal(error.reason, 'Unable to create or resolve the Action invocation');
  assertDefectMessage(
    getActionInvocationPersistenceFailureCause(error),
    'A non-idempotent invocation insert unexpectedly conflicted',
  );
  assert.deepEqual(db.calls, ['insert']);
});

void test('conflicting inserts resolve sequentially or retain the missing-row cause', async () => {
  for (const rows of [[], [received]]) {
    const db = makeExecutor([{ kind: 'insert' }, { kind: 'select', rows }]);
    const outcome = await Effect.runPromise(
      Effect.result(repository.createOrResolveInvocation(db.executor, prepare)),
    );
    if (Result.isFailure(outcome)) {
      assert.equal(rows.length, 0);
      assertDefectMessage(
        getActionInvocationPersistenceFailureCause(outcome.failure),
        'The conflicting Action invocation could not be resolved',
      );
    } else {
      assert.deepEqual(outcome.success, received);
    }
    assert.deepEqual(db.calls, ['insert', 'select']);
  }
});

void test('a created invocation skips the idempotency lookup', async () => {
  const db = makeExecutor([{ kind: 'insert', rows: [received] }]);
  assert.deepEqual(
    await Effect.runPromise(repository.createOrResolveInvocation(db.executor, prepare)),
    received,
  );
  assert.deepEqual(db.calls, ['insert']);
});

void test('missing locked and transitioned rows keep persistence classification and causes', async () => {
  const locked = makeExecutor([{ kind: 'select' }]);
  const transitioned = makeExecutor([{ kind: 'update' }, { kind: 'select' }]);
  for (const operation of [
    repository.lockInvocation(locked.transaction, input.actionInvocationId),
    repository.transitionInvocationToRunning(transitioned.executor, input.actionInvocationId),
  ]) {
    const error = await Effect.runPromise(Effect.flip(operation));
    assert.equal(error._tag, 'ActionInvocationPersistenceError');
    assertDefectMessage(
      getActionInvocationPersistenceFailureCause(error),
      'The Action invocation no longer exists',
    );
  }
  assert.deepEqual(locked.calls, ['lock', 'select']);
  assert.deepEqual(transitioned.calls, ['update', 'select']);
});

void test('transition fallback preserves an already completed invocation', async () => {
  const db = makeExecutor([{ kind: 'update' }, { kind: 'select', rows: [completed] }]);
  assert.deepEqual(
    await Effect.runPromise(
      repository.transitionInvocationToRunning(db.executor, input.actionInvocationId),
    ),
    completed,
  );
  assert.deepEqual(db.calls, ['update', 'select']);
});

void test('commit-state resolution distinguishes not found from driver failure', async () => {
  const driverFailure = new Error('driver unavailable');
  for (const failure of [undefined, driverFailure]) {
    const db = makeExecutor([{ kind: 'select', ...(failure === undefined ? {} : { failure }) }]);
    const error = await Effect.runPromise(
      Effect.flip(
        repository.resolveInvocation(db.executor, {
          invocationId: input.actionInvocationId,
          principal,
        }),
      ),
    );
    if (error._tag === 'ActionInvocationPersistenceError') {
      const preservedCause = getActionInvocationPersistenceFailureCause(error);
      assert.equal(defect(preservedCause), driverFailure);
    } else {
      assert.equal(failure, undefined);
      assert.equal(error._tag, 'ActionInvocationNotFound');
    }
    assert.deepEqual(db.calls, ['lock', 'select']);
  }
});

void test('driver rejection preserves its identity on create, lock, and transition', async () => {
  const failure = new Error('query rejected');
  const insert = makeExecutor([{ kind: 'insert', failure }]);
  const select = makeExecutor([{ kind: 'select', failure }]);
  const update = makeExecutor([{ kind: 'update', failure }]);
  for (const operation of [
    repository.createOrResolveInvocation(insert.executor, prepare),
    repository.lockInvocation(select.transaction, input.actionInvocationId),
    repository.transitionInvocationToRunning(update.executor, input.actionInvocationId),
  ]) {
    const error = await Effect.runPromise(Effect.flip(operation));
    const preservedCause = getActionInvocationPersistenceFailureCause(error);
    assert.equal(defect(preservedCause), failure);
  }
});

void test('permission denial rolls back missing rows and state mismatches without auditing', async () => {
  for (const rows of [
    [],
    [{ ...received, status: 'running' }],
    [{ ...received, completedAt: new Date(0) }],
  ]) {
    const db = makeExecutor([{ kind: 'select', rows }]);
    const error = await Effect.runPromise(
      Effect.flip(repository.rejectPermissionDenied(db.executor, input)),
    );
    assert.equal(
      error._tag,
      rows.length === 0 ? 'ActionInvocationPersistenceError' : 'ActionInvocationStateError',
    );
    if (error._tag === 'ActionInvocationPersistenceError') {
      assert.equal(getActionInvocationPersistenceFailureCause(error), undefined);
    }
    assert.deepEqual(db.calls, ['begin', 'lock', 'select', 'rollback']);
    assert.deepEqual(db.values, []);
  }
});

void test('completed permission and policy rejections are idempotent without duplicate audits', async () => {
  for (const operation of [
    (db: CoreDatabaseExecutor) => repository.rejectPermissionDenied(db, input),
    (db: CoreDatabaseExecutor) => repository.finalizePolicyDenial(db, policyInput),
  ]) {
    const db = makeExecutor([{ kind: 'select', rows: [completed] }]);
    await Effect.runPromise(operation(db.executor));
    assert.deepEqual(db.calls, ['begin', 'lock', 'select', 'commit']);
    assert.deepEqual(db.values, []);
  }
});

void test('permission denial audits before updating and committing', async () => {
  const db = makeExecutor([
    { kind: 'select', rows: [received] },
    { kind: 'insert' },
    { kind: 'update', rows: [received] },
  ]);
  await Effect.runPromise(repository.rejectPermissionDenied(db.executor, input));
  assert.deepEqual(db.calls, ['begin', 'lock', 'select', 'insert', 'update', 'commit']);
  assertFields(db.values[0], {
    eventType: 'action.rejected',
    outcomeCode: 'spicedb_permission_denied',
    outcomeStage: 'authz',
    outcome: 'denied',
  });
  db.assertConsumed();
});

void test('permission rejection update mismatch and driver/commit rejection retain transaction causes', async () => {
  const driverFailure = new Error('audit rejected');
  const commitFailure = new Error('commit rejected');
  const cases = [
    { steps: [{ kind: 'select', rows: [received] }, { kind: 'insert' }, { kind: 'update' }] },
    {
      steps: [
        { kind: 'select', rows: [received] },
        { kind: 'insert', failure: driverFailure },
      ],
      failure: driverFailure,
    },
    {
      steps: [
        { kind: 'select', rows: [received] },
        { kind: 'insert' },
        { kind: 'update', rows: [received] },
      ],
      failure: commitFailure,
      commitFailure,
    },
  ] satisfies { steps: QueryStep[]; failure?: Error; commitFailure?: Error }[];
  for (const entry of cases) {
    const db = makeExecutor(entry.steps, entry.commitFailure);
    const error = await Effect.runPromise(
      Effect.flip(repository.rejectPermissionDenied(db.executor, input)),
    );
    assert.equal(error._tag, 'ActionTransactionError');
    assert.ok(error._tag === 'ActionTransactionError');
    if (entry.failure === undefined) {
      assertDefectMessage(
        getActionTransactionFailureCause(error),
        'The Action invocation could not be marked rejected',
      );
    } else {
      const preservedCause = getActionTransactionFailureCause(error);
      assert.equal(defect(preservedCause), entry.failure);
    }
    assert.equal(db.calls.at(-1), 'rollback');
    db.assertConsumed();
  }
});

void test('policy denial missing rows and invalid states retain persistence causes', async () => {
  for (const rows of [[], [{ ...received, status: 'running' }]]) {
    const db = makeExecutor([{ kind: 'select', rows }]);
    const error = await Effect.runPromise(
      Effect.flip(repository.finalizePolicyDenial(db.executor, policyInput)),
    );
    assertDefectMessage(
      getActionInvocationPersistenceFailureCause(error),
      rows.length === 0
        ? 'The Action invocation no longer exists'
        : 'The Action invocation is no longer open for Policy rejection',
    );
    assert.deepEqual(db.calls, ['begin', 'lock', 'select', 'rollback']);
  }
});

void test('policy denial audits both events and preserves commit failure identity', async () => {
  const failure = new Error('commit rejected');
  const db = makeExecutor(
    [
      { kind: 'select', rows: [received] },
      { kind: 'insert' },
      { kind: 'update', rows: [received] },
    ],
    failure,
  );
  const error = await Effect.runPromise(
    Effect.flip(repository.finalizePolicyDenial(db.executor, policyInput)),
  );
  const preservedCause = getActionInvocationPersistenceFailureCause(error);
  assert.equal(defect(preservedCause), failure);
  assert.deepEqual(db.calls, ['begin', 'lock', 'select', 'insert', 'update', 'rollback']);
  const [audits] = db.values;
  assert.ok(Array.isArray(audits));
  assert.equal(audits.length, 2);
  assertFields(audits[0], { eventType: 'action.policy_checked' });
  assertFields(audits[1], { eventType: 'action.rejected' });
});

void test('success update mismatch retains the transaction failure cause', async () => {
  const db = makeExecutor([{ kind: 'insert' }, { kind: 'update' }]);
  const error = await Effect.runPromise(
    Effect.flip(repository.flushSuccess(db.transaction, successInput)),
  );
  assert.equal(error._tag, 'ActionTransactionError');
  assertDefectMessage(
    getActionTransactionFailureCause(error),
    'The Action invocation could not be marked succeeded',
  );
  assert.deepEqual(db.calls, ['insert', 'update']);
});

void test('success evidence driver rejection short-circuits with its original cause', async () => {
  const failure = new Error('audit rejected');
  const db = makeExecutor([{ kind: 'insert', failure }]);
  const error = await Effect.runPromise(
    Effect.flip(repository.flushSuccess(db.transaction, successInput)),
  );
  const preservedCause = getActionTransactionFailureCause(error);
  assert.equal(defect(preservedCause), failure);
  assert.deepEqual(db.calls, ['insert']);
});

void test('success persists domain events and linked outbox messages before the final update', async () => {
  const db = makeExecutor([
    { kind: 'insert' },
    { kind: 'select', rows: [{ tenantId: principal.tenantId }] },
    { kind: 'insert' },
    { kind: 'insert' },
    { kind: 'update', rows: [received] },
  ]);
  await Effect.runPromise(
    repository.flushSuccess(db.transaction, {
      ...successInput,
      evidence: {
        ...successInput.evidence,
        domainEvents: [
          {
            eventType: 'test.changed',
            payloadJson: {},
            producerModuleKey: 'test',
            subjectModuleKey: 'test',
            subjectResourceId: 'resource-1',
            subjectResourceType: 'test',
          },
        ],
        outboxMessages: [
          {
            domainEventIndex: 0,
            message: { payloadJson: {}, producerModuleKey: 'test', topic: 'test.changed' },
          },
        ],
      },
    }),
  );
  assert.deepEqual(db.calls, ['insert', 'lock', 'select', 'insert', 'insert', 'update']);
  const [, events, messages] = db.values;
  assert.ok(Array.isArray(events));
  assert.ok(Array.isArray(messages));
  assert.equal(events.length, 1);
  assert.equal(messages.length, 1);
  assert.equal(typeof events[0].domainEventId, 'string');
  assert.equal(messages[0].domainEventId, events[0].domainEventId);
  db.assertConsumed();
});

void test('a missing domain-event tenant fails before event inserts or invocation updates', async () => {
  const db = makeExecutor([{ kind: 'insert' }, { kind: 'select' }]);
  const error = await Effect.runPromise(
    Effect.flip(
      repository.flushSuccess(db.transaction, {
        ...successInput,
        evidence: {
          ...successInput.evidence,
          domainEvents: [
            {
              eventType: 'test.changed',
              payloadJson: {},
              producerModuleKey: 'test',
              subjectModuleKey: 'test',
              subjectResourceId: 'resource-1',
              subjectResourceType: 'test',
            },
          ],
        },
      }),
    ),
  );
  assertDefectMessage(
    getActionTransactionFailureCause(error),
    'The Domain Event tenant does not exist',
  );
  assert.deepEqual(db.calls, ['insert', 'lock', 'select']);
});

void test('an unresolved outbox reference fails before outbox inserts or invocation updates', async () => {
  const db = makeExecutor([{ kind: 'insert' }]);
  const error = await Effect.runPromise(
    Effect.flip(
      repository.flushSuccess(db.transaction, {
        ...successInput,
        evidence: {
          ...successInput.evidence,
          outboxMessages: [
            {
              domainEventIndex: 0,
              message: { payloadJson: {}, producerModuleKey: 'test', topic: 'test.changed' },
            },
          ],
        },
      }),
    ),
  );
  assertDefectMessage(
    getActionTransactionFailureCause(error),
    'An Outbox Message has no persisted Domain Event',
  );
  assert.deepEqual(db.calls, ['insert']);
});
