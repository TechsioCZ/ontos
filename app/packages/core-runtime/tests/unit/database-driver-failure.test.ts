import assert from 'node:assert/strict';
import test from 'node:test';
import { Option, Schema } from 'effect';
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

void test('finds sanitized PostgreSQL metadata on the root failure', () => {
  const failure = findPostgresFailure({
    code: '23505',
    constraint: 'principals_tenant_provider_subject_uk',
    detail: 'private diagnostic',
    query: 'private SQL',
  });

  const metadata = Option.getOrThrow(failure);
  assert.deepEqual(metadata, {
    code: '23505',
    constraint: 'principals_tenant_provider_subject_uk',
  });
  assert.equal(Object.isFrozen(metadata), true);
});

void test('finds PostgreSQL metadata through Error and plain-object cause wrappers', () => {
  const failure = new Error('outer wrapper', {
    cause: {
      cause: {
        cause: { code: '23505', constraint: 'principal_auth_bindings_provider_subject_uk' },
      },
    },
  });

  assert.deepEqual(Option.getOrThrow(findPostgresFailure(failure)), {
    code: '23505',
    constraint: 'principal_auth_bindings_provider_subject_uk',
  });
});

void test('ignores a non-string constraint while retaining a valid code', () => {
  assert.deepEqual(
    Option.getOrThrow(
      findPostgresFailure({ code: '23505', constraint: { private: 'diagnostic object' } }),
    ),
    { code: '23505' },
  );
});

void test('returns no PostgreSQL metadata for non-objects and unrelated objects', () => {
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
    assert.equal(Option.isNone(findPostgresFailure(failure)), true);
  }
});

void test('requires a string code and treats the string constraint as optional', () => {
  for (const failure of [{}, { code: 23_505 }, { cause: { code: false } }]) {
    assert.equal(Option.isNone(findPostgresFailure(failure)), true);
  }

  assert.deepEqual(Option.getOrThrow(findPostgresFailure({ code: '23505' })), {
    code: '23505',
  });
});

void test('returns the first recognizable PostgreSQL metadata in root-to-cause order', () => {
  assert.deepEqual(
    Option.getOrThrow(
      findPostgresFailure({
        cause: { code: '23505', constraint: 'nested_constraint' },
        code: '40001',
        constraint: 'root_constraint',
      }),
    ),
    { code: '40001', constraint: 'root_constraint' },
  );
});

void test('supports owner-local matching without changing default root precedence', () => {
  const failure = {
    cause: { code: '23505', constraint: 'owner_constraint' },
    code: 'ERR_QUERY_FAILED',
  };

  assert.deepEqual(Option.getOrThrow(findPostgresFailure(failure)), {
    code: 'ERR_QUERY_FAILED',
  });
  assert.deepEqual(
    Option.getOrThrow(
      findPostgresFailure(
        failure,
        ({ code, constraint }) => code === '23505' && constraint === 'owner_constraint',
      ),
    ),
    { code: '23505', constraint: 'owner_constraint' },
  );
});

void test('terminates on cyclic cause graphs with a first match or no match', () => {
  const matched: MutableCause & { readonly code: string } = { code: '23505' };
  matched.cause = matched;

  const first: MutableCause = {};
  const second: MutableCause = {};
  first.cause = second;
  second.cause = first;

  assert.deepEqual(Option.getOrThrow(findPostgresFailure(matched)), { code: '23505' });
  assert.equal(Option.isNone(findPostgresFailure(first)), true);
});

void test('classifies unavailable PostgreSQL SQLSTATE classes', () => {
  for (const code of ['08006', '40001', '53100', '55P03', '57P01', '58030']) {
    const decoded = decodeDatabaseDriverFailure({ code });
    assert.equal(Option.isSome(decoded), true);
    if (Option.isSome(decoded)) {
      assert.equal(decoded.value.kind, 'sqlstate');
      assert.equal(decoded.value.code, code);
      assert.equal(Schema.is(DatabaseDriverFailureSchema)(decoded.value), true);
    }
    assert.equal(isDatabaseUnavailableFailure({ code }), true);
  }
});

void test('distinguishes commit ambiguity from definite transaction failures', () => {
  const connectionFailure = decodeDatabaseDriverFailure({ code: '08006' });
  const administrativeShutdown = decodeDatabaseDriverFailure({ code: '57P01' });
  const serializationFailure = decodeDatabaseDriverFailure({ code: '40001' });

  assert.equal(
    Option.isSome(connectionFailure) && connectionFailure.value._tag,
    'DatabaseCommitAcknowledgementAmbiguous',
  );
  assert.equal(
    Option.isSome(administrativeShutdown) && administrativeShutdown.value._tag,
    'DatabaseCommitAcknowledgementAmbiguous',
  );
  assert.equal(
    Option.isSome(serializationFailure) && serializationFailure.value._tag,
    'DatabaseTransactionFailure',
  );
  assert.equal(isDatabaseCommitAcknowledgementAmbiguous({ code: '40001' }), false);
  assert.equal(isDatabaseCommitAcknowledgementAmbiguous({ code: '57014' }), false);
});

void test('classifies the exact commit-acknowledgement socket vocabulary', () => {
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
    assert.equal(isDatabaseCommitAcknowledgementAmbiguous({ code }), true);
  }

  assert.equal(isDatabaseCommitAcknowledgementAmbiguous({ code: 'ECONNREFUSED' }), false);
});

void test('preserves the auth-facing unavailable socket vocabulary', () => {
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']) {
    assert.equal(isDatabaseUnavailableFailure({ code }), true);
  }
  for (const code of ['ECONNABORTED', 'EHOSTDOWN', 'ENETRESET']) {
    assert.equal(isDatabaseUnavailableFailure({ code }), false);
  }
});

void test('classifies unavailable driver metadata found through the shared cause-chain seam', () => {
  const nestedFailure = {
    cause: { cause: { cause: { cause: { code: 'ECONNRESET' } } } },
  };

  assert.equal(isDatabaseUnavailableFailure(nestedFailure), true);
  assert.equal(isDatabaseCommitAcknowledgementAmbiguous(nestedFailure), true);
});

void test('continues past an unrelated wrapper code when classifying a nested driver failure', () => {
  const nestedFailure = {
    cause: { code: 'ECONNRESET' },
    code: 'ERR_QUERY_FAILED',
  };

  assert.equal(isDatabaseUnavailableFailure(nestedFailure), true);
  assert.equal(isDatabaseCommitAcknowledgementAmbiguous(nestedFailure), true);
});

void test('does not classify unrelated or malformed failures as unavailable', () => {
  for (const failure of [
    null,
    'ECONNRESET',
    { code: 80_006 },
    { code: '23505' },
    { code: 'ENOTFOUND' },
    { cause: { code: 'not-a-driver-code' } },
  ]) {
    assert.equal(isDatabaseUnavailableFailure(failure), false);
    assert.equal(Option.isNone(decodeDatabaseDriverFailure(failure)), true);
  }
});

void test('terminates safely when a cause chain contains a cycle', () => {
  const cyclic: MutableCause = {};
  cyclic.cause = cyclic;

  assert.equal(isDatabaseUnavailableFailure(cyclic), false);
});
