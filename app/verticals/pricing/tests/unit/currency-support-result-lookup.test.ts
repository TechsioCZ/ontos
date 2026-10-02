import { PersistenceFailure, ReadHandlerUnavailable } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CurrencySupportResultLookupRequestSchema,
  CurrencySupportResultLookupResponseSchema,
} from '../../shared/apis/currency-support-result-lookup.ts';
import { readCurrencySupportResult } from '../../src/api/currency-support-result-lookup.read.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const actionInvocationId = '33333333-3333-4333-8333-333333333333';
const request = Schema.decodeSync(CurrencySupportResultLookupRequestSchema)({ actionInvocationId });
const result = Schema.decodeSync(CurrencySupportResultLookupResponseSchema)({
  actionInvocationId,
  mutationOutcome: 'CREATED',
  outcome: 'CURRENCY_SUPPORT_RESULT_FOUND',
  result: {
    changed: true,
    current: {
      effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
      generation: 1,
      supportedCurrencies: ['CZK'],
      supportRevisionRef: {
        moduleId: 'commerce.pricing',
        resourceId: '55555555-5555-4555-8555-555555555555',
        resourceType: 'commerce.pricing.currency-support-revision',
        supportRootId: '44444444-4444-4444-8444-444444444444',
        tenantId,
      },
    },
    scheduleRevision: 1,
    supportRootRef: {
      moduleId: 'commerce.pricing',
      resourceId: '44444444-4444-4444-8444-444444444444',
      resourceType: 'commerce.pricing.currency-support',
      tenantId,
    },
  },
});

describe('Currency Support result lookup', () => {
  it.effect('binds lookup to trusted Principal and returns the recorded result', () =>
    Effect.gen(function* foundResult() {
      const observed: unknown[] = [];
      const response = yield* readCurrencySupportResult(
        request,
        { principalId },
        {
          lookupResult: (query) => {
            observed.push(query);
            if (result.outcome !== 'CURRENCY_SUPPORT_RESULT_FOUND') {
              return Effect.die('invalid fixture');
            }
            return Effect.succeed({
              outcome: 'FOUND' as const,
              result: { outcome: result.mutationOutcome, result: result.result },
            });
          },
        },
      );
      expect(observed).toEqual([{ actingPrincipalId: principalId, actionInvocationId }]);
      expect(response).toEqual(result);
    }),
  );

  it.effect('keeps missing receipt unknown and preserves owner persistence failure', () =>
    Effect.gen(function* unresolvedResult() {
      const unknown = yield* readCurrencySupportResult(
        request,
        { principalId },
        {
          lookupResult: () => Effect.succeed({ outcome: 'UNKNOWN' as const }),
        },
      );
      expect(unknown).toEqual({ actionInvocationId, outcome: 'CURRENCY_SUPPORT_RESULT_UNKNOWN' });
      const failure = yield* readCurrencySupportResult(
        request,
        { principalId },
        {
          lookupResult: () =>
            Effect.fail(new PersistenceFailure({ cause: 'fixture driver failure', reason: 'storage unavailable' })),
        },
      ).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(ReadHandlerUnavailable);
      expect(failure.cause).toBeInstanceOf(PersistenceFailure);
    }),
  );
});
