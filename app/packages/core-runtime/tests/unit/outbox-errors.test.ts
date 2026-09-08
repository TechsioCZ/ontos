import { expect, it } from 'effect-rstest';
import { Effect, Predicate, Schema, Struct } from 'effect';
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
  it.effect(`${encoded._tag} preserves its schema and yieldable failure contract`, () =>
    Effect.gen(function* errorContract() {
      expect(Schema.is(schema)(failure)).toBeTruthy();
      expect(yield* Schema.encodeEffect(schema)(failure)).toEqual(encoded);
      const decoded = yield* Schema.decodeUnknownEffect(schema)(encoded);
      expect(Schema.is(schema)(decoded)).toBeTruthy();
      expect(yield* Schema.encodeEffect(schema)(decoded)).toEqual(encoded);
      for (const otherSchema of errorSchemas) {
        expect(Schema.is(otherSchema)(failure)).toBe(Object.is(otherSchema, schema));
        expect(Schema.is(otherSchema)(decoded)).toBe(Object.is(otherSchema, schema));
      }
      expect(() => Schema.decodeUnknownSync(schema)({ ...encoded, _tag: 'WrongError' })).toThrow();
      expect(() => Schema.decodeUnknownSync(schema)({ ...encoded, code: 'wrong_code' })).toThrow();
      expect(() => Schema.decodeUnknownSync(schema)({ ...encoded, reason: 42 })).toThrow();
      expect(() =>
        Schema.decodeUnknownSync(schema)({ _tag: encoded._tag, code: encoded.code }),
      ).toThrow();
      const yielded = yield* Effect.flip(
        Effect.gen(function* yieldFailure() {
          expect(Schema.is(schema)(failure)).toBeTruthy();
          return yield* failure;
        }),
      );
      expect(yielded).toBe(failure);
      const decodedFailure = yield* Effect.flip(
        Effect.gen(function* yieldDecodedFailure() {
          expect(Schema.is(schema)(decoded)).toBeTruthy();
          return yield* decoded;
        }),
      );
      expect(decodedFailure).toBe(decoded);
    }),
  );
};

checkErrorContract(
  OutboxWorkerDescriptorError,
  new OutboxWorkerDescriptorError({
    code: 'outbox_worker_descriptor_invalid',
    reason: 'detail',
  }),
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
  new OutboxHandlerExecutionError({
    code: 'outbox_handler_execution_failed',
    reason: 'detail',
  }),
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

it('persistence errors keep the original cause private and immutable', () => {
  const cause = { secret: 'database credential' };
  const failure = outboxPersistenceError(cause);
  expect(Schema.is(OutboxPersistenceError)(failure)).toBeTruthy();
  expect(Object.getOwnPropertyDescriptor(failure, 'ontosOutboxPersistenceCause')).toEqual({
    configurable: false,
    enumerable: false,
    value: cause,
    writable: false,
  });
  expect(Object.getOwnPropertyDescriptor(failure, 'ontosOutboxPersistenceCause')?.value).toBe(
    cause,
  );
  expect(Object.keys(failure).includes('ontosOutboxPersistenceCause')).toBe(false);
  expect(JSON.stringify(failure).includes('database credential')).toBe(false);
  const encoded = Schema.encodeSync(OutboxPersistenceError)(failure);
  expect(Predicate.isTagged(encoded, 'OutboxPersistenceError')).toBe(true);
  expect(Struct.omit(encoded, ['_tag'])).toEqual({
    code: 'outbox_persistence_failed',
    reason: 'The Outbox Worker persistence operation failed',
  });
  expect(
    Object.hasOwn(
      Schema.decodeUnknownSync(OutboxPersistenceError)(encoded),
      'ontosOutboxPersistenceCause',
    ),
  ).toBe(false);
});

it('sanitizer normalizes control whitespace, trims, truncates and falls back', () => {
  expect(sanitizeOutboxErrorMessage(' \r\nfirst\r\n\tsecond\t third \n')).toBe(
    'first second  third',
  );
  expect(sanitizeOutboxErrorMessage('  plain  detail  ')).toBe('plain  detail');
  expect(sanitizeOutboxErrorMessage(`  ${'x'.repeat(501)}  `)).toBe('x'.repeat(500));
  expect(sanitizeOutboxErrorMessage(' \r\n\t ')).toBe('Outbox Worker processing failed');
  expect(sanitizeOutboxErrorMessage('')).toBe('Outbox Worker processing failed');
});
