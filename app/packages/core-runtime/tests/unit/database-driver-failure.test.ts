import { expect, it } from 'effect-rstest';
import { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { Cause, Option, Schema, Predicate } from 'effect';
import { SqlError, UniqueViolation } from 'effect/unstable/sql/SqlError';

import {
  DatabaseDriverFailureSchema,
  decodeDatabaseDriverFailure,
  findPostgresFailure,
  isDatabaseCommitAcknowledgementAmbiguous,
  isDatabaseUnavailableFailure,
} from '../../src/index.ts';

interface MutableCause {
  cause?: unknown;
}

it('finds sanitized PostgreSQL metadata on the root failure', () => {
  const failure = findPostgresFailure({
    code: '23505',
    constraint: 'principals_tenant_provider_subject_uk',
    detail: 'private diagnostic',
    query: 'private SQL',
  });

  const metadata = Option.getOrThrow(failure);
  expect(metadata).toEqual({
    code: '23505',
    constraint: 'principals_tenant_provider_subject_uk',
  });
  expect(Object.isFrozen(metadata)).toBe(true);
});

it('finds PostgreSQL metadata through Error and plain-object cause wrappers', () => {
  const failure = new Error('outer wrapper', {
    cause: {
      cause: {
        cause: { code: '23505', constraint: 'principal_auth_bindings_provider_subject_uk' },
      },
    },
  });

  expect(Option.getOrThrow(findPostgresFailure(failure))).toEqual({
    code: '23505',
    constraint: 'principal_auth_bindings_provider_subject_uk',
  });
});

it('ignores a non-string constraint while retaining a valid code', () => {
  expect(
    Option.getOrThrow(
      findPostgresFailure({ code: '23505', constraint: { private: 'diagnostic object' } }),
    ),
  ).toEqual({ code: '23505' });
});

it('returns no PostgreSQL metadata for non-objects and unrelated objects', () => {
  for (const failure of [
    null,
    undefined,
    true,
    42,
    '23505',
    Symbol('failure'),
    [],
    () => ({ code: '23505' }),
    new Error('unrelated'),
  ]) {
    expect(Option.isNone(findPostgresFailure(failure))).toBe(true);
  }
});

it('requires a string code and treats the string constraint as optional', () => {
  for (const failure of [{}, { code: 23_505 }, { cause: { code: false } }]) {
    expect(Option.isNone(findPostgresFailure(failure))).toBe(true);
  }

  expect(Option.getOrThrow(findPostgresFailure({ code: '23505' }))).toEqual({
    code: '23505',
  });
});

it('returns the first recognizable PostgreSQL metadata in root-to-cause order', () => {
  expect(
    Option.getOrThrow(
      findPostgresFailure({
        cause: { code: '23505', constraint: 'nested_constraint' },
        code: '40001',
        constraint: 'root_constraint',
      }),
    ),
  ).toEqual({ code: '40001', constraint: 'root_constraint' });
});

it('supports owner-local matching without changing default root precedence', () => {
  const failure = {
    cause: { code: '23505', constraint: 'owner_constraint' },
    code: 'ERR_QUERY_FAILED',
  };

  expect(Option.getOrThrow(findPostgresFailure(failure))).toEqual({
    code: 'ERR_QUERY_FAILED',
  });
  expect(
    Option.getOrThrow(
      findPostgresFailure(
        failure,
        ({ code, constraint }) => code === '23505' && constraint === 'owner_constraint',
      ),
    ),
  ).toEqual({ code: '23505', constraint: 'owner_constraint' });
});

it('terminates on cyclic cause graphs with a first match or no match', () => {
  const matched: MutableCause & { readonly code: string } = { code: '23505' };
  matched.cause = matched;

  const first: MutableCause = {};
  const second: MutableCause = {};
  first.cause = second;
  second.cause = first;

  expect(Option.getOrThrow(findPostgresFailure(matched))).toEqual({ code: '23505' });
  expect(Option.isNone(findPostgresFailure(first))).toBe(true);
});

it('classifies unavailable PostgreSQL SQLSTATE classes', () => {
  for (const code of ['08006', '40001', '53100', '55P03', '57P01', '58030']) {
    const decoded = decodeDatabaseDriverFailure({ code });
    expect(Option.isSome(decoded)).toBe(true);
    if (Option.isSome(decoded)) {
      expect(decoded.value.kind).toBe('sqlstate');
      expect(decoded.value.code).toBe(code);
      expect(Schema.is(DatabaseDriverFailureSchema)(decoded.value)).toBe(true);
    }
    expect(isDatabaseUnavailableFailure({ code })).toBe(true);
  }
});

it('distinguishes commit ambiguity from definite transaction failures', () => {
  const connectionFailure = decodeDatabaseDriverFailure({ code: '08006' });
  const administrativeShutdown = decodeDatabaseDriverFailure({ code: '57P01' });
  const serializationFailure = decodeDatabaseDriverFailure({ code: '40001' });

  expect(
    Option.isSome(connectionFailure) &&
      Predicate.isTagged(connectionFailure.value, 'DatabaseCommitAcknowledgementAmbiguous'),
  ).toBe(true);
  expect(
    Option.isSome(administrativeShutdown) &&
      Predicate.isTagged(administrativeShutdown.value, 'DatabaseCommitAcknowledgementAmbiguous'),
  ).toBe(true);
  expect(
    Option.isSome(serializationFailure) &&
      Predicate.isTagged(serializationFailure.value, 'DatabaseTransactionFailure'),
  ).toBe(true);
  expect(isDatabaseCommitAcknowledgementAmbiguous({ code: '40001' })).toBe(false);
  expect(isDatabaseCommitAcknowledgementAmbiguous({ code: '57014' })).toBe(false);
});

it('classifies the exact commit-acknowledgement socket vocabulary', () => {
  const commitCodes = [
    'ECONNABORTED',
    'ECONNRESET',
    'EHOSTDOWN',
    'EHOSTUNREACH',
    'ENETDOWN',
    'ENETRESET',
    'ENETUNREACH',
    'EPIPE',
    'ETIMEDOUT',
  ];
  for (const code of commitCodes) {
    expect(isDatabaseCommitAcknowledgementAmbiguous({ code })).toBe(true);
  }

  expect(isDatabaseCommitAcknowledgementAmbiguous({ code: 'ECONNREFUSED' })).toBe(false);
});

it('preserves the auth-facing unavailable socket vocabulary', () => {
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']) {
    expect(isDatabaseUnavailableFailure({ code })).toBe(true);
  }
  for (const code of ['ECONNABORTED', 'EHOSTDOWN', 'ENETRESET']) {
    expect(isDatabaseUnavailableFailure({ code })).toBe(false);
  }
});

