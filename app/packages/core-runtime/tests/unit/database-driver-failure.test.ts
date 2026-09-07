import assert from 'node:assert/strict';
import test from 'node:test';
import { Option, Schema } from 'effect';
import {
  DatabaseDriverFailureSchema,
  decodeDatabaseDriverFailure,
  isDatabaseCommitAcknowledgementAmbiguous,
  isDatabaseUnavailableFailure,
} from '../../src/database/driver-failure.ts';

interface MutableCause {
  cause?: unknown;
}

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

void test('finds unavailable driver failures through at most three nested causes', () => {
  const withinBound = {
    cause: { cause: { cause: { code: 'ECONNRESET' } } },
  };
  const beyondBound = {
    cause: { cause: { cause: { cause: { code: 'ECONNRESET' } } } },
  };

  assert.equal(isDatabaseUnavailableFailure(withinBound), true);
  assert.equal(isDatabaseUnavailableFailure(beyondBound), false);
  assert.equal(isDatabaseCommitAcknowledgementAmbiguous(withinBound), true);
  assert.equal(isDatabaseCommitAcknowledgementAmbiguous(beyondBound), false);
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
