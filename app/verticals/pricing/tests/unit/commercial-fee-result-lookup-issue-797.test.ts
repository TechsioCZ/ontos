import { ReadHandlerUnavailable } from '@app/core-runtime';
import { PricingCommercialFeeIdentityKeySchema } from '@app/pricing-contracts/domain/commercial-fee';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CommercialFeeResultLookupRequestSchema,
  CommercialFeeResultLookupResponseSchema,
} from '../../shared/apis/commercial-fee-result-lookup.ts';
import { readCommercialFeeResult } from '../../src/api/commercial-fee-result-lookup.read.ts';
import { CommercialFeePersistenceUnavailable } from '../../src/services/commercial-fee-persistence.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const actionInvocationId = '33333333-3333-4333-8333-333333333333';
const input = Schema.decodeSync(CommercialFeeResultLookupRequestSchema)({ actionInvocationId });
const identityKey = Schema.decodeSync(PricingCommercialFeeIdentityKeySchema)({
  calculationBasis: { kind: 'FIXED_PER_LINE' },
  commercialScope: { channelId: 'B2C', marketId: 'cz-launch', sellingLegalEntityId: legalEntityId },
  currencyCode: 'CZK',
  family: 'RECYCLING_FEE',
  monetaryBoundary: 'PRE_TAX',
  target: {
    variantRef: {
      moduleId: 'commerce.catalog',
      resourceId: '44444444-4444-4444-8444-444444444444',
      resourceType: 'commerce.catalog.variant',
      tenantId,
    },
  },
});

describe('Commercial Fee governed result lookup issue #797', () => {
  it('accepts only an invocation identifier as public business input', () => {
    expect(Object.keys(CommercialFeeResultLookupRequestSchema.fields)).toEqual(['actionInvocationId']);
    expect(Schema.is(CommercialFeeResultLookupRequestSchema)({ actionInvocationId })).toBe(true);
    expect(Schema.is(CommercialFeeResultLookupRequestSchema)({ actionInvocationId: 'invalid' })).toBe(false);
  });

  it.effect('returns the exact typed owner result or an authoritative absence', () =>
    Effect.gen(function* lookupCommittedResult() {
      const found = {
        actionInvocationId,
        outcome: 'COMMERCIAL_FEE_ACTION_RESULT_FOUND' as const,
        result: { identityKey, outcome: 'COMMERCIAL_FEE_CONFLICT' as const, reason: 'EXPECTED_CURRENT_STALE' as const },
      };
      const absent = { actionInvocationId, outcome: 'COMMERCIAL_FEE_ACTION_RESULT_ABSENT' as const };
      const foundResult = yield* readCommercialFeeResult(
        input,
        { legalEntityId },
        {
          lookupResult: () => Effect.succeed(found),
        },
      );
      const absentResult = yield* readCommercialFeeResult(
        input,
        { legalEntityId },
        {
          lookupResult: () => Effect.succeed(absent),
        },
      );
      expect(foundResult).toEqual(found);
      expect(absentResult).toEqual(absent);
      expect(Schema.is(CommercialFeeResultLookupResponseSchema)(foundResult)).toBe(true);
      expect(Schema.is(CommercialFeeResultLookupResponseSchema)(absentResult)).toBe(true);
    }),
  );

  it.effect('preserves owner persistence failure and does not read without trusted Legal Entity scope', () =>
    Effect.gen(function* unavailableOrMissingScope() {
      let reads = 0;
      const services = {
        lookupResult: () => {
          reads += 1;
          return Effect.fail(new CommercialFeePersistenceUnavailable({ reason: 'Unavailable owner storage' }));
        },
      };
      const missingScope = yield* readCommercialFeeResult(input, { legalEntityId: null }, services);
      expect(missingScope).toEqual({
        actionInvocationId,
        outcome: 'COMMERCIAL_FEE_ACTION_RESULT_UNAVAILABLE',
        retryable: true,
      });
      const failure = yield* readCommercialFeeResult(input, { legalEntityId }, services).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(ReadHandlerUnavailable);
      expect(failure.cause).toBeInstanceOf(CommercialFeePersistenceUnavailable);
      expect(reads).toBe(1);
    }),
  );
});
