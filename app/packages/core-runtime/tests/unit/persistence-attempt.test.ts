// @effect-diagnostics asyncFunction:off -- Tests exercise the required PromiseLike boundary; expires: 2027-03-01.
import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Schema, flow } from 'effect';
import { makePersistenceAttempt } from '../../src/index.ts';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;

const effectTest = <Value, Failure>(name: string, effect: Effect.Effect<Value, Failure>): void => {
  test(
    name,
    flow(() => Effect.asVoid(effect), runEffectTestPromise),
  );
};

const OwnerUnavailableSchema = Schema.TaggedStruct('OwnerUnavailable', {
  reason: Schema.Literal('unavailable'),
});
type OwnerUnavailable = typeof OwnerUnavailableSchema.Type;

const OwnerConflictSchema = Schema.TaggedStruct('OwnerConflict', {
  reason: Schema.Literal('conflict'),
});
type OwnerConflict = typeof OwnerConflictSchema.Type;

type OwnerFailure = OwnerConflict | OwnerUnavailable;

const mapOwnerFailure = (cause: unknown): OwnerFailure =>
  cause instanceof RangeError
    ? OwnerConflictSchema.make({ reason: 'conflict' })
    : OwnerUnavailableSchema.make({ reason: 'unavailable' });

void test('constructing and composing a persistence attempt does not execute its operation', () => {
  let executions = 0;
  const attempt = makePersistenceAttempt(() => ({
    _tag: 'OwnerPersistenceUnavailable' as const,
    reason: 'unavailable' as const,
  }));
  const operation = attempt(async () => {
    executions += 1;
    return 'ready' as const;
  }).pipe(Effect.map((value) => value));

  assert.equal(executions, 0);
  assert.equal(Effect.isEffect(operation), true);
});

effectTest(
  'a persistence attempt emits a successful PromiseLike value unchanged',
  Effect.gen(function* successEffect() {
    let mapperCalls = 0;
    const value = Object.freeze({ state: 'ready' as const });
    const attempt = makePersistenceAttempt(() => {
      mapperCalls += 1;
      return { _tag: 'OwnerPersistenceUnavailable' as const, reason: 'unavailable' as const };
    });

    const result = yield* attempt(async () => value);

    assert.equal(result, value);
    assert.equal(mapperCalls, 0);
  }),
);

effectTest(
  'a rejected persistence operation reaches the owner failure mapper exactly once',
  Effect.gen(function* rejectedEffect() {
    const rejection = new Error('private database diagnostic');
    let mappedCause: unknown;
    let mapperCalls = 0;
    const attempt = makePersistenceAttempt((cause) => {
      mapperCalls += 1;
      mappedCause = cause;
      return { _tag: 'OwnerPersistenceUnavailable' as const, reason: 'unavailable' as const };
    });

    const failure = yield* attempt(async () => {
      throw rejection;
    }).pipe(Effect.flip);

    assert.deepEqual(failure, {
      _tag: 'OwnerPersistenceUnavailable',
      reason: 'unavailable',
    });
    assert.equal(mappedCause, rejection);
    assert.equal(mapperCalls, 1);
  }),
);

effectTest(
  'a synchronous throw from the lazy operation follows the typed failure path',
  Effect.gen(function* synchronousThrowEffect() {
    const thrown = new Error('synchronous driver failure');
    let mappedCause: unknown;
    const attempt = makePersistenceAttempt((cause) => {
      mappedCause = cause;
      return { _tag: 'OwnerPersistenceUnavailable' as const, reason: 'unavailable' as const };
    });

    const failure = yield* attempt((): PromiseLike<never> => {
      throw thrown;
    }).pipe(Effect.flip);

    assert.deepEqual(failure, {
      _tag: 'OwnerPersistenceUnavailable',
      reason: 'unavailable',
    });
    assert.equal(mappedCause, thrown);
  }),
);

effectTest(
  'each execution invokes the operation anew and caches neither failures nor results',
  Effect.gen(function* repeatedExecutionEffect() {
    let executions = 0;
    let mapperCalls = 0;
    const attempt = makePersistenceAttempt(() => {
      mapperCalls += 1;
      return { _tag: 'OwnerPersistenceUnavailable' as const, reason: 'unavailable' as const };
    });
    const operation = attempt(async () => {
      executions += 1;
      if (executions === 1) {
        throw new Error('first attempt failed');
      }
      return executions;
    });

    yield* operation.pipe(Effect.flip);
    const firstResult = yield* operation;
    const secondResult = yield* operation;

    assert.equal(firstResult, 2);
    assert.equal(secondResult, 3);
    assert.equal(executions, 3);
    assert.equal(mapperCalls, 1);
  }),
);

effectTest(
  'the CoreSDK server export preserves exact success and owner failure types',
  Effect.gen(function* exactInferenceEffect() {
    const operation = makePersistenceAttempt(mapOwnerFailure)(
      async () => ({ count: 1, state: 'stored' }) as const,
    );
    const exactSuccess: Equal<
      Effect.Success<typeof operation>,
      Readonly<{ readonly count: 1; readonly state: 'stored' }>
    > = true;
    const exactFailure: Equal<Effect.Error<typeof operation>, OwnerFailure> = true;

    assert.equal(exactSuccess, true);
    assert.equal(exactFailure, true);
    assert.deepEqual(yield* operation, { count: 1, state: 'stored' });
  }),
);
