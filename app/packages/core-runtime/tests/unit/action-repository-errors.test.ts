import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { Cause, Effect, Schema } from 'effect';
import {
  ActionInvocationPersistenceError,
  ActionTransactionError,
} from '../../src/actions/errors.ts';
import {
  getActionInvocationPersistenceFailureCause,
  getActionTransactionFailureCause,
  makeActionRepository,
} from '../../src/actions/repository.ts';
import type { CoreDatabaseExecutor } from '../../src/db/types.ts';

const credential = 'postgresql://synthetic-user:synthetic-secret@invalid/database';
const reason = 'Safe persistence failure';

const cases = [
  {
    name: 'invocation persistence',
    make: (cause?: unknown) => ActionInvocationPersistenceError.withCause(reason, cause),
    plain: () =>
      new ActionInvocationPersistenceError({
        code: 'action_invocation_persistence_failed',
        reason,
      }),
    getCause: (failure: ActionInvocationPersistenceError) =>
      getActionInvocationPersistenceFailureCause(failure),
    getOriginalCause: (failure: ActionInvocationPersistenceError) =>
      ActionInvocationPersistenceError.getOriginalCause(failure),
    encode: (failure: ActionInvocationPersistenceError) =>
      Schema.encodeSync(ActionInvocationPersistenceError)(failure),
    decode: (value: unknown) => Schema.decodeUnknownSync(ActionInvocationPersistenceError)(value),
  },
  {
    name: 'transaction',
    make: (cause?: unknown) => ActionTransactionError.withCause(reason, cause),
    plain: () => new ActionTransactionError({ code: 'action_transaction_failed', reason }),
    getCause: (failure: ActionTransactionError) => getActionTransactionFailureCause(failure),
    getOriginalCause: (failure: ActionTransactionError) =>
      ActionTransactionError.getOriginalCause(failure),
    encode: (failure: ActionTransactionError) => Schema.encodeSync(ActionTransactionError)(failure),
    decode: (value: unknown) => Schema.decodeUnknownSync(ActionTransactionError)(value),
  },
] as const;

// Keep each concrete Schema/error pair together, including its private-field brand.
const verifyError = <Failure extends Error>(entry: {
  name: string;
  make: (cause?: unknown) => Failure;
  plain: () => Failure;
  getCause: (failure: Failure) => Cause.Cause<never> | undefined;
  getOriginalCause: (failure: Failure) => unknown;
  encode: (failure: Failure) => unknown;
  decode: (value: unknown) => Failure;
}) => {
  void test(`${entry.name} retains original causes without changing their identity or shape`, () => {
    const nested = new Error(credential);
    const original = Object.freeze({ code: '08006', cause: nested, details: [credential] });
    for (const cause of [original, nested, credential, null, false, 0]) {
      const failure = entry.make(cause);
      assert.equal(entry.getOriginalCause(failure), cause);
      assert.deepEqual(entry.getCause(failure), Cause.die(cause));
      assert.equal(entry.getOriginalCause(entry.make()), undefined);
      assert.equal(entry.getOriginalCause(failure), cause);
    }
    assert.equal(original.cause, nested);
    assert.deepEqual(original.details, [credential]);
  });

  void test(`${entry.name} hides causes from JSON, Schema encoding, and ordinary inspection`, () => {
    const failure = entry.make(new Error(credential));
    const plain = entry.plain();
    assert.equal(failure.constructor, plain.constructor);
    assert.deepEqual(Object.keys(failure), Object.keys(plain));
    assert.deepEqual({ ...failure }, { ...plain });
    assert.deepEqual(JSON.parse(JSON.stringify(failure)), JSON.parse(JSON.stringify(plain)));
    assert.deepEqual(entry.encode(failure), entry.encode(plain));
    for (const rendered of [
      JSON.stringify(failure),
      JSON.stringify(entry.encode(failure)),
      inspect(failure),
    ]) {
      assert.equal(rendered.includes(credential), false);
    }
    const decoded = entry.decode(entry.encode(failure));
    assert.equal(decoded.constructor, plain.constructor);
    assert.equal(entry.getCause(decoded), undefined);
    assert.equal(entry.getCause(plain), undefined);
    assert.equal(entry.getCause(entry.make()), undefined);
    assert.equal(entry.getCause(entry.make(undefined)), undefined);
  });
};

verifyError(cases[0]);
verifyError(cases[1]);

void test('repository persistence failure retains the exact thrown defect', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const original = new Error(credential);
      const executor = {
        update: () => {
          throw original;
        },
      } as unknown as CoreDatabaseExecutor;
      const failure = yield* Effect.flip(
        makeActionRepository().transitionInvocationToRunning(executor, 'invocation-id'),
      );
      assert.ok(Schema.is(ActionInvocationPersistenceError)(failure));
      assert.equal(failure.reason, 'Unable to transition the Action invocation to running');
      assert.equal(ActionInvocationPersistenceError.getOriginalCause(failure), original);
      assert.deepEqual(getActionInvocationPersistenceFailureCause(failure), Cause.die(original));
    }),
  ));

void test('repository transaction failure retains the exact rejected defect', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const original = Object.freeze({ code: '08006', detail: credential });
      const executor = {
        transaction: () => Promise.reject(original),
      } as unknown as CoreDatabaseExecutor;
      // The failing transaction never invokes the callback or reads its input.
      const input = {} as Parameters<
        ReturnType<typeof makeActionRepository>['rejectPermissionDenied']
      >[1];
      const failure = yield* Effect.flip(
        makeActionRepository().rejectPermissionDenied(executor, input),
      );
      assert.ok(Schema.is(ActionTransactionError)(failure));
      assert.equal(failure.reason, 'Unable to persist Action permission denial evidence');
      assert.equal(ActionTransactionError.getOriginalCause(failure), original);
      assert.deepEqual(getActionTransactionFailureCause(failure), Cause.die(original));
    }),
  ));
