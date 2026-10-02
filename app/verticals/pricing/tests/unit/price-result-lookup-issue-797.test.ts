import { ReadHandlerUnavailable } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PriceResultLookupRequestSchema,
  PriceResultLookupResponseSchema,
} from '../../shared/apis/price-result-lookup.ts';
import { readPriceResult } from '../../src/api/price-result-lookup.read.ts';
import { PricePersistenceUnavailable } from '../../src/services/price-persistence.service.ts';

const actionInvocationId = '33333333-3333-4333-8333-333333333333';
const input = Schema.decodeSync(PriceResultLookupRequestSchema)({ actionInvocationId });
const legalEntityId = '22222222-2222-4222-8222-222222222222';

describe('Price governed result lookup issue #797', () => {
  it.effect('returns typed original owner result and typed absence', () =>
    Effect.gen(function* returnsResult() {
      const found = {
        actionInvocationId,
        outcome: 'PRICE_ACTION_RESULT_FOUND' as const,
        result: { outcome: 'CONFLICT' as const, reason: 'EXPECTED_CURRENT_MISMATCH' as const },
      };
      const absent = { actionInvocationId, outcome: 'PRICE_ACTION_RESULT_ABSENT' as const };
      const foundResult = yield* readPriceResult(
        input,
        { legalEntityId },
        { lookupResult: () => Effect.succeed(found), resolveCommit: () => Effect.succeed('COMMITTED' as const) },
      );
      const absentResult = yield* readPriceResult(
        input,
        { legalEntityId },
        { lookupResult: () => Effect.succeed(absent), resolveCommit: () => Effect.succeed('OPEN' as const) },
      );
      expect(foundResult).toEqual(found);
      expect(absentResult).toEqual(absent);
      expect(Schema.is(PriceResultLookupResponseSchema)(foundResult)).toBe(true);
      expect(Schema.is(PriceResultLookupResponseSchema)(absentResult)).toBe(true);
    }),
  );

  it.effect('preserves owner persistence failure and does not read without trusted Legal Entity scope', () =>
    Effect.gen(function* unavailableOrMissingScope() {
      let reads = 0;
      const services = {
        lookupResult: () => {
          reads += 1;
          return Effect.fail(new PricePersistenceUnavailable({ reason: 'Unavailable owner storage' }));
        },
        resolveCommit: () => Effect.succeed('COMMITTED' as const),
      };
      const missingScope = yield* readPriceResult(input, { legalEntityId: null }, services);
      expect(missingScope).toEqual({
        actionInvocationId,
        outcome: 'PRICE_ACTION_RESULT_UNAVAILABLE',
        retryable: true,
      });
      const failure = yield* readPriceResult(input, { legalEntityId }, services).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(ReadHandlerUnavailable);
      expect(failure.cause).toBeInstanceOf(PricePersistenceUnavailable);
      expect(reads).toBe(1);
    }),
  );

  it.effect('allows retry only after Core and owner persistence both prove the invocation open or absent', () =>
    Effect.gen(function* conditionalRetry() {
      const absent = { actionInvocationId, outcome: 'PRICE_ACTION_RESULT_ABSENT' as const };
      const foundDefine = {
        actionInvocationId,
        outcome: 'PRICE_ACTION_RESULT_FOUND' as const,
        result: { outcome: 'EFFECTIVE_TIME_INVALID' as const },
      };
      const foundRevise = {
        actionInvocationId,
        outcome: 'PRICE_ACTION_RESULT_FOUND' as const,
        result: { outcome: 'ABSENT' as const },
      };

      for (const found of [foundDefine, foundRevise]) {
        expect(
          yield* readPriceResult(
            input,
            { legalEntityId },
            {
              lookupResult: () => Effect.succeed(found),
              resolveCommit: () => Effect.succeed('COMMITTED' as const),
            },
          ),
        ).toEqual(found);

        expect(
          yield* readPriceResult(
            input,
            { legalEntityId },
            {
              lookupResult: () => Effect.succeed(found),
              resolveCommit: () => Effect.succeed('OPEN' as const),
            },
          ),
        ).toEqual({ actionInvocationId, outcome: 'PRICE_ACTION_RESULT_UNAVAILABLE', retryable: true });
      }

      for (const resolution of ['OPEN', 'ABSENT'] as const) {
        expect(
          yield* readPriceResult(
            input,
            { legalEntityId },
            {
              lookupResult: () => Effect.succeed(absent),
              resolveCommit: () => Effect.succeed(resolution),
            },
          ),
        ).toEqual(absent);
      }

      let reads = 0;
      expect(
        yield* readPriceResult(
          input,
          { legalEntityId },
          {
            lookupResult: () => {
              reads += 1;
              return Effect.succeed(absent);
            },
            resolveCommit: () => Effect.succeed('UNAVAILABLE' as const),
          },
        ),
      ).toEqual({ actionInvocationId, outcome: 'PRICE_ACTION_RESULT_UNAVAILABLE', retryable: true });
      expect(reads).toBe(0);
    }),
  );
});
