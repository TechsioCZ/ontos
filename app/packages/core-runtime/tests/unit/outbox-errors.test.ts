import { makeEffectTestCallback } from '@app/core-runtime/testing/effect-runtime';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import type { Cause } from 'effect';
import {
  OutboxClaimLostError,
  OutboxHandlerExecutionError,
  OutboxPayloadDecodeError,
  OutboxPersistenceError,
  OutboxPollerConfigError,
  OutboxWorkerDescriptorError,
  outboxPersistenceError,
  sanitizeOutboxErrorMessage,
} from '../../src/outbox/errors.ts';

const errorSchemas = [
  OutboxClaimLostError,
  OutboxHandlerExecutionError,
  OutboxPayloadDecodeError,
  OutboxPersistenceError,
  OutboxPollerConfigError,
  OutboxWorkerDescriptorError,
];

const checkErrorContract = <Failure extends Cause.YieldableError>(
  schema: Schema.Codec<
    Failure,
    { readonly _tag: string; readonly code: string; readonly reason: string }
  >,
  failure: Failure,
  encoded: { readonly _tag: string; readonly code: string; readonly reason: string },
): void => {
  void test(
    `${encoded._tag} preserves its schema and yieldable failure contract`,
    makeEffectTestCallback(
      Effect.gen(function* errorContract() {
        assert.ok(Schema.is(schema)(failure));
        assert.deepEqual(yield* Schema.encodeEffect(schema)(failure), encoded);
        const decoded = yield* Schema.decodeUnknownEffect(schema)(encoded);
        assert.ok(Schema.is(schema)(decoded));
        assert.deepEqual(yield* Schema.encodeEffect(schema)(decoded), encoded);
        for (const otherSchema of errorSchemas) {
          assert.equal(Schema.is(otherSchema)(failure), Object.is(otherSchema, schema));
          assert.equal(Schema.is(otherSchema)(decoded), Object.is(otherSchema, schema));
        }
        assert.throws(() => Schema.decodeUnknownSync(schema)({ ...encoded, _tag: 'WrongError' }));
        assert.throws(() => Schema.decodeUnknownSync(schema)({ ...encoded, code: 'wrong_code' }));
        assert.throws(() => Schema.decodeUnknownSync(schema)({ ...encoded, reason: 42 }));
        assert.throws(() =>
          Schema.decodeUnknownSync(schema)({ _tag: encoded._tag, code: encoded.code }),
        );
        const yielded = yield* Effect.flip(
          Effect.gen(function* yieldFailure() {
            assert.ok(Schema.is(schema)(failure));
            return yield* failure;
          }),
        );
        assert.equal(yielded, failure);
        const decodedFailure = yield* Effect.flip(
          Effect.gen(function* yieldDecodedFailure() {
            assert.ok(Schema.is(schema)(decoded));
            return yield* decoded;
          }),
        );
        assert.equal(decodedFailure, decoded);
      }),
    ),
  );
};

checkErrorContract(
  OutboxWorkerDescriptorError,
  new OutboxWorkerDescriptorError({ code: 'outbox_worker_descriptor_invalid', reason: 'detail' }),
  {
    _tag: 'OutboxWorkerDescriptorError',
    code: 'outbox_worker_descriptor_invalid',
    reason: 'detail',
  },
);
checkErrorContract(
  OutboxPayloadDecodeError,
  new OutboxPayloadDecodeError({ code: 'outbox_payload_invalid', reason: 'detail' }),
  { _tag: 'OutboxPayloadDecodeError', code: 'outbox_payload_invalid', reason: 'detail' },
);
checkErrorContract(
  OutboxPersistenceError,
  new OutboxPersistenceError({ code: 'outbox_persistence_failed', reason: 'detail' }),
  { _tag: 'OutboxPersistenceError', code: 'outbox_persistence_failed', reason: 'detail' },
);
checkErrorContract(
  OutboxClaimLostError,
  new OutboxClaimLostError({ code: 'outbox_claim_lost', reason: 'detail' }),
  { _tag: 'OutboxClaimLostError', code: 'outbox_claim_lost', reason: 'detail' },
);
checkErrorContract(
  OutboxHandlerExecutionError,
  new OutboxHandlerExecutionError({ code: 'outbox_handler_execution_failed', reason: 'detail' }),
  {
    _tag: 'OutboxHandlerExecutionError',
    code: 'outbox_handler_execution_failed',
    reason: 'detail',
  },
);
checkErrorContract(
  OutboxPollerConfigError,
  new OutboxPollerConfigError({ code: 'outbox_poller_config_invalid', reason: 'detail' }),
  { _tag: 'OutboxPollerConfigError', code: 'outbox_poller_config_invalid', reason: 'detail' },
);

void test('persistence errors keep the original cause private and immutable', () => {
  const cause = { secret: 'database credential' };
  const failure = outboxPersistenceError(cause);
  assert.ok(Schema.is(OutboxPersistenceError)(failure));
  assert.deepEqual(Object.getOwnPropertyDescriptor(failure, 'ontosOutboxPersistenceCause'), {
    configurable: false,
    enumerable: false,
    value: cause,
    writable: false,
  });
  assert.equal(
    Object.getOwnPropertyDescriptor(failure, 'ontosOutboxPersistenceCause')?.value,
    cause,
  );
  assert.equal(Object.keys(failure).includes('ontosOutboxPersistenceCause'), false);
  assert.equal(JSON.stringify(failure).includes('database credential'), false);
  const encoded = Schema.encodeSync(OutboxPersistenceError)(failure);
  assert.deepEqual(encoded, {
    _tag: 'OutboxPersistenceError',
    code: 'outbox_persistence_failed',
    reason: 'The Outbox Worker persistence operation failed',
  });
  assert.equal(
    Object.hasOwn(
      Schema.decodeUnknownSync(OutboxPersistenceError)(encoded),
      'ontosOutboxPersistenceCause',
    ),
    false,
  );
});

void test('sanitizer normalizes control whitespace, trims, truncates and falls back', () => {
  assert.equal(
    sanitizeOutboxErrorMessage(' \r\nfirst\r\n\tsecond\t third \n'),
    'first second  third',
  );
  assert.equal(sanitizeOutboxErrorMessage('  plain  detail  '), 'plain  detail');
  assert.equal(sanitizeOutboxErrorMessage(`  ${'x'.repeat(501)}  `), 'x'.repeat(500));
  assert.equal(sanitizeOutboxErrorMessage(' \r\n\t '), 'Outbox Worker processing failed');
  assert.equal(sanitizeOutboxErrorMessage(''), 'Outbox Worker processing failed');
});
