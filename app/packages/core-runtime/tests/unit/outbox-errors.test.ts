import { NodeCrypto } from '@effect/platform-node';
import { Cause, Crypto, DateTime, Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';

import {
  OutboxClaimLostError,
  OutboxHandlerExecutionError,
  OutboxPayloadDecodeError,
  OutboxPollerConfigError,
  OutboxWorkerDescriptorError,
  sanitizeOutboxErrorMessage,
} from '../../src/outbox/errors.ts';
import { PersistenceFailure } from '../../src/database/persistence-failure.ts';
import { makeOutboxRepository } from '../../src/outbox/repository.ts';
import { makeTestDatabase } from '../support/database.ts';

const errorSchemas = [
  OutboxClaimLostError,
  OutboxHandlerExecutionError,
  OutboxPayloadDecodeError,
  OutboxPollerConfigError,
  OutboxWorkerDescriptorError,
];

const checkErrorContract = <Failure extends Cause.YieldableError>(
  schema: Schema.Codec<Failure, { readonly _tag: string; readonly code: string; readonly reason: string }>,
  failure: Failure,
  encoded: {
    readonly _tag: string;
    readonly code: string;
    readonly reason: string;
  },
): void => {
  it.effect(`${encoded._tag} preserves its schema and yieldable failure contract`, () =>
    Effect.gen(function* errorContract() {
      expect(Schema.is(schema)(failure)).toBeTruthy();
      expect(yield* Schema.encodeEffect(schema)(failure)).toEqual(encoded);
      const decoded = yield* Schema.decodeEffect(schema)(encoded);
      expect(Schema.is(schema)(decoded)).toBeTruthy();
      expect(yield* Schema.encodeEffect(schema)(decoded)).toEqual(encoded);
      for (const otherSchema of errorSchemas) {
        expect(Schema.is(otherSchema)(failure)).toBe(Object.is(otherSchema, schema));
        expect(Schema.is(otherSchema)(decoded)).toBe(Object.is(otherSchema, schema));
      }
      expect(() => Schema.decodeSync(schema)({ ...encoded, _tag: 'WrongError' })).toThrow();
      expect(() => Schema.decodeSync(schema)({ ...encoded, code: 'wrong_code' })).toThrow();
      expect(() => Schema.decodeUnknownSync(schema)({ ...encoded, reason: 42 })).toThrow();
      expect(() =>
        Schema.decodeUnknownSync(schema)({
          _tag: encoded._tag,
          code: encoded.code,
        }),
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
  new OutboxPayloadDecodeError({
    code: 'outbox_payload_invalid',
    reason: 'detail',
  }),
  {
    _tag: 'OutboxPayloadDecodeError',
    code: 'outbox_payload_invalid',
    reason: 'detail',
  },
);
checkErrorContract(OutboxClaimLostError, new OutboxClaimLostError({ code: 'outbox_claim_lost', reason: 'detail' }), {
  _tag: 'OutboxClaimLostError',
  code: 'outbox_claim_lost',
  reason: 'detail',
});
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
  new OutboxPollerConfigError({
    code: 'outbox_poller_config_invalid',
    reason: 'detail',
  }),
  {
    _tag: 'OutboxPollerConfigError',
    code: 'outbox_poller_config_invalid',
    reason: 'detail',
  },
);

it.layer(NodeCrypto.layer)('outbox repository failures', (suite) => {
  suite.effect('BEGIN failure preserves the native driver cause without observing authority or owner data', () =>
    Effect.gen(function* persistenceFailureCarriesCause() {
      const driverError = new SqlError({
        reason: new ConnectionError({ cause: new Error('private repository defect') }),
      });
      const statements: string[] = [];
      const executor = yield* makeTestDatabase((statement) => {
        statements.push(statement);
        return Effect.fail(driverError);
      });
      const failure = yield* makeOutboxRepository(executor, yield* Crypto.Crypto)
        .matchUnmatched('a'.repeat(64), DateTime.toDateUtc(DateTime.makeUnsafe('2026-08-03T10:00:00Z')))
        .pipe(Effect.flip);
      expect(failure).toBeInstanceOf(PersistenceFailure);
      expect(failure.reason).toBe('The Outbox Worker persistence operation failed');
      expect(failure.cause).toBe(driverError);
      expect(statements).toEqual(['BEGIN']);
    }),
  );

  suite.effect('fenced owner-query failure retains the Drizzle wrapper and exact native driver cause', () =>
    Effect.gen(function* fencedPersistenceFailureCarriesCause() {
      const driverError = new SqlError({
        reason: new ConnectionError({ cause: new Error('private owner query detail') }),
      });
      const statements: string[] = [];
      const executor = yield* makeTestDatabase((statement) => {
        statements.push(statement);
        if (statement.includes('from "core"."outbox_messages"')) {
          return Effect.fail(driverError);
        }
        if (statement.includes('from "core"."application_composition_authority"')) {
          return Effect.succeed([
            { phase: 'active', revision: 'a'.repeat(64), subscriptionsJson: [], unexpired: true },
          ]);
        }
        return Effect.succeed([{ isolation: 'read committed' }]);
      });
      const failure = yield* makeOutboxRepository(executor, yield* Crypto.Crypto)
        .matchUnmatched('a'.repeat(64), DateTime.toDateUtc(DateTime.makeUnsafe('2026-08-03T10:00:00Z')))
        .pipe(Effect.flip);
      expect(failure).toBeInstanceOf(PersistenceFailure);
      expect(failure.reason).toBe('The Outbox Worker persistence operation failed');
      expect(Predicate.isTagged(failure.cause, 'EffectDrizzleQueryError')).toBe(true);
      if (!Predicate.hasProperty(failure.cause, 'cause') || !Cause.isCause(failure.cause.cause)) {
        expect.unreachable('The Drizzle query failure must retain the native Effect cause');
      }
      const { reasons } = failure.cause.cause;
      expect(reasons).toHaveLength(1);
      const [reason] = reasons;
      if (reason === undefined || !Cause.isFailReason(reason)) {
        expect.unreachable('The query cause must contain the original typed SQL failure');
      }
      expect(reason.error).toBe(driverError);
      expect(statements).toHaveLength(5);
      expect(statements[0]).toBe('BEGIN');
      expect(statements[1]).toContain('pg_advisory_xact_lock_shared');
      expect(statements[1]).toContain("current_setting('transaction_isolation')");
      expect(statements[2]).toContain('from "core"."application_composition_authority"');
      expect(statements[3]).toContain('from "core"."outbox_messages"');
      expect(statements[4]).toBe('ROLLBACK');
    }),
  );
});

it('sanitizer normalizes control whitespace, trims, truncates and falls back', () => {
  expect(sanitizeOutboxErrorMessage(' \r\nfirst\r\n\tsecond\t third \n')).toBe('first second  third');
  expect(sanitizeOutboxErrorMessage('  plain  detail  ')).toBe('plain  detail');
  expect(sanitizeOutboxErrorMessage(`  ${'x'.repeat(501)}  `)).toBe('x'.repeat(500));
  expect(sanitizeOutboxErrorMessage(' \r\n\t ')).toBe('Outbox Worker processing failed');
  expect(sanitizeOutboxErrorMessage('')).toBe('Outbox Worker processing failed');
});
