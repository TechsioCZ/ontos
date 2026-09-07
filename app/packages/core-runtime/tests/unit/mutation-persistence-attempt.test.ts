import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
// @effect-diagnostics asyncFunction:off -- Node's test runner owns the Promise boundary; expires: 2026-12-31.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { makeMutationPersistenceAttempt } from '../../src/index.ts';

const FirstConflictSchema = Schema.TaggedStruct('FirstConflict', { constraint: Schema.String });
type FirstConflict = typeof FirstConflictSchema.Type;
const SecondConflictSchema = Schema.TaggedStruct('SecondConflict', { code: Schema.String });
type SecondConflict = typeof SecondConflictSchema.Type;
const PersistenceUnavailableSchema = Schema.TaggedStruct('PersistenceUnavailable', {
  cause: Schema.Unknown,
});
type PersistenceUnavailable = typeof PersistenceUnavailableSchema.Type;

const firstConflict = (constraint: string): FirstConflict =>
  FirstConflictSchema.make({ constraint });
const secondConflict = (code: string): SecondConflict => SecondConflictSchema.make({ code });
const persistenceUnavailable = (cause: unknown): PersistenceUnavailable =>
  PersistenceUnavailableSchema.make({ cause });

const postgresError = (
  code: string,
  options: {
    readonly cause?: Error;
    readonly constraint?: string;
    readonly detail?: string;
    readonly query?: string;
  } = {},
): Error => {
  const error = new Error(code, options.cause === undefined ? undefined : { cause: options.cause });
  Object.defineProperty(error, 'code', { value: code });
  for (const [key, value] of Object.entries(options)) {
    if (key !== 'cause' && value !== undefined) {
      Object.defineProperty(error, key, { value });
    }
  }
  return error;
};

const makeAttempt = (calls?: { readonly first: () => void; readonly second: () => void }) =>
  makeMutationPersistenceAttempt({
    fallback: persistenceUnavailable,
    rules: [
      {
        makeFailure: (failure) => {
          calls?.first();
          return firstConflict(failure.constraint ?? 'missing');
        },
        matches: (failure) => failure.code === '23505' && failure.constraint === 'owner_exact_uk',
      },
      {
        makeFailure: (failure) => {
          calls?.second();
          return secondConflict(failure.code);
        },
        matches: (failure) => failure.code === '23505',
      },
    ] as const,
  });

test('returns a successful operation value without evaluating classification or fallback', async () => {
  let classified = 0;
  let fallbackCalls = 0;
  const attempt = makeMutationPersistenceAttempt({
    fallback: (cause): PersistenceUnavailable => {
      fallbackCalls += 1;
      return persistenceUnavailable(cause);
    },
    rules: [
      {
        makeFailure: () => {
          classified += 1;
          return firstConflict('owner_exact_uk');
        },
        matches: () => {
          classified += 1;
          return true;
        },
      },
    ] as const,
  });

  const value = { persisted: true } as const;
  assert.equal(await runEffectTestPromise(attempt(async () => value)), value);
  assert.equal(classified, 0);
  assert.equal(fallbackCalls, 0);
});

test('uses the first matching owner rule and leaves later factories unevaluated', async () => {
  let firstCalls = 0;
  let secondCalls = 0;
  const attempt = makeAttempt({
    first: () => {
      firstCalls += 1;
    },
    second: () => {
      secondCalls += 1;
    },
  });

  const failure = await runEffectTestPromise(
    attempt(async () => {
      throw postgresError('23505', { constraint: 'owner_exact_uk' });
    }).pipe(Effect.flip),
  );

  assert.deepEqual(failure, firstConflict('owner_exact_uk'));
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 0);
});

test('does not evaluate the factory of an unmatched owner rule', async () => {
  let unmatchedFactoryCalls = 0;
  let matchedFactoryCalls = 0;
  const attempt = makeMutationPersistenceAttempt({
    fallback: persistenceUnavailable,
    rules: [
      {
        makeFailure: () => {
          unmatchedFactoryCalls += 1;
          return firstConflict('unmatched');
        },
        matches: (failure) => failure.code === '23503',
      },
      {
        makeFailure: (failure) => {
          matchedFactoryCalls += 1;
          return secondConflict(failure.code);
        },
        matches: (failure) => failure.code === '23505',
      },
    ] as const,
  });

  const failure = await runEffectTestPromise(
    attempt(async () => {
      throw postgresError('23505', { constraint: 'owner_exact_uk' });
    }).pipe(Effect.flip),
  );

  assert.deepEqual(failure, secondConflict('23505'));
  assert.equal(unmatchedFactoryCalls, 0);
  assert.equal(matchedFactoryCalls, 1);
});

test('gives an earlier rule precedence across the sanitized cause chain', async () => {
  const attempt = makeMutationPersistenceAttempt({
    fallback: persistenceUnavailable,
    rules: [
      {
        makeFailure: (failure) => firstConflict(failure.constraint ?? 'missing'),
        matches: (failure) => failure.code === '23505',
      },
      {
        makeFailure: (failure) => secondConflict(failure.code),
        matches: (failure) => failure.code === 'ERR_QUERY_FAILED',
      },
    ] as const,
  });
  const failure = await runEffectTestPromise(
    attempt(async () => {
      throw postgresError('ERR_QUERY_FAILED', {
        cause: postgresError('23505', { constraint: 'owner_exact_uk' }),
      });
    }).pipe(Effect.flip),
  );

  assert.deepEqual(failure, firstConflict('owner_exact_uk'));
});

test('passes only sanitized PostgreSQL metadata to matching rules', async () => {
  let observed: unknown;
  const attempt = makeMutationPersistenceAttempt({
    fallback: persistenceUnavailable,
    rules: [
      {
        makeFailure: () => firstConflict('owner_exact_uk'),
        matches: (failure) => {
          observed = failure;
          return true;
        },
      },
    ] as const,
  });

  await runEffectTestPromise(
    attempt(async () => {
      throw postgresError('23505', {
        constraint: 'owner_exact_uk',
        detail: 'private database detail',
        query: 'private query',
      });
    }).pipe(Effect.flip),
  );

  assert.deepEqual(observed, { code: '23505', constraint: 'owner_exact_uk' });
});

test('uses the required fallback for unrelated PostgreSQL and non-PostgreSQL failures', async () => {
  const attempt = makeAttempt();
  const unrelatedPostgres = postgresError('23503', {
    constraint: 'owner_foreign_key',
  });
  const nonPostgres = new Error('connection failed');

  const unrelatedFailure = await runEffectTestPromise(
    attempt(async () => {
      throw unrelatedPostgres;
    }).pipe(Effect.flip),
  );
  const nonPostgresFailure = await runEffectTestPromise(
    attempt(async () => {
      throw nonPostgres;
    }).pipe(Effect.flip),
  );

  assert.deepEqual(unrelatedFailure, persistenceUnavailable(unrelatedPostgres));
  assert.deepEqual(nonPostgresFailure, persistenceUnavailable(nonPostgres));
});

test('preserves the inferred success, classified-failure union, and fallback-failure types', () => {
  const attempt = makeAttempt();
  const inferred = attempt(async () => 42 as const);
  type Expected = Effect.Effect<42, FirstConflict | PersistenceUnavailable | SecondConflict>;
  type Equal<Left, Right> =
    (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
      ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
        ? true
        : false
      : false;

  const exactInference: Equal<typeof inferred, Expected> = true;
  assert.equal(exactInference, true);
});