it('classifies unavailable driver metadata found through the shared cause-chain seam', () => {
  const nestedFailure = {
    cause: { cause: { cause: { cause: { code: 'ECONNRESET' } } } },
  };

  expect(isDatabaseUnavailableFailure(nestedFailure)).toBe(true);
  expect(isDatabaseCommitAcknowledgementAmbiguous(nestedFailure)).toBe(true);
});

it('continues past an unrelated wrapper code when classifying a nested driver failure', () => {
  const nestedFailure = {
    cause: { code: 'ECONNRESET' },
    code: 'ERR_QUERY_FAILED',
  };

  expect(isDatabaseUnavailableFailure(nestedFailure)).toBe(true);
  expect(isDatabaseCommitAcknowledgementAmbiguous(nestedFailure)).toBe(true);
});

it('does not classify unrelated or malformed failures as unavailable', () => {
  for (const failure of [
    null,
    'ECONNRESET',
    { code: 80_006 },
    { code: '23505' },
    { code: 'ENOTFOUND' },
    { cause: { code: 'not-a-driver-code' } },
  ]) {
    expect(isDatabaseUnavailableFailure(failure)).toBe(false);
    expect(Option.isNone(decodeDatabaseDriverFailure(failure))).toBe(true);
  }
});

it('terminates safely when a cause chain contains a cycle', () => {
  const cyclic: MutableCause = {};
  cyclic.cause = cyclic;

  expect(isDatabaseUnavailableFailure(cyclic)).toBe(false);
});

it('decodes native Drizzle and Effect SQL causes without exposing query data', () => {
  const constraint = 'principal_auth_bindings_provider_subject_uk';
  const driver = { code: '23505', constraint, detail: 'private detail' };
  const sqlError = new SqlError({ reason: new UniqueViolation({ cause: driver, constraint }) });
  const failure = new EffectDrizzleQueryError({
    cause: Cause.fail(sqlError),
    params: ['private parameter'],
    query: 'private SQL',
  });
  expect(Option.getOrThrow(findPostgresFailure(failure))).toEqual({ code: '23505', constraint });
  expect(Option.getOrThrow(findPostgresFailure(Cause.die(sqlError)))).toEqual({
    code: '23505',
    constraint,
  });
});

it('walks native mixed Causes in order and skips unrelated failures', () => {
  const failure = Cause.combine(
    Cause.fail({ code: '40001' }),
    Cause.die({ code: '23505', constraint: 'owned_unique' }),
  );
  expect(Option.getOrThrow(findPostgresFailure(failure, ({ code }) => code === '23505'))).toEqual({
    code: '23505',
    constraint: 'owned_unique',
  });
});
